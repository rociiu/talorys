import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyPassword } from "@talorys/shared/crypto";
import { allocateNames, install, resetPassword } from "../src/install";
import { readManifest } from "../src/manifest";
import { CliError } from "../src/errors";
import { generateAgentConfig, toJsonc } from "../src/config";
import { main } from "../src/cli";
import { fakeSite, makeSandbox, makeTemplates, ScriptedUi, STRONG_PASSWORD } from "./helpers";

const FAST = { verifyTimeoutMs: 2000 };

function freshAnswers() {
  return ["", STRONG_PASSWORD, STRONG_PASSWORD, true]; // name (default), password, confirm, confirm deploy
}

describe("installer: fresh installation", () => {
  it("provisions everything and reports the real pages.dev URL", async () => {
    const sb = makeSandbox({ subdomainSuffix: "-x7" });
    const ui = new ScriptedUi(freshAnswers());
    const manifest = await install({ dir: sb.dir, ...FAST }, { ui, wrangler: sb.wrangler(), fetch: fakeSite(), templates: sb.templates });

    const state = sb.state();
    const worker = state.workers.acc1![manifest.worker_name]!;
    expect(worker.workers_dev).toBe(false);
    expect(worker.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["TalorysAgent"] }]);
    expect(Object.keys(worker.secrets).sort()).toEqual(["OWNER_PASSWORD_HASH", "SESSION_SECRET", "VAPID_PRIVATE_KEY", "VAPID_PUBLIC_KEY"]);
    expect(worker.secrets.VAPID_PUBLIC_KEY!.length).toBe(87);
    expect(worker.secrets.OWNER_PASSWORD_HASH!.prefix).toBe("pbkdf2-sha256$");
    expect(worker.secrets.SESSION_SECRET!.length).toBeGreaterThanOrEqual(43);
    // URL comes from Cloudflare (note the suffix the fake account assigned), not from the project name.
    expect(manifest.public_url).toBe(`https://${manifest.pages_project_name}-x7.pages.dev`);
    expect(manifest.status).toBe("deployed");
    expect(manifest.worker_name).toMatch(/^talorys-[a-z0-9]{8}-agent$/);
    expect(manifest.pages_project_name).toBe(manifest.worker_name.replace(/-agent$/, "-web"));

    // Worker is deployed before Pages, and secrets before verification.
    const keys = state.calls.map((c) => c.key);
    expect(keys.indexOf("deploy")).toBeLessThan(keys.indexOf("pages deploy"));
    expect(keys.indexOf("secret bulk")).toBeLessThan(keys.indexOf("pages deploy"));

    // Generated configs: service binding + private worker.
    const pagesCfg = readFileSync(join(sb.dir, "web/wrangler.jsonc"), "utf8");
    expect(pagesCfg).toContain(`"service": "${manifest.worker_name}"`);
    expect(pagesCfg).toContain(`"binding": "AGENT"`);
    expect(ui.log.some((l) => l.includes("Talorys is ready"))).toBe(true);
  });

  it("never writes secrets or the password to disk", async () => {
    const sb = makeSandbox();
    await install({ dir: sb.dir, ...FAST }, { ui: new ScriptedUi(freshAnswers()), wrangler: sb.wrangler(), fetch: fakeSite(), templates: sb.templates });
    for (const f of ["talorys.json", "agent/wrangler.jsonc", "web/wrangler.jsonc", "README.md"]) {
      const text = readFileSync(join(sb.dir, f), "utf8");
      expect(text).not.toContain(STRONG_PASSWORD);
      expect(text).not.toMatch(/pbkdf2-sha256\$/);
    }
    expect(JSON.stringify(sb.state().calls)).not.toContain(STRONG_PASSWORD);
  });

  it("rejects weak passwords from the environment", async () => {
    const sb = makeSandbox();
    await expect(
      install({ dir: sb.dir, yes: true, password: "short", ...FAST }, { ui: new ScriptedUi([], false), wrangler: sb.wrangler(), fetch: fakeSite(), templates: sb.templates }),
    ).rejects.toThrow(/too weak/);
  });

  it("asks which account to use when several exist", async () => {
    const sb = makeSandbox({ accounts: [{ id: "acc1", name: "Personal Account" }, { id: "acc2", name: "Work" }] });
    const ui = new ScriptedUi(["", "Work", STRONG_PASSWORD, STRONG_PASSWORD, true]);
    const m = await install({ dir: sb.dir, ...FAST }, { ui, wrangler: sb.wrangler(), fetch: fakeSite(), templates: sb.templates });
    expect(m.account_id).toBe("acc2");
    expect(sb.state().workers.acc2?.[m.worker_name]).toBeDefined();
    expect(ui.prompts).toContain("Choose your Cloudflare account");
  });

  it("logs in through the browser flow when not authenticated", async () => {
    const sb = makeSandbox({ loggedIn: false });
    await install({ dir: sb.dir, ...FAST }, { ui: new ScriptedUi(freshAnswers()), wrangler: sb.wrangler(), fetch: fakeSite(), templates: sb.templates });
    expect(sb.state().calls.some((c) => c.key === "login")).toBe(true);
  });

  it("fails clearly without credentials in non-interactive mode", async () => {
    const sb = makeSandbox({ loggedIn: false });
    const saved = process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CLOUDFLARE_API_TOKEN;
    await expect(
      install({ dir: sb.dir, yes: true, password: STRONG_PASSWORD, ...FAST }, { ui: new ScriptedUi([], false), wrangler: sb.wrangler(), fetch: fakeSite(), templates: sb.templates }),
    ).rejects.toThrow(/Not authenticated/);
    if (saved) process.env.CLOUDFLARE_API_TOKEN = saved;
  });

  it("refuses to overwrite an unrelated non-empty directory", async () => {
    const sb = makeSandbox();
    mkdirSync(sb.dir, { recursive: true });
    writeFileSync(join(sb.dir, "notes.txt"), "mine");
    await expect(
      install({ dir: sb.dir, ...FAST }, { ui: new ScriptedUi(freshAnswers()), wrangler: sb.wrangler(), fetch: fakeSite(), templates: sb.templates }),
    ).rejects.toThrow(/not a Talorys installation/);
    expect(readFileSync(join(sb.dir, "notes.txt"), "utf8")).toBe("mine");
  });

  it("does not deploy when the owner declines the confirmation", async () => {
    const sb = makeSandbox();
    await expect(
      install({ dir: sb.dir, ...FAST }, { ui: new ScriptedUi(["", STRONG_PASSWORD, STRONG_PASSWORD, false]), wrangler: sb.wrangler(), fetch: fakeSite(), templates: sb.templates }),
    ).rejects.toThrow(/cancelled/i);
    expect(sb.state().calls.some((c) => c.key === "deploy")).toBe(false);
  });
});

describe("installer: idempotency and recovery", () => {
  it("a repeated installation reconciles without re-prompting or touching data", async () => {
    const sb = makeSandbox();
    const first = await install({ dir: sb.dir, ...FAST }, { ui: new ScriptedUi(freshAnswers()), wrangler: sb.wrangler(), fetch: fakeSite(), templates: sb.templates });
    const secretsBefore = sb.state().workers.acc1![first.worker_name]!.secrets;

    const ui = new ScriptedUi([true]); // only the confirmation prompt
    const second = await install({ dir: sb.dir, ...FAST }, { ui, wrangler: sb.wrangler(), fetch: fakeSite(), templates: sb.templates });

    const state = sb.state();
    expect(second.installation_id).toBe(first.installation_id);
    expect(Object.keys(state.pages.acc1!)).toHaveLength(1);
    expect(Object.keys(state.workers.acc1!)).toHaveLength(1);
    expect(state.workers.acc1![first.worker_name]!.secrets).toEqual(secretsBefore);
    expect(state.workers.acc1![first.worker_name]!.durableObjectData).toBe("owner-data");
    expect(state.calls.filter((c) => c.key === "secret bulk")).toHaveLength(1);
    expect(state.calls.filter((c) => c.key === "pages project create")).toHaveLength(1);
    expect(ui.prompts).toEqual(["Confirm update?"]);
  });

  it("resumes after an interrupted deployment without duplicating resources", async () => {
    const sb = makeSandbox();
    sb.update((s) => (s.failNext = { "pages deploy": "Network connection lost: fetch failed" }));
    const error = await install({ dir: sb.dir, ...FAST }, { ui: new ScriptedUi(freshAnswers()), wrangler: sb.wrangler(), fetch: fakeSite(), templates: sb.templates }).catch((e) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toMatch(/network error/);
    expect(readManifest(sb.dir)?.status).toBe("failed");
    expect(readManifest(sb.dir)?.steps).toEqual(["scaffold", "worker", "secrets"]);

    const resumed = await install({ dir: sb.dir, yes: true, ...FAST }, { ui: new ScriptedUi([]), wrangler: sb.wrangler(), fetch: fakeSite(), templates: sb.templates });
    expect(resumed.status).toBe("deployed");
    const state = sb.state();
    expect(Object.keys(state.pages.acc1!)).toHaveLength(1);
    expect(state.calls.filter((c) => c.key === "secret bulk")).toHaveLength(1);
  });

  it("re-prompts for the password only if the earlier run died before storing it", async () => {
    const sb = makeSandbox();
    sb.update((s) => (s.failNext = { "secret bulk": "Network connection lost: fetch failed" }));
    await install({ dir: sb.dir, ...FAST }, { ui: new ScriptedUi(freshAnswers()), wrangler: sb.wrangler(), fetch: fakeSite(), templates: sb.templates }).catch(() => {});
    const ui = new ScriptedUi([STRONG_PASSWORD, STRONG_PASSWORD, true]);
    const m = await install({ dir: sb.dir, ...FAST }, { ui, wrangler: sb.wrangler(), fetch: fakeSite(), templates: sb.templates });
    expect(m.status).toBe("deployed");
    expect(Object.keys(sb.state().workers.acc1![m.worker_name]!.secrets)).toHaveLength(4);
  });

  it("waits for propagation and succeeds once the site responds", async () => {
    const sb = makeSandbox();
    const site = fakeSite({ failFirst: 4 });
    const m = await install({ dir: sb.dir, verifyTimeoutMs: 30_000 }, { ui: new ScriptedUi(freshAnswers()), wrangler: sb.wrangler(), fetch: site, templates: sb.templates });
    expect(m.status).toBe("deployed");
    expect(site.calls.length).toBeGreaterThan(4);
  }, 60_000);

  it("never prints success when health checks fail", async () => {
    const sb = makeSandbox();
    const ui = new ScriptedUi(freshAnswers());
    const error = await install({ dir: sb.dir, ...FAST }, { ui, wrangler: sb.wrangler(), fetch: fakeSite({ healthy: false }), templates: sb.templates }).catch((e) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).details).toMatch(/Owner secrets are not configured/);
    expect(ui.log.some((l) => l.includes("is ready"))).toBe(false);
    expect(readManifest(sb.dir)?.status).toBe("failed");
  });

  it("explains missing permissions", async () => {
    const sb = makeSandbox();
    sb.update((s) => (s.failNext = { deploy: "A request to the Cloudflare API failed. Authentication error [code: 10000]" }));
    const error = await install({ dir: sb.dir, ...FAST }, { ui: new ScriptedUi(freshAnswers()), wrangler: sb.wrangler(), fetch: fakeSite(), templates: sb.templates }).catch((e) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toMatch(/rejected the credentials/);
    expect((error as CliError).hint).toMatch(/Workers and Pages/);
  });

  it("avoids resource names that already exist in the account", async () => {
    const sb = makeSandbox();
    sb.update((s) => {
      s.pages.acc1 = { "talorys-aaaaaaaa-web": { subdomain: "talorys-aaaaaaaa-web.pages.dev", deployments: 1 } };
      s.workers.acc1 = { "talorys-bbbbbbbb-agent": { secrets: {}, migrations: [], workers_dev: true, vars: {}, deploys: 1, durableObjectData: "someone-else" } };
    });
    const ids = ["aaaaaaaa", "bbbbbbbb", "cccccccc"];
    const names = await allocateNames(sb.wrangler(), 5, () => ids.shift()!);
    expect(names.installationId).toBe("cccccccc");
  });
});

describe("installer: upgrades and password reset", () => {
  it("updates code and version without losing data or secrets", async () => {
    const sb = makeSandbox();
    const first = await install({ dir: sb.dir, ...FAST }, { ui: new ScriptedUi(freshAnswers()), wrangler: sb.wrangler(), fetch: fakeSite(), templates: sb.templates });
    const secretsBefore = sb.state().workers.acc1![first.worker_name]!.secrets;
    const v2 = makeTemplates(sb.root, "0.2.0");
    const updated = await install({ dir: sb.dir, mode: "update", yes: true, ...FAST }, { ui: new ScriptedUi([]), wrangler: sb.wrangler(), fetch: fakeSite(), templates: v2 });
    const worker = sb.state().workers.acc1![first.worker_name]!;
    expect(updated.deployment_version).toBe("0.2.0");
    expect(worker.vars.TALORYS_DEPLOYED_VERSION).toBe("0.2.0");
    expect(worker.deploys).toBe(2);
    expect(worker.secrets).toEqual(secretsBefore);
    expect(worker.durableObjectData).toBe("owner-data");
    expect(readFileSync(join(sb.dir, "agent/worker.js"), "utf8")).toContain("0.2.0");
  });

  it("adds push keys to an older installation without touching its other secrets", async () => {
    const sb = makeSandbox();
    const first = await install({ dir: sb.dir, ...FAST }, { ui: new ScriptedUi(freshAnswers()), wrangler: sb.wrangler(), fetch: fakeSite(), templates: sb.templates });
    sb.update((s) => {
      const secrets = s.workers.acc1![first.worker_name]!.secrets;
      delete secrets.VAPID_PUBLIC_KEY;
      delete secrets.VAPID_PRIVATE_KEY;
    });
    const before = sb.state().workers.acc1![first.worker_name]!.secrets;
    const ui = new ScriptedUi([]);
    await install({ dir: sb.dir, mode: "update", yes: true, ...FAST }, { ui, wrangler: sb.wrangler(), fetch: fakeSite(), templates: sb.templates });
    const after = sb.state().workers.acc1![first.worker_name]!.secrets;
    expect(after.OWNER_PASSWORD_HASH).toEqual(before.OWNER_PASSWORD_HASH);
    expect(after.SESSION_SECRET).toEqual(before.SESSION_SECRET);
    expect(Object.keys(after).sort()).toEqual(["OWNER_PASSWORD_HASH", "SESSION_SECRET", "VAPID_PRIVATE_KEY", "VAPID_PUBLIC_KEY"]);
    expect(ui.prompts).toEqual([]);
  });

  it("update requires an existing installation", async () => {
    const sb = makeSandbox();
    await expect(
      install({ dir: sb.dir, mode: "update", yes: true, ...FAST }, { ui: new ScriptedUi([]), wrangler: sb.wrangler(), fetch: fakeSite(), templates: sb.templates }),
    ).rejects.toThrow(/No Talorys installation/);
  });

  it("reset-password replaces only the password hash", async () => {
    const sb = makeSandbox();
    const m = await install({ dir: sb.dir, ...FAST }, { ui: new ScriptedUi(freshAnswers()), wrangler: sb.wrangler(), fetch: fakeSite(), templates: sb.templates });
    const before = sb.state().workers.acc1![m.worker_name]!.secrets;
    await resetPassword({ dir: sb.dir }, { ui: new ScriptedUi(["new-Passw0rd-long", "new-Passw0rd-long"]), wrangler: sb.wrangler(), templates: sb.templates });
    const after = sb.state().workers.acc1![m.worker_name]!.secrets;
    expect(after.SESSION_SECRET).toEqual(before.SESSION_SECRET);
    expect(sb.state().calls.filter((c) => c.key === "secret bulk")).toHaveLength(2);
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

describe("push key generation", () => {
  it("produces a P-256 pair the Worker can sign with and browsers can verify", async () => {
    const { webcrypto } = await import("node:crypto");
    const { generatePushKeys } = await import("../src/secrets");
    const keys = await generatePushKeys();
    const point = Buffer.from(keys.VAPID_PUBLIC_KEY, "base64url");
    expect(point.length).toBe(65);
    expect(point[0]).toBe(4);
    const jwk = { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url"), d: keys.VAPID_PRIVATE_KEY };
    const signer = await webcrypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const verifier = await webcrypto.subtle.importKey("raw", point, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const data = new TextEncoder().encode("vapid");
    const sig = await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signer, data);
    expect(await webcrypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifier, sig, data)).toBe(true);
    expect((await generatePushKeys()).VAPID_PRIVATE_KEY).not.toBe(keys.VAPID_PRIVATE_KEY);
  });
});

const SEMANTIC_PROMPT = /^Enable semantic recall\?/;

describe("installer: semantic prompt", () => {
  it("asks once on a fresh install, defaulting to No", async () => {
    const sb = makeSandbox();
    const ui = new ScriptedUi(freshAnswers());
    const m = await install({ dir: sb.dir, ...FAST }, { ui, wrangler: sb.wrangler(), fetch: fakeSite(), templates: sb.templates });
    expect(ui.prompts.filter((p) => SEMANTIC_PROMPT.test(p))).toHaveLength(1);
    expect(m.semantic).toBe(false);
    expect(readManifest(sb.dir)?.semantic).toBe(false);
    expect(readFileSync(join(sb.dir, "agent/wrangler.jsonc"), "utf8")).not.toContain("TALORYS_SEMANTIC_DEFAULT");
    expect(ui.log.some((l) => l.includes("Semantic recall  off"))).toBe(true);
  });

  it("records a Yes in the manifest, the plan note and the agent config", async () => {
    const sb = makeSandbox();
    const ui = new ScriptedUi(["", true, STRONG_PASSWORD, STRONG_PASSWORD, true]);
    const m = await install({ dir: sb.dir, ...FAST }, { ui, wrangler: sb.wrangler(), fetch: fakeSite(), templates: sb.templates });
    expect(ui.prompts.filter((p) => SEMANTIC_PROMPT.test(p))).toHaveLength(1);
    expect(m.semantic).toBe(true);
    expect(readFileSync(join(sb.dir, "agent/wrangler.jsonc"), "utf8")).toContain(`"TALORYS_SEMANTIC_DEFAULT": "on"`);
    expect(ui.log.some((l) => l.includes("Semantic recall  on"))).toBe(true);
  });
});

describe("installer: semantic flags", () => {
  it("-y leaves semantic recall off without asking", async () => {
    const sb = makeSandbox();
    const ui = new ScriptedUi([], false);
    const m = await install({ dir: sb.dir, yes: true, password: STRONG_PASSWORD, ...FAST }, { ui, wrangler: sb.wrangler(), fetch: fakeSite(), templates: sb.templates });
    expect(ui.prompts).toEqual([]);
    expect(m.semantic).toBe(false);
    expect(readFileSync(join(sb.dir, "agent/wrangler.jsonc"), "utf8")).not.toContain("TALORYS_SEMANTIC_DEFAULT");
  });

  it("-y --semantic turns it on without asking", async () => {
    const sb = makeSandbox();
    const ui = new ScriptedUi([], false);
    const m = await install({ dir: sb.dir, yes: true, semantic: true, password: STRONG_PASSWORD, ...FAST }, { ui, wrangler: sb.wrangler(), fetch: fakeSite(), templates: sb.templates });
    expect(ui.prompts).toEqual([]);
    expect(m.semantic).toBe(true);
    expect(readFileSync(join(sb.dir, "agent/wrangler.jsonc"), "utf8")).toContain(`"TALORYS_SEMANTIC_DEFAULT": "on"`);
  });

  it("--no-semantic skips the interactive question", async () => {
    const sb = makeSandbox();
    const ui = new ScriptedUi(freshAnswers());
    const m = await install({ dir: sb.dir, semantic: false, ...FAST }, { ui, wrangler: sb.wrangler(), fetch: fakeSite(), templates: sb.templates });
    expect(ui.prompts.some((p) => SEMANTIC_PROMPT.test(p))).toBe(false);
    expect(m.semantic).toBe(false);
  });
});

describe("installer: semantic update", () => {
  it("never prompts on update and keeps the recorded value", async () => {
    const sb = makeSandbox();
    await install({ dir: sb.dir, yes: true, semantic: true, password: STRONG_PASSWORD, ...FAST }, { ui: new ScriptedUi([], false), wrangler: sb.wrangler(), fetch: fakeSite(), templates: sb.templates });
    const ui = new ScriptedUi([true]);
    const m = await install({ dir: sb.dir, mode: "update", ...FAST }, { ui, wrangler: sb.wrangler(), fetch: fakeSite(), templates: sb.templates });
    expect(ui.prompts).toEqual(["Confirm update?"]);
    expect(m.semantic).toBe(true);
    expect(readFileSync(join(sb.dir, "agent/wrangler.jsonc"), "utf8")).toContain(`"TALORYS_SEMANTIC_DEFAULT": "on"`);
  });

  it("lets a flag on update replace the recorded value", async () => {
    const sb = makeSandbox();
    await install({ dir: sb.dir, yes: true, semantic: true, password: STRONG_PASSWORD, ...FAST }, { ui: new ScriptedUi([], false), wrangler: sb.wrangler(), fetch: fakeSite(), templates: sb.templates });
    const ui = new ScriptedUi([true]);
    const m = await install({ dir: sb.dir, mode: "update", semantic: false, ...FAST }, { ui, wrangler: sb.wrangler(), fetch: fakeSite(), templates: sb.templates });
    expect(ui.prompts).toEqual(["Confirm update?"]);
    expect(m.semantic).toBe(false);
    expect(readManifest(sb.dir)?.semantic).toBe(false);
    expect(readFileSync(join(sb.dir, "agent/wrangler.jsonc"), "utf8")).not.toContain("TALORYS_SEMANTIC_DEFAULT");
  });

  it("treats an older manifest without the field as off and does not ask", async () => {
    const sb = makeSandbox();
    await install({ dir: sb.dir, yes: true, password: STRONG_PASSWORD, ...FAST }, { ui: new ScriptedUi([], false), wrangler: sb.wrangler(), fetch: fakeSite(), templates: sb.templates });
    const path = join(sb.dir, "talorys.json");
    const { semantic: _, ...older } = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify(older));
    const ui = new ScriptedUi([true]);
    await install({ dir: sb.dir, mode: "update", ...FAST }, { ui, wrangler: sb.wrangler(), fetch: fakeSite(), templates: sb.templates });
    expect(ui.prompts).toEqual(["Confirm update?"]);
    expect(readFileSync(join(sb.dir, "agent/wrangler.jsonc"), "utf8")).not.toContain("TALORYS_SEMANTIC_DEFAULT");
  });
});

describe("installer: semantic compatibility", () => {
  it("no-semantic install writes upstream wrangler.jsonc", async () => {
    const sb = makeSandbox();
    const m = await install({ dir: sb.dir, yes: true, semantic: false, password: STRONG_PASSWORD, ...FAST }, { ui: new ScriptedUi([], false), wrangler: sb.wrangler(), fetch: fakeSite(), templates: sb.templates });
    const upstream = toJsonc(
      generateAgentConfig({
        workerName: m.worker_name,
        installationId: m.installation_id,
        version: m.deployment_version!,
        timezone: m.timezone,
        agentName: m.agent_name,
      }),
    );
    expect(readFileSync(join(sb.dir, "agent/wrangler.jsonc"), "utf8")).toBe(upstream);
  });

  it("rejects --semantic together with --no-semantic", async () => {
    const sb = makeSandbox();
    expect(await main(["--semantic", "--no-semantic", "--dir", sb.dir, "-y"])).toBe(1);
    expect(existsSync(join(sb.dir, "talorys.json"))).toBe(false);
  });
});
