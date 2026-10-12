import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CancelledError, CliError } from "./errors";
import { formatChecks, install, resetPassword, ensureAuthenticated, type Deps } from "./install";
import { MANIFEST_FILE, readManifest } from "./manifest";
import { checkNodeVersion, detectGlobalClis } from "./requirements";
import { readTemplateInfo } from "./scaffold";
import { PUSH_SECRETS, REQUIRED_SECRETS } from "./secrets";
import { ClackUi } from "./ui";
import { runChecks } from "./verify";
import { Wrangler } from "./wrangler";

const HELP = `create-talorys — deploy Talorys, your personal AI agent, to your own Cloudflare account.

Usage
  npx create-talorys@latest [directory]     Install (or safely resume an interrupted install)
  npx create-talorys@latest update          Update an existing installation, keeping all data
  npx create-talorys@latest status          Show deployment status and health
  npx create-talorys@latest doctor          Diagnose common problems
  npx create-talorys@latest reset-password  Set a new owner password (signs out all devices)

Options
  --dir <path>          Installation directory (default: ./talorys, or the current directory if it is one)
  --account-id <id>     Cloudflare account to use
  --name <name>         Agent name (default: Talorys)
  --semantic / --no-semantic  Turn semantic recall on or off without asking (default No; update keeps the last answer)
  -y, --yes             Skip confirmation prompts
  -h, --help            Show this help
  -v, --version         Show version

Environment
  TALORYS_OWNER_PASSWORD   Owner password for non-interactive installs (never logged)
  CLOUDFLARE_API_TOKEN     Use an API token instead of browser login
`;

const COMMANDS = new Set(["install", "update", "status", "doctor", "reset-password", "help"]);

function defaultDir(positional?: string): string {
  if (positional) return resolve(positional);
  if (existsSync(join(process.cwd(), MANIFEST_FILE))) return process.cwd();
  return resolve("talorys");
}

async function status(dir: string, deps: Deps): Promise<number> {
  const manifest = readManifest(dir);
  if (!manifest) throw new CliError(`No Talorys installation found in ${dir}.`, "Run `npx create-talorys@latest` to install.");
  deps.ui.intro("◆ Talorys status");
  deps.ui.note(
    [
      `Installation   ${manifest.installation_id}`,
      `Status         ${manifest.status}`,
      `Version        ${manifest.deployment_version ?? "unknown"}`,
      `Account        ${manifest.account_name ?? manifest.account_id}`,
      `Worker         ${manifest.worker_name}`,
      `Pages project  ${manifest.pages_project_name}`,
      `URL            ${manifest.public_url ?? "(not deployed yet)"}`,
    ].join("\n"),
  );
  if (!manifest.public_url) return 1;
  const checks = await deps.ui.step("Checking health", () => runChecks(manifest.public_url!, fetch));
  deps.ui.note(formatChecks(checks), "Health");
  deps.ui.outro(checks.every((c) => c.ok) ? "Healthy." : "Unhealthy — try `npx create-talorys@latest doctor`.");
  return checks.every((c) => c.ok) ? 0 : 1;
}

async function doctor(dir: string, deps: Deps): Promise<number> {
  const { ui, wrangler } = deps;
  ui.intro("◆ Talorys doctor");
  const problems: string[] = [];
  try {
    checkNodeVersion();
    ui.success(`Node.js ${process.versions.node}`);
  } catch (e) {
    problems.push((e as Error).message);
    ui.error((e as Error).message);
  }
  try {
    ui.success(`Bundled Wrangler ${await wrangler.version()}; templates ${readTemplateInfo().version}`);
  } catch (e) {
    problems.push((e as Error).message);
    ui.error((e as Error).message);
  }
  for (const g of await detectGlobalClis()) ui.info(`Global ${g.name} ${g.version ?? ""} (not required)`);
  const manifest = readManifest(dir);
  if (!manifest) {
    ui.warn(`No ${MANIFEST_FILE} in ${dir}. Run this inside your Talorys directory.`);
    ui.outro(problems.length ? "Problems found." : "Environment OK.");
    return problems.length ? 1 : 0;
  }
  const who = await ensureAuthenticated(deps);
  const account = who.accounts.find((a) => a.id === manifest.account_id);
  if (!account) {
    problems.push("The installation's Cloudflare account is not accessible with the current login.");
    ui.error(problems.at(-1)!);
  } else {
    wrangler.accountId = account.id;
    ui.success(`Account ${account.name}`);
    if (await wrangler.workerExists(manifest.worker_name)) {
      ui.success(`Worker ${manifest.worker_name} exists`);
      const secrets = await wrangler.listSecrets(manifest.worker_name);
      const missing = REQUIRED_SECRETS.filter((s) => !secrets.includes(s));
      if (missing.length) {
        problems.push(`Missing secrets: ${missing.join(", ")} — re-run the installer to configure them.`);
        ui.error(problems.at(-1)!);
      } else ui.success("Owner secrets configured");
      // Optional, so not a problem: the app works without push.
      if (PUSH_SECRETS.some((s) => !secrets.includes(s))) ui.warn("Push notification keys are not set — run `npx create-talorys@latest update` to add them.");
    } else {
      problems.push(`Worker ${manifest.worker_name} not found — re-run the installer to deploy it.`);
      ui.error(problems.at(-1)!);
    }
    const projects = await wrangler.listPagesProjects();
    if (projects.some((p) => p.name === manifest.pages_project_name)) ui.success(`Pages project ${manifest.pages_project_name} exists`);
    else {
      problems.push(`Pages project ${manifest.pages_project_name} not found — re-run the installer.`);
      ui.error(problems.at(-1)!);
    }
  }
  if (manifest.public_url) {
    const checks = await runChecks(manifest.public_url, fetch);
    for (const c of checks) (c.ok ? ui.success : ui.error).call(ui, `${c.name}: ${c.detail}`);
    if (!checks.every((c) => c.ok)) problems.push("Health checks failed.");
  }
  ui.outro(problems.length ? `${problems.length} problem(s) found. Re-running \`npx create-talorys@latest\` in this directory fixes most of them safely.` : "Everything looks good.");
  return problems.length ? 1 : 0;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dir: { type: "string" },
      "account-id": { type: "string" },
      name: { type: "string" },
      semantic: { type: "boolean" },
      "no-semantic": { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${readTemplateInfo().version}\n`);
    return 0;
  }
  const semantic = values["no-semantic"] ? false : values.semantic;
  const [first, second] = positionals;
  const command = first && COMMANDS.has(first) ? first : "install";
  const dirArg = values.dir ?? (command === "install" ? (first && !COMMANDS.has(first) ? first : second) : second);
  const dir = defaultDir(dirArg);
  if (command === "help") {
    process.stdout.write(HELP);
    return 0;
  }

  const ui = new ClackUi();
  const deps: Deps = { ui, wrangler: new Wrangler() };
  const password = process.env.TALORYS_OWNER_PASSWORD;

  try {
    if (values.semantic && values["no-semantic"]) throw new CliError("Pass either --semantic or --no-semantic, not both.");
    switch (command) {
      case "install":
      case "update":
        await install(
          { dir, yes: values.yes, accountId: values["account-id"], agentName: values.name, semantic, password, mode: command },
          deps,
        );
        return 0;
      case "reset-password":
        await resetPassword({ dir, password }, deps);
        return 0;
      case "status":
        return await status(dir, deps);
      case "doctor":
        return await doctor(dir, deps);
    }
  } catch (error) {
    if (error instanceof CancelledError) {
      ui.outro("Cancelled. Re-run the same command at any time to continue — it resumes safely.");
      return 130;
    }
    if (error instanceof CliError) {
      ui.error(error.message);
      if (error.details) ui.note(error.details, "Details");
      if (error.hint) ui.info(error.hint);
      ui.outro("Setup did not finish. No data was deleted.");
      return 1;
    }
    ui.error(error instanceof Error ? error.message : String(error));
    ui.outro("Unexpected error. Re-run to resume; please report persistent failures on GitHub.");
    return 1;
  }
  return 0;
}

const isDirectRun = process.argv[1] && /create-talorys|cli\.(js|ts)$/.test(process.argv[1]);
if (isDirectRun && !process.env.VITEST) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
