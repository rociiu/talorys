import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DO_MIGRATIONS, generateAgentConfig, generateInstallationId, generatePagesConfig, resourceNames, toJsonc } from "../src/config";
import { CliError, sanitize, explainWranglerFailure } from "../src/errors";
import { checkNodeVersion, MIN_NODE } from "../src/requirements";
import { writeManifest, type Manifest } from "../src/manifest";
import { parseJsonOutput, Wrangler } from "../src/wrangler";
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
    expect(resourceNames("abcd1234")).toEqual({
      installationId: "abcd1234",
      workerName: "talorys-abcd1234-agent",
      pagesProjectName: "talorys-abcd1234-web",
    });
    expect(() => resourceNames("../x")).toThrow();
  });

  it("agent Worker is private, has AI, a SQLite DO and append-only migrations", () => {
    const cfg = stripJsonc(toJsonc(generateAgentConfig({ workerName: "w", installationId: "abcd1234", version: "1", timezone: "Europe/Paris", agentName: "Ada" })));
    expect(cfg.workers_dev).toBe(false);
    expect(cfg.preview_urls).toBe(false);
    expect(cfg.ai).toEqual({ binding: "AI" });
    expect(cfg.durable_objects.bindings).toEqual([{ name: "TalorysAgent", class_name: "TalorysAgent" }]);
    expect(cfg.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["TalorysAgent"] }]);
    expect(cfg.compatibility_flags).toContain("nodejs_compat");
    expect(cfg.vars.TALORYS_DEFAULT_TIMEZONE).toBe("Europe/Paris");
    expect(JSON.stringify(cfg)).not.toMatch(/SECRET|PASSWORD/);
  });

  it("migrations match the agent's development config", () => {
    const dev = stripJsonc(readFileSync(join(__dirname, "../../../apps/agent/wrangler.jsonc"), "utf8"));
    expect(dev.migrations).toEqual(DO_MIGRATIONS);
    expect(dev.workers_dev).toBe(false);
  });

  it("Pages config binds the private Worker", () => {
    const cfg = stripJsonc(toJsonc(generatePagesConfig({ pagesProjectName: "p", workerName: "w" })));
    expect(cfg).toMatchObject({ name: "p", pages_build_output_dir: "./dist", services: [{ binding: "AGENT", service: "w" }] });
  });
});

describe("manifest", () => {
  it("refuses to persist anything that looks like a secret", () => {
    const sb = makeSandbox();
    const m = { installation_id: "abcd1234", account_id: "a", worker_name: "w", pages_project_name: "p", agent_name: "pbkdf2-sha256$1$x$y" } as unknown as Manifest;
    expect(() => writeManifest(sb.root, m)).toThrow(/secrets/);
  });
});

describe("wrangler output handling", () => {
  it("parses JSON surrounded by warnings", () => {
    expect(parseJsonOutput<{ a: number }>('▲ [WARNING] proxy\n{"a":1}\n')).toEqual({ a: 1 });
    expect(parseJsonOutput<number[]>("[1,2]")).toEqual([1, 2]);
  });

  it("redacts credentials from error details", () => {
    expect(sanitize("Error: token=abc123 failed\napi_key: xyz")).not.toMatch(/abc123|xyz/);
  });

  it("redacts bearer tokens and quoted values, not just the word after the colon", () => {
    expect(sanitize("Authorization: Bearer abc123token")).not.toMatch(/abc123token/);
    expect(sanitize("request failed with Bearer abc123token.xyz")).not.toMatch(/abc123token/);
    expect(sanitize('{"api_token": "abc 123 secret value"}')).not.toMatch(/abc|123|value/);
  });

  it.each([
    ["Authorization: Basic Zml4dHVyZTpjcmVkZW50aWFs", "Authorization: [redacted]"],
    ["Authorization: Token abcdef123456", "Authorization: [redacted]"],
    ['Authorization: Digest username="fixture", realm="example", response="0123456789abcdef"', "Authorization: [redacted]"],
    [String.raw`{"api_token":"abc\"def ghi"}`, '{"api_token": [redacted]}'],
    [String.raw`password='abc\'def ghi'`, "password: [redacted]"],
    ["x-auth-key: 0123456789abcdef", "x-auth-key: [redacted]"],
    ['{"api_token":"fixture value"}', '{"api_token": [redacted]}'],
    ["Authorization: Bearer abc123token", "Authorization: [redacted]"],
  ])("redacts the complete credential in %s through deployment error details", async (input, expected) => {
    expect(sanitize(input)).toBe(expected);
    expect(explainWranglerFailure("Deploy", input).details).toBe(expected);
    const wrangler = new Wrangler(async () => ({ code: 1, stdout: "", stderr: input }), "/controlled/wrangler.mjs");
    await expect(wrangler.deployWorker("/controlled/wrangler.jsonc")).rejects.toMatchObject({ details: expected });
  });

  it("keeps later diagnostic lines after an Authorization header", () => {
    expect(sanitize('Authorization: Digest username="fixture", response="abcdef"\nError: permission denied'))
      .toBe("Authorization: [redacted]\nError: permission denied");
  });

  it("keeps ordinary sentences that start with Bearer readable", () => {
    expect(sanitize("Bearer authentication failed")).toBe("Bearer authentication failed");
  });

  it("keeps ordinary error text readable", () => {
    expect(sanitize("The token has expired; log in again")).toBe("The token has expired; log in again");
  });

  it("redacts an unlabeled provider key left in installer output", () => {
    const anthropic = `sk-ant-api03-${"a".repeat(24)}`;
    const github = `ghp_${"b".repeat(36)}`;
    const pat = `github_pat_${"c".repeat(22)}`;
    for (const key of [anthropic, github, pat]) {
      expect(sanitize(`Deploy failed: ${key}`)).toBe("Deploy failed: [redacted]");
    }
    expect(sanitize("Bearer authentication failed")).toBe("Bearer authentication failed");
  });

  it("classifies common failures with recovery hints", () => {
    expect(explainWranglerFailure("X", "fetch failed ETIMEDOUT").message).toMatch(/network/);
    expect(explainWranglerFailure("X", "[code: 10001] forbidden").hint).toMatch(/Workers Scripts:Edit/);
  });
});

describe("post-deploy verification", () => {
  it("passes against a healthy deployment", async () => {
    const checks = await runChecks("https://x.pages.dev", fakeSite());
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks).toHaveLength(4);
  });

  it("flags a backend that accepts anonymous private requests", async () => {
    const open = (async (url: string) =>
      new URL(url).pathname === "/api/tasks" ? Response.json({ tasks: [] }) : fakeSite()(url)) as typeof fetch;
    const checks = await runChecks("https://x.pages.dev", open);
    expect(checks.find((c) => c.name.includes("anonymous"))?.ok).toBe(false);
  });
});

describe("semantic recall default", () => {
  const base = { workerName: "w", installationId: "abcd1234", version: "1", timezone: "UTC", agentName: "Ada" };

  it("adds only TALORYS_SEMANTIC_DEFAULT when enabled and leaves upstream vars untouched otherwise", () => {
    const upstream = generateAgentConfig(base);
    expect(generateAgentConfig({ ...base, semanticDefault: false })).toEqual(upstream);
    expect(toJsonc(generateAgentConfig({ ...base, semanticDefault: false }))).toBe(toJsonc(upstream));
    const on = generateAgentConfig({ ...base, semanticDefault: true });
    expect(on.vars).toEqual({ ...(upstream.vars as Record<string, string>), TALORYS_SEMANTIC_DEFAULT: "on" });
    expect({ ...on, vars: upstream.vars }).toEqual(upstream);
  });
});

describe("requirements", () => {
  it("requires at least the Node.js version the bundled Wrangler needs", () => {
    const wranglerPkg = JSON.parse(readFileSync(join(__dirname, "../../../node_modules/wrangler/package.json"), "utf8"));
    const [major = 0, minor = 0] = String(wranglerPkg.engines.node).replace(/^>=\s*/, "").split(".").map(Number);
    expect(MIN_NODE[0] > major || (MIN_NODE[0] === major && MIN_NODE[1] >= minor)).toBe(true);
    expect(() => checkNodeVersion("20.18.0")).toThrow(CliError);
    expect(() => checkNodeVersion("22.0.0")).not.toThrow();
  });
});

describe("PR #22 hardening", () => {
  it("H2 no agent Worker config turns on the request-signal flag", () => {
    const generated = stripJsonc(toJsonc(generateAgentConfig({ workerName: "w", installationId: "abcd1234", version: "1", timezone: "Europe/Paris", agentName: "Ada" })));
    const dev = stripJsonc(readFileSync(join(__dirname, "../../../apps/agent/wrangler.jsonc"), "utf8"));
    const standalone = stripJsonc(readFileSync(join(__dirname, "../../../apps/agent/wrangler.standalone.jsonc"), "utf8"));
    for (const cfg of [generated, dev, standalone]) {
      expect(cfg.compatibility_flags).toContain("nodejs_compat");
      expect(cfg.compatibility_flags).not.toContain("enable_request_signal");
    }
  });
});
