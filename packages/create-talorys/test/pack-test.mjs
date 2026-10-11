// Verifies the distributable CLI works outside the monorepo:
//  1. npm pack create-talorys
//  2. install the tarball into an empty temp project
//  3. run the installed `create-talorys` binary (--help, --version, full non-interactive install)
// Cloudflare is simulated by test/fake-cf.mjs; the deployed site by a local HTTP stub.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "talorys-pack-"));
// Windows refuses to spawn npm.cmd without a shell (Node's CVE-2024-27980 fix): run npm's JS entry with node instead.
const npm = (args, opts) =>
  process.env.npm_execpath
    ? execFileSync(process.execPath, [process.env.npm_execpath, ...args], opts)
    : execFileSync("npm", args, { ...opts, shell: process.platform === "win32" });

try {
  if (!existsSync(join(pkgDir, "templates/version.json")) || !existsSync(join(pkgDir, "dist/cli.js"))) {
    npm(["run", "build"], { cwd: pkgDir, stdio: "inherit" });
  }
  console.log("• npm pack");
  const packOut = npm(["pack", "--json", "--pack-destination", work], { cwd: pkgDir, encoding: "utf8" });
  const [info] = JSON.parse(packOut);
  const tarball = join(work, info.filename);
  const files = info.files.map((f) => f.path);
  assert.ok(files.includes("dist/cli.js"), "tarball contains the CLI");
  assert.ok(files.includes("templates/worker.js"), "tarball contains the Worker bundle");
  assert.ok(files.includes("templates/public/index.html"), "tarball contains the frontend");
  assert.ok(files.includes("templates/public/_headers"), "tarball contains the security headers");
  assert.ok(!files.some((f) => f.includes("functions/")), "no Pages Functions");
  assert.ok(!files.some((f) => f.includes(".dev.vars") || f.startsWith("src/") || f.startsWith("test/")), "no sources, tests or dev secrets");
  console.log(`  ${info.filename}: ${files.length} files, ${(info.size / 1024 / 1024).toFixed(2)} MB`);

  console.log("• Installing tarball into an empty project");
  const project = join(work, "consumer");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "consumer", private: true }));
  npm(["install", "--no-audit", "--no-fund", "--silent", tarball], { cwd: project, stdio: "inherit" });
  const shim = join(project, "node_modules/.bin", process.platform === "win32" ? "create-talorys.cmd" : "create-talorys");
  assert.ok(existsSync(shim), "bin linked");
  // Run the installed CLI through node: Windows .cmd shims cannot be spawned without a shell.
  const cli = join(project, "node_modules/create-talorys/dist/cli.js");

  const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /npx create-talorys@latest/);
  const version = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
  assert.equal(version.stdout.trim(), JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version);

  console.log("• Bundled cf resolves");
  const cfPkg = JSON.parse(readFileSync(join(project, "node_modules/cf/package.json"), "utf8"));
  const cfVersion = spawnSync(process.execPath, [join(project, "node_modules/cf", cfPkg.bin.cf), "--version"], {
    encoding: "utf8",
    env: { ...process.env, CF_SEND_TELEMETRY: "false" },
  });
  assert.equal(cfVersion.status, 0, cfVersion.stderr);
  assert.equal(cfVersion.stdout.trim(), JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).dependencies.cf);
  assert.ok(!existsSync(join(project, "node_modules/create-talorys/node_modules/wrangler")) && !existsSync(join(project, "node_modules/wrangler")), "Wrangler is no longer shipped");

  console.log("• Full non-interactive install against a simulated Cloudflare account");
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path === "/") return res.end("<!doctype html><title>Talorys</title>");
    if (path === "/api/auth/session") return json(200, { authenticated: false, configured: true });
    if (path === "/api/tasks") return json(401, { error: { code: "UNAUTHORIZED" } });
    if (path === "/api/health") return json(200, { ok: true, storage: "ok", schema_version: 1, configured: { password: true, session_secret: true } });
    json(404, {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const statePath = join(work, "cf-state.json");
  writeFileSync(statePath, JSON.stringify({ loggedIn: true, accounts: [{ id: "acc1", name: "Personal Account" }], workers: {}, pages: {}, calls: [], failNext: {} }));
  const run = (args) =>
    new Promise((resolve) => {
      const child = (async () => {
        const { spawn } = await import("node:child_process");
        const p = spawn(process.execPath, [cli, ...args], {
          cwd: work,
          env: {
            ...process.env,
            TALORYS_CF_BIN: join(pkgDir, "test/fake-cf.mjs"),
            FAKE_CF_STATE: statePath,
            TALORYS_OWNER_PASSWORD: "packaged-Test-password-1",
            TALORYS_TEST_VERIFY_ORIGIN: origin,
            CI: "1",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        p.stdout.on("data", (d) => (out += d));
        p.stderr.on("data", (d) => (out += d));
        p.on("close", (code) => resolve({ code, out }));
      })();
      void child;
    });
  const first = await run(["--yes", "--dir", "my-agent"]);
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, /Talorys is ready/);
  assert.doesNotMatch(first.out, /packaged-Test-password-1/);
  const manifest = JSON.parse(readFileSync(join(work, "my-agent/talorys.json"), "utf8"));
  assert.equal(manifest.status, "deployed");
  assert.match(manifest.public_url, /^https:\/\/talorys-[a-z0-9]{8}\.owner\.workers\.dev$/);
  assert.ok(existsSync(join(work, "my-agent/.cloudflare/output/v0/workers/default/worker.config.json")), "cf Build Output generated");

  console.log("• Repeated install is idempotent");
  const second = await run(["--yes", "--dir", "my-agent"]);
  assert.equal(second.code, 0, second.out);
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(Object.keys(state.workers.acc1).length, 1);
  assert.equal(Object.keys(state.pages.acc1 ?? {}).length, 0);
  assert.equal(state.calls.filter((c) => c.key === "deploy" && c.args.includes("--secrets-file")).length, 1);

  console.log("• status command");
  const status = await run(["status", "--dir", "my-agent"]);
  assert.match(status.out, /Installation\s+[a-z0-9]{8}/);
  server.close();
  console.log("✓ Packaged CLI works outside the monorepo");
} finally {
  rmSync(work, { recursive: true, force: true });
}
