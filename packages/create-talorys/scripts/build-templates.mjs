// Builds the deployable artifacts shipped inside the npm package:
//   templates/worker.js              prebundled Talorys Worker (API + agent Durable Object)
//   templates/public/**              static frontend, served by the same Worker as static assets
//   templates/version.json
// The owner's machine therefore needs no build toolchain: only the bundled Wrangler.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(pkgDir, "..", "..");
const out = join(pkgDir, "templates");
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const constants = readFileSync(join(root, "packages/shared/src/constants.ts"), "utf8");
const appVersion = constants.match(/TALORYS_VERSION = "([^"]+)"/)?.[1];
if (appVersion !== pkg.version) {
  throw new Error(`Version mismatch: create-talorys ${pkg.version} vs TALORYS_VERSION ${appVersion}`);
}

const run = (cmd, args, cwd = root, shell = false) =>
  execFileSync(cmd, args, { cwd, stdio: "inherit", shell, env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
// Windows refuses to spawn npm.cmd without a shell (Node's CVE-2024-27980 fix): run npm's JS entry with node instead.
const npm = (args) =>
  process.env.npm_execpath ? run(process.execPath, [process.env.npm_execpath, ...args]) : run("npm", args, root, process.platform === "win32");

console.log("• Building frontend");
npm(["run", "build", "-w", "@talorys/web"]);

console.log("• Bundling agent Worker");
const bundleDir = mkdtempSync(join(tmpdir(), "talorys-agent-"));
run(process.execPath, [join(root, "node_modules/wrangler/bin/wrangler.js"), "deploy", "--dry-run", "--outdir", bundleDir, "--config", "wrangler.jsonc"], join(root, "apps/agent"));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(bundleDir, "index.js"), join(out, "worker.js"));
const extra = readdirSync(bundleDir).filter((f) => !["index.js", "index.js.map", "README.md"].includes(f));
if (extra.length) throw new Error(`Unexpected additional Worker modules: ${extra.join(", ")}`);
rmSync(bundleDir, { recursive: true, force: true });
cpSync(join(root, "apps/web/dist"), join(out, "public"), { recursive: true });
writeFileSync(join(out, "version.json"), `${JSON.stringify({ version: pkg.version, built_at: new Date().toISOString() }, null, 2)}\n`);

// Safety net: no secrets or local dev values may ever ship in the package.
const forbidden = [/pbkdf2-sha256\$\d+\$/, /TALORYS_ENV\s*=\s*development/, /talorys-dev-password/];
function scan(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) scan(p);
    else {
      const text = readFileSync(p, "utf8");
      for (const re of forbidden) if (re.test(text)) throw new Error(`Forbidden content ${re} found in ${p}`);
    }
  }
}
scan(out);
if (!existsSync(join(out, "public/index.html"))) throw new Error("Frontend build missing");
console.log(`✓ Templates ready (${pkg.version})`);
