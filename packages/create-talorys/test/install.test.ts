import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyPassword } from "@talorys/shared/crypto";
import { allocateNames, install, resetPassword } from "../src/install";
import { readManifest } from "../src/manifest";
import { CliError } from "../src/errors";
import { generateWorkerConfig, toJson, WORKER_OUTPUT_DIR } from "../src/config";
import { main } from "../src/cli";
import { fakeSite, makeLegacyInstallation, makeSandbox, makeTemplates, ScriptedUi, STRONG_PASSWORD } from "./helpers";

const FAST = { verifyTimeoutMs: 2000 };
const WORKER_CONFIG = join(WORKER_OUTPUT_DIR, "worker.config.json");

function freshAnswers() {
  return ["", STRONG_PASSWORD, STRONG_PASSWORD, true]; // name (default), password, confirm, confirm deploy
}

function workerConfig(dir: string) {
  return JSON.parse(readFileSync(join(dir, WORKER_CONFIG), "utf8"));
}

/** Every file under `dir`, recursively, as text (directories read as empty). */
function allText(dir: string): string {
  return readdirSync(dir, { recursive: true })
    .map((f) => {
      try {
        return readFileSync(join(dir, String(f)), "utf8");
      } catch {
        return "";
      }
    })
    .join("\n");
}

describe("installer: fresh installation", () => {
  it("provisions one Worker with cf and reports the real workers.dev URL", async () => {
    const sb = makeSandbox({ workersSubdomain: "ada-x7" });
    const ui = new ScriptedUi(freshAnswers());
    const manifest = await install({ dir: sb.dir, ...FAST }, { ui, cf: sb.cf(), fetch: fakeSite(), templates: sb.templates });

    const state = sb.state();
    const worker = state.workers.acc1![manifest.worker_name]!;
    expect(worker.workers_dev).toBe(true);
    expect(worker.assets).toMatchObject({ notFoundHandling: "single-page-application", runWorkerFirst: ["/api/*"] });
    expect(worker.assets?.files?.sort()).toEqual(["_headers", "index.html"]);
    // The Durable Object is declared with cf's exports lifecycle; no Wrangler migrations are sent.
    expect(worker.exports).toEqual({ TalorysAgent: { type: "durable-object", storage: "sqlite" } });
    expect(worker.migrations).toEqual([]);
    expect(worker.env?.TalorysAgent).toEqual({ type: "durable-object", worker: manifest.worker_name, exportName: "TalorysAgent" });
    expect(Object.keys(worker.secrets).sort()).toEqual(["OWNER_PASSWORD_HASH", "SESSION_SECRET"]);
    expect(worker.secrets.OWNER_PASSWORD_HASH!.prefix).toBe("pbkdf2-sha256$");
    expect(worker.secrets.SESSION_SECRET!.length).toBeGreaterThanOrEqual(43);
    // URL comes from Cloudflare (note the account's workers.dev subdomain), not from the Worker name alone.
    expect(manifest.public_url).toBe(`https://${manifest.worker_name}.ada-x7.workers.dev`);
    expect(manifest.status).toBe("deployed");
    expect(manifest.worker_name).toMatch(/^talorys-[a-z0-9]{8}$/);
    expect(manifest.pages_project_name).toBeUndefined();

    // One deploy carries the secrets (a new Worker is never live without them); no Pages at all.
    const keys = state.calls.map((c) => c.key);
    expect(keys.filter((k) => k === "deploy")).toHaveLength(1);
    expect(keys).not.toContain("secrets bulk");
    expect(keys.some((k) => k.startsWith("pages"))).toBe(false);
    expect(state.calls.every((c) => c.env.CF_SEND_TELEMETRY === "false")).toBe(true);

    // Build Output layout that `cf deploy --prebuilt` reads from the project directory.
    const deploy = state.calls.find((c) => c.key === "deploy")!;
    expect(deploy.args.slice(0, 2)).toEqual(["deploy", "--prebuilt"]);
    expect(deploy.cwd).toBe(sb.dir);
    expect(JSON.parse(readFileSync(join(sb.dir, ".cloudflare/output/v0/config.json"), "utf8"))).toEqual({ accountId: "acc1", buildContext: { isPreview: false } });
    expect(readFileSync(join(sb.dir, WORKER_OUTPUT_DIR, "assets/index.html"), "utf8")).toContain("<title>Talorys</title>");
    expect(existsSync(join(sb.dir, WORKER_OUTPUT_DIR, "bundle/worker.js"))).toBe(true);
    expect(existsSync(join(sb.dir, "agent"))).toBe(false);
    expect(existsSync(join(sb.dir, "web"))).toBe(false);
    expect(ui.log.some((l) => l.includes("Talorys is ready"))).toBe(true);
  });

  it("never writes secrets or the password to disk or into arguments, and removes the temporary secrets file", async () => {
    const sb = makeSandbox();
    await install({ dir: sb.dir, ...FAST }, { ui: new ScriptedUi(freshAnswers()), cf: sb.cf(), fetch: fakeSite(), templates: sb.templates });
    const text = allText(sb.dir);
    expect(text).not.toContain(STRONG_PASSWORD);
    expect(text).not.toMatch(/pbkdf2-sha256\$/);
    const state = sb.state();
    expect(JSON.stringify(state.calls)).not.toContain(STRONG_PASSWORD);
    expect(JSON.stringify(state.calls)).not.toMatch(/pbkdf2-sha256\$/);
    expect(state.lastSecretsFile).toBeTruthy();
    expect(state.lastSecretsFile!.startsWith(sb.dir)).toBe(false);
    expect(existsSync(state.lastSecretsFile!)).toBe(false);
  });

  it("rejects weak passwords from the environment", async () => {
    const sb = makeSandbox();
    await expect(
      install({ dir: sb.dir, yes: true, password: "short", ...FAST }, { ui: new ScriptedUi([], false), cf: sb.cf(), fetch: fakeSite(), templates: sb.templates }),
    ).rejects.toThrow(/too weak/);
  });

  it("asks which account to use when several exist, and pins the deploy to it", async () => {
    const sb = makeSandbox({ accounts: [{ id: "acc1", name: "Personal Account" }, { id: "acc2", name: "Work" }] });
    const ui = new ScriptedUi(["", "Work", STRONG_PASSWORD, STRONG_PASSWORD, true]);
    const m = await install({ dir: sb.dir, ...FAST }, { ui, cf: sb.cf(), fetch: fakeSite(), templates: sb.templates });
    expect(m.account_id).toBe("acc2");
    expect(sb.state().workers.acc2?.[m.worker_name]).toBeDefined();
    expect(sb.state().workers.acc1?.[m.worker_name]).toBeUndefined();
    expect(ui.prompts).toContain("Choose your Cloudflare account");
  });

  it("logs in through the browser flow when not authenticated", async () => {
    const sb = makeSandbox({ loggedIn: false });
    await install({ dir: sb.dir, ...FAST }, { ui: new ScriptedUi(freshAnswers()), cf: sb.cf(), fetch: fakeSite(), templates: sb.templates });
    expect(sb.state().calls.some((c) => c.key === "auth login")).toBe(true);
  });

  it("fails clearly without credentials in non-interactive mode", async () => {
    const sb = makeSandbox({ loggedIn: false });
    const saved = process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CLOUDFLARE_API_TOKEN;
    await expect(
      install({ dir: sb.dir, yes: true, password: STRONG_PASSWORD, ...FAST }, { ui: new ScriptedUi([], false), cf: sb.cf(), fetch: fakeSite(), templates: sb.templates }),
    ).rejects.toThrow(/Not authenticated/);
    if (saved) process.env.CLOUDFLARE_API_TOKEN = saved;
  });

  it("refuses to overwrite an unrelated non-empty directory", async () => {
    const sb = makeSandbox();
    mkdirSync(sb.dir, { recursive: true });
    writeFileSync(join(sb.dir, "notes.txt"), "mine");
    await expect(
      install({ dir: sb.dir, ...FAST }, { ui: new ScriptedUi(freshAnswers()), cf: sb.cf(), fetch: fakeSite(), templates: sb.templates }),
    ).rejects.toThrow(/not a Talorys installation/);
    expect(readFileSync(join(sb.dir, "notes.txt"), "utf8")).toBe("mine");
  });

  it("does not deploy when the owner declines the confirmation", async () => {
    const sb = makeSandbox();
    await expect(
      install({ dir: sb.dir, ...FAST }, { ui: new ScriptedUi(["", STRONG_PASSWORD, STRONG_PASSWORD, false]), cf: sb.cf(), fetch: fakeSite(), templates: sb.templates }),
    ).rejects.toThrow(/cancelled/i);
    expect(sb.state().calls.some((c) => c.key === "deploy")).toBe(false);
  });
});

describe("installer: idempotency and recovery", () => {
  it("a repeated installation reconciles without re-prompting or touching data", async () => {
    const sb = makeSandbox();
    const first = await install({ dir: sb.dir, ...FAST }, { ui: new ScriptedUi(freshAnswers()), cf: sb.cf(), fetch: fakeSite(), templates: sb.templates });
    const secretsBefore = sb.state().workers.acc1![first.worker_name]!.secrets;

    const ui = new ScriptedUi([true]); // only the confirmation prompt
    const second = await install({ dir: sb.dir, ...FAST }, { ui, cf: sb.cf(), fetch: fakeSite(), templates: sb.templates });

    const state = sb.state();
    expect(second.installation_id).toBe(first.installation_id);
    expect(second.public_url).toBe(first.public_url);
    expect(Object.keys(state.workers.acc1!)).toHaveLength(1);
    expect(state.workers.acc1![first.worker_name]!.secrets).toEqual(secretsBefore);
    expect(state.workers.acc1![first.worker_name]!.durableObjectData).toBe("owner-data");
    // The second deploy uploads no secrets: cf keeps the existing ones.
    const deploys = state.calls.filter((c) => c.key === "deploy");
    expect(deploys).toHaveLength(2);
    expect(deploys[1]!.args).not.toContain("--secrets-file");
    expect(ui.prompts).toEqual(["Confirm update?"]);
  });

  it("resumes after an interrupted deployment without duplicating resources", async () => {
    const sb = makeSandbox();
    // The first verification attempt never succeeds (site unreachable), as after a dropped connection.
    const error = await install({ dir: sb.dir, ...FAST }, { ui: new ScriptedUi(freshAnswers()), cf: sb.cf(), fetch: fakeSite({ failFirst: 1000 }), templates: sb.templates }).catch((e) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toMatch(/health checks/);
    expect(readManifest(sb.dir)?.status).toBe("failed");
    expect(readManifest(sb.dir)?.steps).toEqual(["scaffold", "worker", "secrets"]);

    const resumed = await install({ dir: sb.dir, yes: true, ...FAST }, { ui: new ScriptedUi([]), cf: sb.cf(), fetch: fakeSite(), templates: sb.templates });
    expect(resumed.status).toBe("deployed");
    const state = sb.state();
    expect(Object.keys(state.workers.acc1!)).toHaveLength(1);
    expect(state.calls.filter((c) => c.key === "deploy" && c.args.includes("--secrets-file"))).toHaveLength(1);
  });

  it("re-prompts for the password only if the earlier run died before deploying it", async () => {
    const sb = makeSandbox();
    sb.update((s) => (s.failNext = { deploy: "Network connection lost: fetch failed" }));
    const error = await install({ dir: sb.dir, ...FAST }, { ui: new ScriptedUi(freshAnswers()), cf: sb.cf(), fetch: fakeSite(), templates: sb.templates }).catch((e) => e);
    expect((error as CliError).message).toMatch(/network error/);
    const ui = new ScriptedUi([STRONG_PASSWORD, STRONG_PASSWORD, true]);
    const m = await install({ dir: sb.dir, ...FAST }, { ui, cf: sb.cf(), fetch: fakeSite(), templates: sb.templates });
    expect(m.status).toBe("deployed");
    expect(Object.keys(sb.state().workers.acc1![m.worker_name]!.secrets)).toHaveLength(2);
  });

  it("waits for propagation and succeeds once the site responds", async () => {
    const sb = makeSandbox();
    const site = fakeSite({ failFirst: 4 });
    const m = await install({ dir: sb.dir, verifyTimeoutMs: 30_000 }, { ui: new ScriptedUi(freshAnswers()), cf: sb.cf(), fetch: site, templates: sb.templates });
    expect(m.status).toBe("deployed");
    expect(site.calls.length).toBeGreaterThan(4);
  }, 60_000);

  it("never prints success when health checks fail", async () => {
    const sb = makeSandbox();
    const ui = new ScriptedUi(freshAnswers());
    const error = await install({ dir: sb.dir, ...FAST }, { ui, cf: sb.cf(), fetch: fakeSite({ healthy: false }), templates: sb.templates }).catch((e) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).details).toMatch(/Owner secrets are not configured/);
    expect(ui.log.some((l) => l.includes("is ready"))).toBe(false);
    expect(readManifest(sb.dir)?.status).toBe("failed");
  });

  it("explains missing permissions", async () => {
    const sb = makeSandbox();
    sb.update((s) => (s.failNext = { deploy: "┌ APIError\n│ [10000] Authentication error\n└" }));
    const error = await install({ dir: sb.dir, ...FAST }, { ui: new ScriptedUi(freshAnswers()), cf: sb.cf(), fetch: fakeSite(), templates: sb.templates }).catch((e) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toMatch(/rejected the credentials/);
    expect((error as CliError).hint).toMatch(/edit Workers/);
    expect((error as CliError).details).not.toMatch(/[│┌└]/);
  });

  it("explains how to get a workers.dev subdomain when the account has none", async () => {
    const sb = makeSandbox({ workersSubdomain: null });
    const error = await install({ dir: sb.dir, ...FAST }, { ui: new ScriptedUi(freshAnswers()), cf: sb.cf(), fetch: fakeSite(), templates: sb.templates }).catch((e) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toMatch(/no workers\.dev subdomain/);
    expect((error as CliError).details).toMatch(/workers\/onboarding/);
    expect(readManifest(sb.dir)?.status).toBe("failed");

    // Once the owner registers one, re-running resumes (the password was never stored, so it is asked again).
    sb.update((s) => (s.workersSubdomain = "ada"));
    const m = await install({ dir: sb.dir, ...FAST }, { ui: new ScriptedUi([STRONG_PASSWORD, STRONG_PASSWORD, true]), cf: sb.cf(), fetch: fakeSite(), templates: sb.templates });
    expect(m.status).toBe("deployed");
    expect(m.public_url).toBe(`https://${m.worker_name}.ada.workers.dev`);
  });

  it("reports cf's strict-mode abort as a failure even though cf prints 'Deploy complete'", async () => {
    const sb = makeSandbox();
    const m = await install({ dir: sb.dir, ...FAST }, { ui: new ScriptedUi(freshAnswers()), cf: sb.cf(), fetch: fakeSite(), templates: sb.templates });
    sb.update((s) => (s.workers.acc1![m.worker_name]!.lastDeployedFrom = "api"));
    const error = await install({ dir: sb.dir, mode: "update", yes: true, ...FAST }, { ui: new ScriptedUi([]), cf: sb.cf(), fetch: fakeSite(), templates: sb.templates }).catch((e) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toMatch(/changed outside the installer/);
    expect((error as CliError).hint).toMatch(/no data changed/);
    expect(readManifest(sb.dir)?.status).toBe("failed");
    expect(sb.state().workers.acc1![m.worker_name]!.deploys).toBe(1);
  });

  it("avoids Worker names that already exist in the account (exact match only)", async () => {
    const sb = makeSandbox();
    sb.update((s) => {
      const w = { secrets: {}, migrations: [], workers_dev: true, vars: {}, deploys: 1, durableObjectData: "someone-else" };
      s.workers.acc1 = { "talorys-aaaaaaaa": w, "talorys-bbbbbbbb": w, "talorys-cccccccc-extra": w };
    });
    const ids = ["aaaaaaaa", "bbbbbbbb", "cccccccc"];
    const names = await allocateNames(sb.cf(), 5, () => ids.shift()!);
    expect(names.installationId).toBe("cccccccc");
  });
});

describe("installer: upgrades and password reset", () => {
  it("updates code and version without losing data or secrets", async () => {
    const sb = makeSandbox();
    const first = await install({ dir: sb.dir, ...FAST }, { ui: new ScriptedUi(freshAnswers()), cf: sb.cf(), fetch: fakeSite(), templates: sb.templates });
    const secretsBefore = sb.state().workers.acc1![first.worker_name]!.secrets;
    const v2 = makeTemplates(sb.root, "0.2.0");
    const updated = await install({ dir: sb.dir, mode: "update", yes: true, ...FAST }, { ui: new ScriptedUi([]), cf: sb.cf(), fetch: fakeSite(), templates: v2 });
    const worker = sb.state().workers.acc1![first.worker_name]!;
    expect(updated.deployment_version).toBe("0.2.0");
    expect(worker.vars.TALORYS_DEPLOYED_VERSION).toBe("0.2.0");
    expect(worker.deploys).toBe(2);
    expect(worker.secrets).toEqual(secretsBefore);
    expect(worker.durableObjectData).toBe("owner-data");
    expect(readFileSync(join(sb.dir, WORKER_OUTPUT_DIR, "bundle/worker.js"), "utf8")).toContain("0.2.0");
  });

  it("update requires an existing installation", async () => {
    const sb = makeSandbox();
    await expect(
      install({ dir: sb.dir, mode: "update", yes: true, ...FAST }, { ui: new ScriptedUi([]), cf: sb.cf(), fetch: fakeSite(), templates: sb.templates }),
    ).rejects.toThrow(/No Talorys installation/);
  });

  it("reset-password replaces only the password hash, through a temporary file", async () => {
    const sb = makeSandbox();
    const m = await install({ dir: sb.dir, ...FAST }, { ui: new ScriptedUi(freshAnswers()), cf: sb.cf(), fetch: fakeSite(), templates: sb.templates });
    const before = sb.state().workers.acc1![m.worker_name]!.secrets;
    await resetPassword({ dir: sb.dir }, { ui: new ScriptedUi(["new-Passw0rd-long", "new-Passw0rd-long"]), cf: sb.cf(), templates: sb.templates });
    const state = sb.state();
    const after = state.workers.acc1![m.worker_name]!.secrets;
    expect(after.SESSION_SECRET).toEqual(before.SESSION_SECRET);
    expect(after.OWNER_PASSWORD_HASH!.tail).not.toBe(before.OWNER_PASSWORD_HASH!.tail);
    expect(state.calls.filter((c) => c.key === "secrets bulk")).toHaveLength(1);
    expect(JSON.stringify(state.calls)).not.toContain("new-Passw0rd-long");
    expect(existsSync(state.lastSecretsFile!)).toBe(false);
    expect(existsSync(join(sb.dir, "talorys.json"))).toBe(true);
  });
});

describe("password hashing interop", () => {
  it("hashes produced by the CLI verify with the Worker's verifier", async () => {
    const { buildOwnerSecrets } = await import("../src/secrets");
    const secrets = await buildOwnerSecrets(STRONG_PASSWORD, { includeSessionSecret: true });
    expect(await verifyPassword(STRONG_PASSWORD, secrets.OWNER_PASSWORD_HASH!)).toBe(true);
    expect(await verifyPassword("wrong-password-123", secrets.OWNER_PASSWORD_HASH!)).toBe(false);
  });
});

const SEMANTIC_PROMPT = /^Enable semantic recall\?/;

describe("installer: semantic prompt", () => {
  it("asks once on a fresh install, defaulting to No", async () => {
    const sb = makeSandbox();
    const ui = new ScriptedUi(freshAnswers());
    const m = await install({ dir: sb.dir, ...FAST }, { ui, cf: sb.cf(), fetch: fakeSite(), templates: sb.templates });
    expect(ui.prompts.filter((p) => SEMANTIC_PROMPT.test(p))).toHaveLength(1);
    expect(m.semantic).toBe(false);
    expect(readManifest(sb.dir)?.semantic).toBe(false);
    expect(workerConfig(sb.dir).env.TALORYS_SEMANTIC_DEFAULT).toBeUndefined();
    expect(ui.log.some((l) => l.includes("Semantic recall  off"))).toBe(true);
  });

  it("records a Yes in the manifest, the plan note and the Worker config", async () => {
    const sb = makeSandbox();
    const ui = new ScriptedUi(["", true, STRONG_PASSWORD, STRONG_PASSWORD, true]);
    const m = await install({ dir: sb.dir, ...FAST }, { ui, cf: sb.cf(), fetch: fakeSite(), templates: sb.templates });
    expect(ui.prompts.filter((p) => SEMANTIC_PROMPT.test(p))).toHaveLength(1);
    expect(m.semantic).toBe(true);
    expect(workerConfig(sb.dir).env.TALORYS_SEMANTIC_DEFAULT).toEqual({ type: "text", value: "on" });
    expect(ui.log.some((l) => l.includes("Semantic recall  on"))).toBe(true);
  });
});

describe("installer: semantic flags", () => {
  it("-y leaves semantic recall off without asking", async () => {
    const sb = makeSandbox();
    const ui = new ScriptedUi([], false);
    const m = await install({ dir: sb.dir, yes: true, password: STRONG_PASSWORD, ...FAST }, { ui, cf: sb.cf(), fetch: fakeSite(), templates: sb.templates });
    expect(ui.prompts).toEqual([]);
    expect(m.semantic).toBe(false);
    expect(workerConfig(sb.dir).env.TALORYS_SEMANTIC_DEFAULT).toBeUndefined();
  });

  it("-y --semantic turns it on without asking", async () => {
    const sb = makeSandbox();
    const ui = new ScriptedUi([], false);
    const m = await install({ dir: sb.dir, yes: true, semantic: true, password: STRONG_PASSWORD, ...FAST }, { ui, cf: sb.cf(), fetch: fakeSite(), templates: sb.templates });
    expect(ui.prompts).toEqual([]);
    expect(m.semantic).toBe(true);
    expect(workerConfig(sb.dir).env.TALORYS_SEMANTIC_DEFAULT).toEqual({ type: "text", value: "on" });
  });

  it("--no-semantic skips the interactive question", async () => {
    const sb = makeSandbox();
    const ui = new ScriptedUi(freshAnswers());
    const m = await install({ dir: sb.dir, semantic: false, ...FAST }, { ui, cf: sb.cf(), fetch: fakeSite(), templates: sb.templates });
    expect(ui.prompts.some((p) => SEMANTIC_PROMPT.test(p))).toBe(false);
    expect(m.semantic).toBe(false);
  });
});

describe("installer: semantic update", () => {
  it("never prompts on update and keeps the recorded value", async () => {
    const sb = makeSandbox();
    await install({ dir: sb.dir, yes: true, semantic: true, password: STRONG_PASSWORD, ...FAST }, { ui: new ScriptedUi([], false), cf: sb.cf(), fetch: fakeSite(), templates: sb.templates });
    const ui = new ScriptedUi([true]);
    const m = await install({ dir: sb.dir, mode: "update", ...FAST }, { ui, cf: sb.cf(), fetch: fakeSite(), templates: sb.templates });
    expect(ui.prompts).toEqual(["Confirm update?"]);
    expect(m.semantic).toBe(true);
    expect(workerConfig(sb.dir).env.TALORYS_SEMANTIC_DEFAULT).toEqual({ type: "text", value: "on" });
  });

  it("lets a flag on update replace the recorded value", async () => {
    const sb = makeSandbox();
    await install({ dir: sb.dir, yes: true, semantic: true, password: STRONG_PASSWORD, ...FAST }, { ui: new ScriptedUi([], false), cf: sb.cf(), fetch: fakeSite(), templates: sb.templates });
    const ui = new ScriptedUi([true]);
    const m = await install({ dir: sb.dir, mode: "update", semantic: false, ...FAST }, { ui, cf: sb.cf(), fetch: fakeSite(), templates: sb.templates });
    expect(ui.prompts).toEqual(["Confirm update?"]);
    expect(m.semantic).toBe(false);
    expect(readManifest(sb.dir)?.semantic).toBe(false);
    expect(workerConfig(sb.dir).env.TALORYS_SEMANTIC_DEFAULT).toBeUndefined();
  });

  it("treats an older manifest without the field as off and does not ask", async () => {
    const sb = makeSandbox();
    await install({ dir: sb.dir, yes: true, password: STRONG_PASSWORD, ...FAST }, { ui: new ScriptedUi([], false), cf: sb.cf(), fetch: fakeSite(), templates: sb.templates });
    const path = join(sb.dir, "talorys.json");
    const { semantic: _, ...older } = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify(older));
    const ui = new ScriptedUi([true]);
    await install({ dir: sb.dir, mode: "update", ...FAST }, { ui, cf: sb.cf(), fetch: fakeSite(), templates: sb.templates });
    expect(ui.prompts).toEqual(["Confirm update?"]);
    expect(workerConfig(sb.dir).env.TALORYS_SEMANTIC_DEFAULT).toBeUndefined();
  });
});

describe("installer: semantic compatibility", () => {
  it("no-semantic install writes the plain Worker config", async () => {
    const sb = makeSandbox();
    const m = await install({ dir: sb.dir, yes: true, semantic: false, password: STRONG_PASSWORD, ...FAST }, { ui: new ScriptedUi([], false), cf: sb.cf(), fetch: fakeSite(), templates: sb.templates });
    const upstream = toJson(
      generateWorkerConfig({
        workerName: m.worker_name,
        installationId: m.installation_id,
        version: m.deployment_version!,
        timezone: m.timezone,
        agentName: m.agent_name,
      }),
    );
    expect(readFileSync(join(sb.dir, WORKER_CONFIG), "utf8")).toBe(upstream);
  });

  it("rejects --semantic together with --no-semantic", async () => {
    const sb = makeSandbox();
    expect(await main(["--semantic", "--no-semantic", "--dir", sb.dir, "-y"])).toBe(1);
    expect(existsSync(join(sb.dir, "talorys.json"))).toBe(false);
  });
});

describe("installer: migrating a two-resource installation to a single cf-deployed Worker", () => {
  const update = (sb: ReturnType<typeof makeSandbox>, ui = new ScriptedUi([true]), site = fakeSite()) =>
    install({ dir: sb.dir, mode: "update", ...FAST }, { ui, cf: sb.cf(), fetch: site, templates: sb.templates });

  it("redeploys the same Worker with the web app, keeping its Durable Object, data and secrets", async () => {
    const sb = makeSandbox();
    const legacy = makeLegacyInstallation(sb);
    const secretsBefore = sb.state().workers.acc1![legacy.workerName]!.secrets;
    writeFileSync(join(sb.dir, "web", "my-notes.txt"), "mine");

    const ui = new ScriptedUi([true]);
    const m = await update(sb, ui);

    const state = sb.state();
    // Same Worker (and so the same Durable Object namespace): no new Worker, no password prompt, no secret upload.
    expect(Object.keys(state.workers.acc1!)).toEqual([legacy.workerName]);
    const worker = state.workers.acc1![legacy.workerName]!;
    expect(worker.durableObjectData).toBe("legacy-owner-data");
    expect(worker.secrets).toEqual(secretsBefore);
    // The Wrangler v1 migration history stays; cf declares the same class with exports.
    expect(worker.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["TalorysAgent"] }]);
    expect(worker.exports).toEqual({ TalorysAgent: { type: "durable-object", storage: "sqlite" } });
    expect(worker.workers_dev).toBe(true);
    expect(worker.assets).toMatchObject({ runWorkerFirst: ["/api/*"] });
    expect(state.calls.some((c) => c.key === "secrets bulk")).toBe(false);
    expect(state.calls.find((c) => c.key === "deploy")!.args).not.toContain("--secrets-file");
    expect(ui.prompts).toEqual(["Confirm update?"]);
    expect(ui.log.some((l) => l.includes(`Moving from    Pages project ${legacy.pagesProjectName}`))).toBe(true);

    // The manifest now points at the Worker; the old project is only remembered.
    expect(m.status).toBe("deployed");
    expect(m.worker_name).toBe(legacy.workerName);
    expect(m.public_url).toBe(`https://${legacy.workerName}.owner.workers.dev`);
    expect(m.pages_project_name).toBe(legacy.pagesProjectName);
    expect(m.migrated_to_worker_at).toEqual(expect.any(String));

    // The installer never touches (let alone deletes) the Pages project; it tells the owner how to.
    expect(state.calls.some((c) => c.key.startsWith("pages") || c.args[0] === "pages")).toBe(false);
    expect(state.pages.acc1![legacy.pagesProjectName]!.deployments).toBe(3);
    expect(ui.log.some((l) => l.startsWith("warn:") && l.includes(`npx cf pages delete ${legacy.pagesProjectName}`))).toBe(true);
    expect(ui.log.some((l) => l.includes("Talorys has moved to this address"))).toBe(true);

    // Old generated files are gone; anything the owner added is kept.
    expect(existsSync(join(sb.dir, "agent"))).toBe(false);
    expect(existsSync(join(sb.dir, "web", "functions"))).toBe(false);
    expect(existsSync(join(sb.dir, "web", "dist"))).toBe(false);
    expect(readFileSync(join(sb.dir, "web", "my-notes.txt"), "utf8")).toBe("mine");
    expect(readFileSync(join(sb.dir, "README.md"), "utf8")).toContain(`npx cf pages delete ${legacy.pagesProjectName}`);
  });

  it("only announces the move once", async () => {
    const sb = makeSandbox();
    makeLegacyInstallation(sb);
    const first = await update(sb);
    const ui = new ScriptedUi([true]);
    const second = await update(sb, ui);
    expect(second.migrated_to_worker_at).toBe(first.migrated_to_worker_at);
    expect(ui.log.some((l) => l.includes("Moving from"))).toBe(false);
    expect(ui.log.some((l) => l.includes("Talorys has moved"))).toBe(false);
  });

  it("is not marked migrated when the Worker fails its health checks (the old site keeps working)", async () => {
    const sb = makeSandbox();
    const legacy = makeLegacyInstallation(sb);
    const error = await update(sb, new ScriptedUi([true]), fakeSite({ healthy: false })).catch((e) => e);
    expect(error).toBeInstanceOf(CliError);
    expect(readManifest(sb.dir)?.migrated_to_worker_at).toBeUndefined();
    expect(sb.state().pages.acc1![legacy.pagesProjectName]!.services).toEqual([{ binding: "AGENT", service: legacy.workerName }]);
  });
});
