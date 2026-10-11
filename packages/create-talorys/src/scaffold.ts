import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "./errors";
import { BUILD_OUTPUT_DIR, generateBuildOutputConfig, generateWorkerConfig, toJson, WORKER_OUTPUT_DIR } from "./config";
import { MANIFEST_FILE } from "./manifest";

export interface TemplateInfo {
  version: string;
  built_at: string;
}

export function templatesDir(): string {
  if (process.env.TALORYS_TEMPLATES_DIR) return process.env.TALORYS_TEMPLATES_DIR;
  return join(dirname(fileURLToPath(import.meta.url)), "..", "templates");
}

export function readTemplateInfo(dir = templatesDir()): TemplateInfo {
  const path = join(dir, "version.json");
  if (!existsSync(path)) {
    throw new CliError("This copy of create-talorys is missing its deployment templates.", "Reinstall with `npx create-talorys@latest`.");
  }
  return JSON.parse(readFileSync(path, "utf8")) as TemplateInfo;
}

/** A directory is safe to install into when it doesn't exist, is empty, or already holds a Talorys manifest. */
export function assertSafeTarget(dir: string): "new" | "existing" {
  if (!existsSync(dir)) return "new";
  if (existsSync(join(dir, MANIFEST_FILE))) return "existing";
  const entries = readdirSync(dir).filter((e) => e !== ".DS_Store");
  if (entries.length === 0) return "new";
  throw new CliError(
    `${dir} already exists and is not a Talorys installation.`,
    "Choose another directory with `--dir <path>` so nothing unrelated is overwritten.",
  );
}

export interface ScaffoldInput {
  dir: string;
  accountId: string;
  workerName: string;
  installationId: string;
  version: string;
  timezone: string;
  agentName: string;
  semanticDefault?: boolean;
  /** Pages project left over from an installation created before the single-Worker layout. */
  legacyPagesProject?: string;
}

/**
 * Writes the deployable project as a cf Build Output (.cloudflare/output/v0):
 * the prebuilt Worker bundle, the static frontend and the Worker config, ready
 * for `cf deploy --prebuilt`. Generated artifacts are replaced on every run;
 * the manifest is left alone.
 */
export function scaffoldProject(input: ScaffoldInput, templates = templatesDir()): void {
  const { dir } = input;
  mkdirSync(dir, { recursive: true });
  removeTwoResourceLayout(dir);

  const output = join(dir, BUILD_OUTPUT_DIR);
  const worker = join(dir, WORKER_OUTPUT_DIR);
  rmSync(output, { recursive: true, force: true });
  mkdirSync(join(worker, "bundle"), { recursive: true });
  cpSync(join(templates, "worker.js"), join(worker, "bundle", "worker.js"));
  cpSync(join(templates, "public"), join(worker, "assets"), { recursive: true });

  writeFileSync(join(output, "config.json"), toJson(generateBuildOutputConfig({ accountId: input.accountId })));
  writeFileSync(
    join(worker, "worker.config.json"),
    toJson(
      generateWorkerConfig({
        workerName: input.workerName,
        installationId: input.installationId,
        version: input.version,
        timezone: input.timezone,
        agentName: input.agentName,
        semanticDefault: input.semanticDefault,
      }),
    ),
  );
  writeFileSync(join(dir, ".gitignore"), ".wrangler/\nnode_modules/\n");
  writeFileSync(join(dir, "README.md"), projectReadme(input));
}

/**
 * Installations created before the single-Worker layout kept a Wrangler Worker
 * project in agent/ and a Pages project in web/. Removes those generated files
 * (and the folders, once empty) so only the current layout remains. Nothing
 * else is touched.
 */
function removeTwoResourceLayout(dir: string): void {
  const generated: Record<string, string[]> = {
    agent: ["worker.js", "wrangler.jsonc", ".wrangler"],
    web: ["dist", "functions", "wrangler.jsonc", ".wrangler"],
  };
  for (const [folder, entries] of Object.entries(generated)) {
    const path = join(dir, folder);
    if (!existsSync(path)) continue;
    for (const entry of entries) rmSync(join(path, entry), { recursive: true, force: true });
    if (readdirSync(path).length === 0) rmSync(path, { recursive: true, force: true });
  }
}

function projectReadme(input: ScaffoldInput): string {
  const legacy = input.legacyPagesProject
    ? `
## Old Pages project

This installation was created when Talorys used a separate Cloudflare Pages
frontend (\`${input.legacyPagesProject}\`). The Worker now serves the web app
itself, so that project is no longer needed. It still shows the previous
version of the web app, so delete it once you have switched to the Worker URL.
The installer never deletes anything, so run this yourself:

\`\`\`bash
npx cf pages delete ${input.legacyPagesProject}
\`\`\`
`
    : "";
  return `# Your Talorys deployment

This directory was created by \`create-talorys\` and identifies your deployment
(\`${input.installationId}\`). Keep it — it contains no secrets, but the
installer uses \`talorys.json\` to find your Cloudflare resources.

Talorys runs as one Cloudflare Worker, \`${input.workerName}\`. It serves the web
app as static assets, handles \`/api/*\`, and holds your data in a SQLite Durable
Object. The deployable files are a prebuilt
[cf](https://www.npmjs.com/package/cf) Build Output in \`${BUILD_OUTPUT_DIR}/\`
(Worker config, bundle and web app); the installer regenerates them on every
update.

Commands (run inside this directory):

- \`npx create-talorys@latest update\` — update to the latest version (keeps all data)
- \`npx create-talorys@latest status\` — show deployment status
- \`npx create-talorys@latest doctor\` — diagnose problems
- \`npx create-talorys@latest reset-password\` — set a new owner password

Your data lives in a Durable Object inside your Cloudflare account, not in this folder.
Use Settings → Privacy → Export in the app to download a backup.
${legacy}`;
}
