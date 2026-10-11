import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_MODEL } from "@talorys/shared/constants";
import { CliError } from "./errors";
import { detectTimezone, generateInstallationId, type ResourceNames, resourceNames } from "./config";
import { type Manifest, markStep, needsWorkerMigration, readManifest, writeManifest } from "./manifest";
import { checkNodeVersion, detectGlobalClis } from "./requirements";
import { assertSafeTarget, readTemplateInfo, scaffoldProject, templatesDir } from "./scaffold";
import { buildOwnerSecrets, PASSWORD_SECRET, REQUIRED_SECRETS, SESSION_SECRET, validatePassword } from "./secrets";
import type { Ui } from "./ui";
import { type FetchLike, type CheckResult, verifyDeployment } from "./verify";
import type { CloudflareAccount, CloudflareCli, WhoAmI } from "./cf";
import type { Exec } from "./exec";

export interface InstallOptions {
  dir: string;
  yes?: boolean;
  accountId?: string;
  agentName?: string;
  /** Non-interactive password (TALORYS_OWNER_PASSWORD). Never logged. */
  password?: string;
  /** `--semantic` / `--no-semantic`; unset asks interactively (default No). */
  semantic?: boolean;
  /** "install" accepts new or existing directories; "update" requires an existing installation. */
  mode?: "install" | "update";
  verifyTimeoutMs?: number;
}

export interface Deps {
  ui: Ui;
  cf: CloudflareCli;
  fetch?: FetchLike;
  exec?: Exec;
  templates?: string;
}

// ---------- Reusable steps ----------

export async function ensureAuthenticated(deps: Deps): Promise<WhoAmI> {
  const { ui, cf } = deps;
  let who = await ui.step("Checking Cloudflare authentication", () => cf.whoami(), (w) =>
    w.loggedIn ? `Cloudflare authentication verified${w.email ? ` (${w.email})` : ""}` : "Not signed in to Cloudflare yet",
  );
  if (!who.loggedIn) {
    if (!ui.interactive && !process.env.CLOUDFLARE_API_TOKEN) {
      throw new CliError("Not authenticated with Cloudflare.", "Run interactively to sign in through the browser, or set CLOUDFLARE_API_TOKEN.");
    }
    ui.info("Opening Cloudflare in your browser so you can authorize this installer…");
    await cf.login();
    who = await cf.whoami();
    if (!who.loggedIn) throw new CliError("Cloudflare login did not complete.", "Re-run the installer and approve access in the browser.");
    ui.success(`Cloudflare authentication verified${who.email ? ` (${who.email})` : ""}`);
  }
  if (who.accounts.length === 0) {
    throw new CliError(
      "No Cloudflare accounts are visible to this login.",
      "Sign in with a user that belongs to an account, or use an API token with Account Settings:Read.",
    );
  }
  return who;
}

export async function chooseAccount(ui: Ui, accounts: CloudflareAccount[], preferredId?: string): Promise<CloudflareAccount> {
  if (preferredId) {
    const match = accounts.find((a) => a.id === preferredId);
    if (!match) {
      throw new CliError(
        `Account ${preferredId} is not accessible with the current Cloudflare login.`,
        "Sign in as a user with access to that account (`npx cf auth logout`, then re-run), or pass a different --account-id.",
      );
    }
    return match;
  }
  if (accounts.length === 1) return accounts[0]!;
  if (!ui.interactive) {
    throw new CliError("Multiple Cloudflare accounts are available.", `Pass --account-id. Options: ${accounts.map((a) => `${a.name} (${a.id})`).join(", ")}`);
  }
  return ui.select(
    "Choose your Cloudflare account",
    accounts.map((a) => ({ value: a, label: a.name, hint: a.id })),
  );
}

/** Generates a Worker name that collides with no existing Worker in the account. */
export async function allocateNames(cf: CloudflareCli, attempts = 5, nextId: () => string = () => generateInstallationId()): Promise<ResourceNames> {
  for (let i = 0; i < attempts; i++) {
    const names = resourceNames(nextId());
    if (await cf.workerExists(names.workerName)) continue;
    return names;
  }
  throw new CliError("Could not find unused resource names.", "Re-run the installer.");
}

async function askPassword(ui: Ui, provided?: string): Promise<string> {
  if (provided !== undefined) {
    const problem = validatePassword(provided);
    if (problem) throw new CliError(`TALORYS_OWNER_PASSWORD is too weak: ${problem}`);
    return provided;
  }
  if (!ui.interactive) {
    throw new CliError("An owner password is required.", "Run interactively, or provide it via the TALORYS_OWNER_PASSWORD environment variable.");
  }
  for (;;) {
    const password = await ui.password("Set your owner password", validatePassword);
    const again = await ui.password("Confirm your owner password");
    if (password === again) return password;
    ui.warn("The passwords did not match. Please try again.");
  }
}

export function formatChecks(checks: CheckResult[]): string {
  return checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`).join("\n");
}

// ---------- Install / update ----------

/**
 * Idempotent install. A rerun in the same directory reconciles existing
 * resources (no duplicate Workers, no data deletion, no re-prompting for a
 * password that's already configured).
 */
export async function install(opts: InstallOptions, deps: Deps): Promise<Manifest> {
  const { ui, cf } = deps;
  const dir = resolve(opts.dir);
  const templates = deps.templates ?? templatesDir();

  ui.intro("◆ Welcome to Talorys", "Your personal AI agent, powered by your Cloudflare account.");

  const template = await ui.step("Checking system requirements", async () => {
    checkNodeVersion();
    return readTemplateInfo(templates);
  }, (t) => `System requirements OK (Node ${process.versions.node}, Talorys ${t.version})`);

  await ui.step("Detecting Cloudflare CLI", async () => {
    const [bundled, global] = await Promise.all([cf.version(), detectGlobalClis(deps.exec)]);
    return { bundled, global };
  }, ({ bundled, global }) =>
    `Cloudflare CLI detected (bundled cf ${bundled}${global.length ? `; also found ${global.map((g) => `${g.name} ${g.version ?? ""}`.trim()).join(", ")}` : ""})`,
  );

  const target = assertSafeTarget(dir);
  let manifest = target === "existing" ? readManifest(dir) : null;
  if (opts.mode === "update" && !manifest) {
    throw new CliError(`No Talorys installation found in ${dir}.`, "Run this inside your Talorys directory, or pass --dir.");
  }
  if (manifest) ui.info(`Found installation ${manifest.installation_id} — ${opts.mode === "update" ? "updating" : "resuming"} safely. Existing data is never deleted.`);

  const who = await ensureAuthenticated(deps);

  const agentName =
    manifest?.agent_name ??
    opts.agentName ??
    (ui.interactive && !opts.yes
      ? await ui.text("Choose your agent name", {
          initial: "Talorys",
          validate: (v) => (v.trim().length > 0 && v.trim().length <= 60 ? undefined : "1–60 characters"),
        })
      : "Talorys");

  // A flag always decides; otherwise resumed installs and updates keep the recorded answer.
  const semanticDefault =
    opts.semantic ??
    (manifest
      ? (manifest.semantic ?? false)
      : ui.interactive && !opts.yes
        ? await ui.confirm(
            "Enable semantic recall? Finds memories by meaning using Workers AI embeddings (up to 500/day). You can change this later in Settings.",
            false,
          )
        : false);

  const account = await chooseAccount(ui, who.accounts, manifest?.account_id ?? opts.accountId);
  cf.accountId = account.id;
  ui.success(`Using Cloudflare account ${account.name}`);

  const names: ResourceNames = manifest
    ? { installationId: manifest.installation_id, workerName: manifest.worker_name }
    : await ui.step("Reserving resource names", () => allocateNames(cf), (n) => `Resource names reserved (${n.installationId})`);
  const migrating = manifest ? needsWorkerMigration(manifest) : false;

  // Which secrets still need to be created? Never overwrite an existing owner password.
  const workerExists = manifest ? await cf.workerExists(names.workerName) : false;
  const existingSecrets = workerExists ? await cf.listSecrets(names.workerName) : [];
  const missingSecrets = REQUIRED_SECRETS.filter((s) => !existingSecrets.includes(s));
  const password = missingSecrets.includes(PASSWORD_SECRET) ? await askPassword(ui, opts.password) : null;

  if (!opts.yes && ui.interactive) {
    ui.note(
      [
        `Account        ${account.name}`,
        `Worker         ${names.workerName} (web app, API and storage in one Worker)`,
        ...(migrating ? [`Moving from    Pages project ${manifest?.pages_project_name} (left in place; delete it yourself afterwards)`] : []),
        `AI             Cloudflare Workers AI (${DEFAULT_MODEL})`,
        `Storage        SQLite-backed Durable Object`,
        `Semantic recall  ${semanticDefault ? "on" : "off"}`,
        `Plan           Works on the Workers Free plan; no paid services are enabled`,
      ].join("\n"),
      manifest ? "Update" : "Deployment plan",
    );
    if (!(await ui.confirm(manifest ? "Confirm update?" : "Confirm deployment?"))) throw new CliError("Deployment cancelled. Nothing was changed.");
  }

  const timezone = manifest?.timezone ?? detectTimezone();
  const now = new Date().toISOString();
  if (!manifest) {
    mkdirSync(dir, { recursive: true });
    manifest = {
      manifest_version: 1,
      installation_id: names.installationId,
      account_id: account.id,
      account_name: account.name,
      worker_name: names.workerName,
      public_url: null,
      deployment_version: null,
      agent_name: agentName,
      timezone,
      semantic: semanticDefault,
      status: "provisioning",
      steps: [],
      created_at: now,
      updated_at: now,
    };
    writeManifest(dir, manifest);
  } else {
    manifest = { ...manifest, semantic: semanticDefault, status: "provisioning" };
    writeManifest(dir, manifest);
  }

  try {
    await ui.step("Creating personal agent", async () =>
      scaffoldProject(
        {
          dir,
          accountId: account.id,
          workerName: names.workerName,
          installationId: names.installationId,
          version: template.version,
          timezone,
          agentName,
          semanticDefault,
          legacyPagesProject: manifest?.pages_project_name,
        },
        templates,
      ),
    );
    manifest = markStep(dir, manifest, "scaffold");

    await ui.step("Configuring Workers AI", () => cf.modelAvailable(DEFAULT_MODEL), (available) =>
      available === false
        ? `Workers AI configured — warning: ${DEFAULT_MODEL} was not found; choose another model in Settings → AI`
        : `Workers AI configured (${DEFAULT_MODEL}${available === null ? ", availability not verifiable with this login" : ""})`,
    );

    // Missing owner secrets ride along with the deploy, so a new Worker is never live without them.
    const secrets =
      missingSecrets.length > 0 ? await buildOwnerSecrets(password ?? "", { includeSessionSecret: missingSecrets.includes(SESSION_SECRET) }) : {};
    if (!missingSecrets.includes(PASSWORD_SECRET)) delete secrets[PASSWORD_SECRET];

    // The first deploy creates the SQLite Durable Object namespace (declared in `exports`).
    // Later deploys keep it, and installations created by Wrangler keep their namespace
    // and data too, because the Worker name and class stay the same.
    const deployed = await ui.step(
      workerExists ? "Updating Talorys" : "Provisioning persistent storage and deploying Talorys",
      () => cf.deploy(dir, secrets),
      () => "Talorys deployed (one Worker: web app, API and SQLite Durable Object)",
    );
    if (missingSecrets.length > 0) ui.success("Authentication configured (password hashed locally; secrets stored as Cloudflare secrets)");
    else ui.success("Authentication already configured — owner password unchanged");

    const publicUrl = deployed.url ?? (manifest.public_url?.endsWith(".workers.dev") ? manifest.public_url : null);
    if (!publicUrl) {
      throw new CliError(
        "Cloudflare did not report a workers.dev URL for the Worker.",
        `Check that "${names.workerName}" has its workers.dev route enabled in the Cloudflare dashboard, then re-run the installer.`,
      );
    }
    manifest = markStep(dir, { ...manifest, deployment_version: template.version, public_url: publicUrl }, "worker");
    manifest = markStep(dir, manifest, "secrets");

    const checks = await ui.step(
      "Checking deployment health",
      // TALORYS_TEST_VERIFY_ORIGIN exists only for the packaged-CLI test, which cannot reach a real workers.dev site.
      (update) => verifyDeployment(process.env.TALORYS_TEST_VERIFY_ORIGIN ?? publicUrl, { fetch: deps.fetch, timeoutMs: opts.verifyTimeoutMs, onWait: update }),
      (c) => (c.every((x) => x.ok) ? "Web app and API connected; deployment healthy" : "Health checks did not pass"),
    );
    if (!checks.every((c) => c.ok)) {
      throw new CliError(
        "The deployment did not pass its health checks yet.",
        "A new workers.dev address can take a few minutes to become reachable. Re-run the same command to resume; nothing will be duplicated.",
        formatChecks(checks),
      );
    }
    manifest = markStep(
      dir,
      { ...manifest, status: "deployed", ...(migrating ? { migrated_to_worker_at: new Date().toISOString() } : {}) },
      "verified",
    );
  } catch (error) {
    writeManifest(dir, { ...manifest, status: "failed" });
    throw error;
  }

  ui.note(
    [
      `${agentName} is ready!`,
      "",
      "URL:",
      manifest.public_url ?? "",
      ...(migrating ? ["", "Talorys has moved to this address. Sign in once more here,", "and update your bookmarks and home-screen shortcuts."] : []),
      "",
      "Owner: Single-user mode",
      "AI Provider: Cloudflare Workers AI",
      "Storage: Cloudflare Durable Objects",
      "",
      "Default mode: Free",
      "",
      `Project directory: ${dir}`,
    ].join("\n"),
    "Talorys is ready",
  );
  if (migrating) {
    ui.warn(
      `The old Pages project ${manifest.pages_project_name} still serves the previous web app. ` +
        `Delete it once you have switched over: npx cf pages delete ${manifest.pages_project_name}`,
    );
  }
  ui.outro("Open your agent and start chatting.");
  return manifest;
}

// ---------- Password reset ----------

export async function resetPassword(opts: { dir: string; password?: string }, deps: Deps): Promise<void> {
  const { ui, cf } = deps;
  const dir = resolve(opts.dir);
  const manifest = existsSync(dir) ? readManifest(dir) : null;
  if (!manifest) throw new CliError(`No Talorys installation found in ${dir}.`, "Run this inside your Talorys directory, or pass --dir.");
  ui.intro("◆ Reset Talorys owner password");
  const who = await ensureAuthenticated(deps);
  const account = await chooseAccount(ui, who.accounts, manifest.account_id);
  cf.accountId = account.id;
  if (!(await cf.workerExists(manifest.worker_name))) {
    throw new CliError(`The Worker ${manifest.worker_name} was not found in ${account.name}.`, "Run `npx create-talorys@latest` to finish installation.");
  }
  const password = await askPassword(ui, opts.password);
  await ui.step("Updating owner password", async () => {
    const secrets = await buildOwnerSecrets(password, { includeSessionSecret: false });
    await cf.putSecrets(manifest.worker_name, secrets);
  }, () => "Owner password updated. All devices were signed out.");
  ui.outro(manifest.public_url ? `Sign in again at ${manifest.public_url}` : "Done.");
}
