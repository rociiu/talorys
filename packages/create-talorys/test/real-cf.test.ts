import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exec } from "../src/exec";
import { WORKER_OUTPUT_DIR } from "../src/config";
import { scaffoldProject, templatesDir } from "../src/scaffold";
import { resolveCfBin } from "../src/cf";

const hasTemplates = existsSync(join(templatesDir(), "version.json"));

/**
 * Validates the generated production project with the REAL bundled cf, without
 * contacting Cloudflare: the Build Output (Worker config, bundle and static
 * assets) must pass `cf deploy --prebuilt --dry-run`.
 * Requires built templates (`npm run build -w create-talorys`).
 */
describe.skipIf(!hasTemplates)("generated project with real cf (offline)", () => {
  const dir = mkdtempSync(join(tmpdir(), "talorys-real-"));
  scaffoldProject({
    dir,
    accountId: "0123456789abcdef0123456789abcdef",
    workerName: "talorys-abcd1234",
    installationId: "abcd1234",
    version: "0.1.0",
    timezone: "Asia/Shanghai",
    agentName: "Talorys",
  });
  const cf = (args: string[], cwd: string) =>
    exec(process.execPath, [resolveCfBin(), ...args], {
      cwd,
      // No credentials are needed for a dry run; an empty token makes sure no real login is used.
      env: { CF_SEND_TELEMETRY: "false", DO_NOT_TRACK: "1", CF_QUIET: "1", NO_COLOR: "1", CLOUDFLARE_API_TOKEN: "" },
      timeoutMs: 180_000,
    });

  it("Build Output passes `cf deploy --prebuilt --dry-run`", async () => {
    expect(existsSync(join(dir, WORKER_OUTPUT_DIR, "assets/index.html"))).toBe(true);
    const r = await cf(["deploy", "--prebuilt", "--dry-run"], dir);
    const out = r.stdout + r.stderr;
    expect(r.code, out).toBe(0);
    expect(out).toMatch(/env\.TalorysAgent \(TalorysAgent, defined in talorys-abcd1234\)\s+Durable Object/);
    expect(out).toMatch(/env\.AI\s+AI/);
    expect(out).toContain("TALORYS_INSTALLATION_ID");
    expect(out).toMatch(/Read \d+ files from the assets directory/);
    const gzip = Number(out.match(/gzip: ([\d.]+) KiB/)?.[1] ?? "0");
    expect(gzip).toBeGreaterThan(0);
    expect(gzip).toBeLessThan(3 * 1024); // Workers Free plan compressed size limit (3 MB)
  }, 200_000);
});
