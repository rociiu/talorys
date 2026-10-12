import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_MODEL } from "@talorys/shared/constants";
import { CliError } from "./errors";
import { COMPATIBILITY_DATE, detectTimezone, generateInstallationId, type ResourceNames, resourceNames } from "./config";
import { type Manifest, markStep, readManifest, writeManifest } from "./manifest";
import { checkNodeVersion, detectGlobalClis } from "./requirements";
import { assertSafeTarget, readTemplateInfo, scaffoldProject, templatesDir } from "./scaffold";
import { buildOwnerSecrets, generatePushKeys, PASSWORD_SECRET, PUSH_SECRETS, REQUIRED_SECRETS, SESSION_SECRET, validatePassword } from "./secrets";
import type { Ui } from "./ui";
import { type FetchLike, type CheckResult, verifyDeployment } from "./verify";
import type { CloudflareAccount, Wrangler, WhoAmI } from "./wrangler";
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
  wrangler: Wrangler;
  fetch?: FetchLike;
  exec?: Exec;
  templates?: string;
}

// ---------- Reusable steps ----------

export async function ensureAuthenticated(deps: Deps): Promise<WhoAmI> {
  const { ui, wrangler } = deps;
  let who = await ui.step("Checking Cloudflare authentication", () => wrangler.whoami(), (w) =>
    w.loggedIn ? `Cloudflare authentication verified${w.email ? ` (${w.email})` : ""}` : "Not signed in to Cloudflare yet",
  );
  if (!who.loggedIn) {
    if (!ui.interactive && !process.env.CLOUDFLARE_API_TOKEN) {
      throw new CliError("Not authenticated with Cloudflare.", "Run interactively to sign in through the browser, or set CLOUDFLARE_API_TOKEN.");
    }
    ui.info("Opening Cloudflare in your browser so you can authorize this installer…");
    await wrangler.login();
    who = await wrangler.whoami();
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
        "Sign in as a user with access to that account (`npx wrangler logout`, then re-run), or pass a different --account-id.",
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

/** Generates names that collide with no existing Worker or Pages project in the account. */
export async function allocateNames(wrangler: Wrangler, attempts = 5, nextId: () => string = () => generateInstallationId()): Promise<ResourceNames> {
  const projects = await wrangler.listPagesProjects();
  for (let i = 0; i < attempts; i++) {
    const names = resourceNames(nextId());
    if (projects.some((p) => p.name === names.pagesProjectName)) continue;
    if (await wrangler.workerExists(names.workerName)) continue;
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

export async function deployPages(deps: Deps, dir: string, projectName: string): Promise<string> {
  const { wrangler } = deps;
  const webDir = join(dir, "web");
  let projects = await wrangler.listPagesProjects();
  if (!projects.some((p) => p.name === projectName)) {
    await wrangler.createPagesProject(projectName, webDir, COMPATIBILITY_DATE);
    projects = await wrangler.listPagesProjects();
  }
  const project = projects.find((p) => p.name === projectName);
  await wrangler.deployPages(webDir, projectName, "dist");
  const domain = project?.domains.find((d) => d.endsWith(".pages.dev"));
  if (!domain) {
    throw new CliError(
      "Cloudflare did not report a pages.dev domain for the project.",
      `Check the "${projectName}" project in the Cloudflare dashboard, then re-run the installer.`,
    );
  }
  return `https://${domain.replace(/^https?:\/\//, "")}`;
}

export function formatChecks(checks: CheckResult[]): string {
  return checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`).join("\n");
}

// ---------- Install / update ----------

/**
 * Idempotent install. A rerun in the same directory reconciles existing
 * resources (no duplicate Workers or Pages projects, no data deletion, no
 * re-prompting for a password that's already configured).
 */
export async function install(opts: InstallOptions, deps: Deps): Promise<Manifest> {
  const { ui, wrangler } = deps;
  const dir = resolve(opts.dir);
  const templates = deps.templates ?? templatesDir();

  ui.intro("◆ Welcome to Talorys", "Your personal AI agent, powered by your Cloudflare account.");

  const template = await ui.step("Checking system requirements", async () => {
    checkNodeVersion();
    return readTemplateInfo(templates);
  }, (t) => `System requirements OK (Node ${process.versions.node}, Talorys ${t.version})`);

  await ui.step("Detecting Cloudflare CLI", async () => {
    const [bundled, global] = await Promise.all([wrangler.version(), detectGlobalClis(deps.exec)]);
    return { bundled, global };
  }, ({ bundled, global }) =>
    `Cloudflare CLI detected (bundled Wrangler ${bundled}${global.length ? `; also found ${global.map((g) => `${g.name} ${g.version ?? ""}`.trim()).join(", ")}` : ""})`,
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
  wrangler.accountId = account.id;
  ui.success(`Using Cloudflare account ${account.name}`);

  const names: ResourceNames = manifest
    ? { installationId: manifest.installation_id, workerName: manifest.worker_name, pagesProjectName: manifest.pages_project_name }
    : await ui.step("Reserving resource names", () => allocateNames(wrangler), (n) => `Resource names reserved (${n.installationId})`);

  // Which secrets still need to be created? Never overwrite an existing owner password.
  const workerExists = manifest ? await wrangler.workerExists(names.workerName) : false;
  const existingSecrets = workerExists ? await wrangler.listSecrets(names.workerName) : [];
  const missingSecrets = REQUIRED_SECRETS.filter((s) => !existingSecrets.includes(s));
  // Existing push keys are kept: replacing them would silently disconnect every subscribed device.
  const needsPushKeys = PUSH_SECRETS.some((s) => !existingSecrets.includes(s));
  const password = missingSecrets.includes(PASSWORD_SECRET) ? await askPassword(ui, opts.password) : null;

  if (!opts.yes && ui.interactive) {
    ui.note(
      [
        `Account        ${account.name}`,
        `Agent Worker   ${names.workerName} (private, no public URL)`,
        `Pages project  ${names.pagesProjectName}`,
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
      pages_project_name: names.pagesProjectName,
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
          workerName: names.workerName,
          pagesProjectName: names.pagesProjectName,
          installationId: names.installationId,
          version: template.version,
          timezone,
          agentName,
          semanticDefault,
        },
        templates,
      ),
    );
    manifest = markStep(dir, manifest, "scaffold");

    await ui.step("Configuring Workers AI", () => wrangler.modelAvailable(DEFAULT_MODEL), (available) =>
      available === false
        ? `Workers AI configured — warning: ${DEFAULT_MODEL} was not found; choose another model in Settings → AI`
        : `Workers AI configured (${DEFAULT_MODEL}${available === null ? ", availability not verifiable with this login" : ""})`,
    );

    // The first deploy creates the SQLite Durable Object namespace via the v1 migration.
    // Later deploys keep it (migrations are append-only), so data survives upgrades.
    await ui.step(
      workerExists ? "Updating agent backend" : "Provisioning persistent storage and deploying agent backend",
      () => wrangler.deployWorker(join(dir, "agent", "wrangler.jsonc")),
      () => "Agent backend deployed (private Worker + SQLite Durable Object)",
    );
    manifest = markStep(dir, { ...manifest, deployment_version: template.version }, "worker");

    const pushKeys = needsPushKeys ? await generatePushKeys() : {};
    if (missingSecrets.length > 0) {
      await ui.step("Configuring authentication", async () => {
        const secrets = await buildOwnerSecrets(password ?? "", { includeSessionSecret: missingSecrets.includes(SESSION_SECRET) });
        if (!missingSecrets.includes(PASSWORD_SECRET)) delete secrets[PASSWORD_SECRET];
        await wrangler.putSecrets(names.workerName, { ...secrets, ...pushKeys });
      }, () => "Authentication configured (password hashed locally; secrets stored as Cloudflare secrets)");
    } else {
      ui.success("Authentication already configured — owner password unchanged");
      if (needsPushKeys) {
        await ui.step("Configuring push notifications", () => wrangler.putSecrets(names.workerName, pushKeys),
          () => "Push notification keys created (stored as Cloudflare secrets)");
      }
    }
    manifest = markStep(dir, manifest, "secrets");

    const publicUrl = await ui.step("Deploying Cloudflare Pages", () => deployPages(deps, dir, names.pagesProjectName), (url) => `Cloudflare Pages deployed (${url})`);
    manifest = markStep(dir, { ...manifest, public_url: publicUrl }, "pages");

    const checks = await ui.step(
      "Checking deployment health",
      // TALORYS_TEST_VERIFY_ORIGIN exists only for the packaged-CLI test, which cannot reach a real pages.dev site.
      (update) => verifyDeployment(process.env.TALORYS_TEST_VERIFY_ORIGIN ?? publicUrl, { fetch: deps.fetch, timeoutMs: opts.verifyTimeoutMs, onWait: update }),
      (c) => (c.every((x) => x.ok) ? "Frontend and backend connected; deployment healthy" : "Health checks did not pass"),
    );
    if (!checks.every((c) => c.ok)) {
      throw new CliError(
        "The deployment did not pass its health checks yet.",
        "New pages.dev sites can take a few minutes to become reachable. Re-run the same command to resume; nothing will be duplicated.",
        formatChecks(checks),
      );
    }
    manifest = markStep(dir, { ...manifest, status: "deployed" }, "verified");
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
  ui.outro("Open your agent and start chatting.");
  return manifest;
}

// ---------- Password reset ----------

export async function resetPassword(opts: { dir: string; password?: string }, deps: Deps): Promise<void> {
  const { ui, wrangler } = deps;
  const dir = resolve(opts.dir);
  const manifest = existsSync(dir) ? readManifest(dir) : null;
  if (!manifest) throw new CliError(`No Talorys installation found in ${dir}.`, "Run this inside your Talorys directory, or pass --dir.");
  ui.intro("◆ Reset Talorys owner password");
  const who = await ensureAuthenticated(deps);
  const account = await chooseAccount(ui, who.accounts, manifest.account_id);
  wrangler.accountId = account.id;
  if (!(await wrangler.workerExists(manifest.worker_name))) {
    throw new CliError(`The Worker ${manifest.worker_name} was not found in ${account.name}.`, "Run `npx create-talorys@latest` to finish installation.");
  }
  const password = await askPassword(ui, opts.password);
  await ui.step("Updating owner password", async () => {
    const secrets = await buildOwnerSecrets(password, { includeSessionSecret: false });
    await wrangler.putSecrets(manifest.worker_name, secrets);
  }, () => "Owner password updated. All devices were signed out.");
  ui.outro(manifest.public_url ? `Sign in again at ${manifest.public_url}` : "Done.");
}
