import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ASSETS_CONFIG, DO_EXPORTS, generateBuildOutputConfig, generateInstallationId, generateWorkerConfig, resourceNames } from "../src/config";
import { CliError, sanitize, explainCfFailure } from "../src/errors";
import { checkNodeVersion, MIN_NODE } from "../src/requirements";
import { writeManifest, type Manifest } from "../src/manifest";
import { parseDeployResult, parseJsonOutput } from "../src/cf";
import { runChecks } from "../src/verify";
import { fakeSite, makeSandbox } from "./helpers";

const stripJsonc = (s: string) => JSON.parse(s.replace(/^\s*\/\/.*$/gm, ""));

describe("configuration generation", () => {
  it("generates DNS-safe, collision-resistant installation ids", () => {
    const ids = new Set(Array.from({ length: 2000 }, () => generateInstallationId()));
    expect(ids.size).toBe(2000);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9]{7}$/);
  });

  it("derives predictable resource names", () => {
    expect(resourceNames("abcd1234")).toEqual({ installationId: "abcd1234", workerName: "talorys-abcd1234" });
    expect(() => resourceNames("../x")).toThrow();
  });

  it("one Worker serves the web app and API, with AI and a SQLite DO declared through exports", () => {
    const cfg = generateWorkerConfig({ workerName: "w", installationId: "abcd1234", version: "1", timezone: "Europe/Paris", agentName: "Ada" }) as Record<string, any>;
    expect(cfg.workersDev).toBe(true);
    expect(cfg.previewUrls).toBe(false);
    expect(cfg.assets).toEqual({ notFoundHandling: "single-page-application", runWorkerFirst: ["/api/*"] });
    expect(cfg.env.AI).toEqual({ type: "ai" });
    expect(cfg.env.TalorysAgent).toEqual({ type: "durable-object", worker: "w", exportName: "TalorysAgent" });
    expect(cfg.exports).toEqual({ TalorysAgent: { type: "durable-object", storage: "sqlite" } });
    // Never a state on the class: an explicit "deleted" is how cf deletes a namespace and its data.
    expect(JSON.stringify(cfg.exports)).not.toContain("state");
    expect(cfg.migrations).toBeUndefined();
    expect(cfg.compatibilityFlags).toContain("nodejs_compat");
    expect(cfg.env.TALORYS_DEFAULT_TIMEZONE).toEqual({ type: "text", value: "Europe/Paris" });
    expect(cfg.manifest).toEqual({ type: "partial", mainModule: "worker.js", modules: {} });
    // Secrets are never declared: cf keeps existing ones, and a declared secret would be required on first deploy.
    expect(JSON.stringify(cfg)).not.toMatch(/SECRET|PASSWORD|"secret"/);
  });

  it("pins the Build Output to the installation's account", () => {
    expect(generateBuildOutputConfig({ accountId: "acc1" })).toEqual({ accountId: "acc1", buildContext: { isPreview: false } });
  });

  it("the Durable Object class and asset routing match the development config", () => {
    const dev = stripJsonc(readFileSync(join(__dirname, "../../../apps/agent/wrangler.jsonc"), "utf8"));
    expect(dev.exports).toEqual(DO_EXPORTS);
    expect(dev.migrations).toBeUndefined();
    expect(dev.assets.not_found_handling).toBe(ASSETS_CONFIG.notFoundHandling);
    expect(dev.assets.run_worker_first).toEqual(ASSETS_CONFIG.runWorkerFirst);
  });
});

describe("manifest", () => {
  it("refuses to persist anything that looks like a secret", () => {
    const sb = makeSandbox();
    const m = { installation_id: "abcd1234", account_id: "a", worker_name: "w", pages_project_name: "p", agent_name: "pbkdf2-sha256$1$x$y" } as unknown as Manifest;
    expect(() => writeManifest(sb.root, m)).toThrow(/secrets/);
  });
});

describe("cf output handling", () => {
  it("parses JSON surrounded by warnings", () => {
    expect(parseJsonOutput<{ a: number }>('▲ [WARNING] proxy\n{"a":1}\n')).toEqual({ a: 1 });
    expect(parseJsonOutput<number[]>("[1,2]")).toEqual([1, 2]);
  });

  it("redacts credentials and strips cf's frames from error details", () => {
    expect(sanitize("Error: token=abc123 failed\napi_key: xyz")).not.toMatch(/abc123|xyz/);
    expect(sanitize("┌ APIError\n│ [10007] This Worker does not exist on your account.\n└")).toBe("APIError\n[10007] This Worker does not exist on your account.");
  });

  it("classifies common failures with recovery hints", () => {
    expect(explainCfFailure("X", "fetch failed ETIMEDOUT").message).toMatch(/network/);
    expect(explainCfFailure("X", "│ [10001] forbidden").hint).toMatch(/Workers Scripts:Edit/);
    expect(explainCfFailure("X", "│ [10000] Authentication error").message).toMatch(/rejected the credentials/);
    expect(explainCfFailure("X", "Aborting the upload operation because of conflicts…\n◆  Deploy complete").message).toMatch(/changed outside the installer/);
    expect(explainCfFailure("X", "Durable Object exports reconciliation failed: …").hint).toMatch(/data was not changed/);
    expect(explainCfFailure("X", "More than one account available but unable to select one in non-interactive mode").hint).toMatch(/--account-id/);
  });

  it("reads the deploy record cf writes to WRANGLER_OUTPUT_FILE_PATH", () => {
    const ndjson = `{"type":"session"}\n{"type":"deploy","version":1,"version_id":"v-1","targets":["https://W.Sub.workers.dev","example.com/*"]}\n`;
    expect(parseDeployResult("", ndjson)).toEqual({ versionId: "v-1", url: "https://w.sub.workers.dev" });
    // Falls back to the human output when no record was written.
    expect(parseDeployResult("│  Deployed w triggers\n│    https://w.sub.workers.dev\n│  Current Version ID: 11111111-2222-3333-4444-555555555555", "")).toEqual({
      versionId: "11111111-2222-3333-4444-555555555555",
      url: "https://w.sub.workers.dev",
    });
    expect(parseDeployResult("No targets deployed", "").url).toBeNull();
  });
});

describe("post-deploy verification", () => {
  it("passes against a healthy deployment", async () => {
    const checks = await runChecks("https://x.owner.workers.dev", fakeSite());
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks).toHaveLength(4);
  });

  it("flags a backend that accepts anonymous private requests", async () => {
    const open = (async (url: string) =>
      new URL(url).pathname === "/api/tasks" ? Response.json({ tasks: [] }) : fakeSite()(url)) as typeof fetch;
    const checks = await runChecks("https://x.owner.workers.dev", open);
    expect(checks.find((c) => c.name.includes("anonymous"))?.ok).toBe(false);
  });
});

describe("semantic recall default", () => {
  const base = { workerName: "w", installationId: "abcd1234", version: "1", timezone: "UTC", agentName: "Ada" };

  it("adds only TALORYS_SEMANTIC_DEFAULT when enabled and leaves upstream vars untouched otherwise", () => {
    const upstream = generateWorkerConfig(base);
    expect(generateWorkerConfig({ ...base, semanticDefault: false })).toEqual(upstream);
    const on = generateWorkerConfig({ ...base, semanticDefault: true });
    expect(on.env).toEqual({ ...(upstream.env as Record<string, unknown>), TALORYS_SEMANTIC_DEFAULT: { type: "text", value: "on" } });
    expect({ ...on, env: upstream.env }).toEqual(upstream);
  });
});

describe("requirements", () => {
  it("requires at least the Node.js version the bundled cf needs", () => {
    const cfPkg = JSON.parse(readFileSync(join(__dirname, "../../../node_modules/cf/package.json"), "utf8"));
    const [major = 0, minor = 0] = String(cfPkg.engines.node).replace(/^>=\s*/, "").split(".").map(Number);
    expect(MIN_NODE[0] > major || (MIN_NODE[0] === major && MIN_NODE[1] >= minor)).toBe(true);
    expect(() => checkNodeVersion("20.18.0")).toThrow(CliError);
    expect(() => checkNodeVersion("22.0.0")).not.toThrow();
  });
});
