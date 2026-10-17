import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { exec } from "../src/exec";
import { scaffoldProject, templatesDir } from "../src/scaffold";
import { resolveWranglerBin } from "../src/wrangler";

const hasTemplates = existsSync(join(templatesDir(), "version.json"));

/**
 * Validates the generated production project with the REAL bundled Wrangler,
 * without contacting Cloudflare: the Worker config + bundle must pass
 * `wrangler deploy --dry-run`, and the Pages Function must compile.
 * Requires built templates (`npm run build -w create-talorys`).
 */
describe.skipIf(!hasTemplates)("generated project with real Wrangler (offline)", () => {
  let dir: string;
  // Vitest still runs a skipped suite's body to collect its tests, so scaffolding waits for beforeAll.
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "talorys-real-"));
    scaffoldProject({
      dir,
      workerName: "talorys-abcd1234-agent",
      pagesProjectName: "talorys-abcd1234-web",
      installationId: "abcd1234",
      version: "0.1.0",
      timezone: "Asia/Shanghai",
      agentName: "Talorys",
    });
  });
  const wrangler = (args: string[], cwd: string) =>
    exec(process.execPath, [resolveWranglerBin(), ...args], { cwd, env: { WRANGLER_SEND_METRICS: "false" }, timeoutMs: 180_000 });

  it("Worker config and bundle pass `wrangler deploy --dry-run`", async () => {
    const r = await wrangler(["deploy", "--dry-run", "--outdir", join(dir, "out"), "--config", "wrangler.jsonc"], join(dir, "agent"));
    const out = r.stdout + r.stderr;
    expect(r.code, out).toBe(0);
    expect(out).toMatch(/env\.TalorysAgent \(TalorysAgent\)\s+Durable Object/);
    expect(out).toMatch(/env\.AI\s+AI/);
    expect(out).toContain("TALORYS_INSTALLATION_ID");
    const gzip = Number(out.match(/gzip: ([\d.]+) KiB/)?.[1] ?? "0");
    expect(gzip).toBeGreaterThan(0);
    expect(gzip).toBeLessThan(3 * 1024); // Workers Free plan compressed size limit (3 MB)
  }, 200_000);

  it("Pages Function compiles with the generated Pages config", async () => {
    const outdir = join(dir, "fn-out");
    const r = await wrangler(["pages", "functions", "build", "--outdir", outdir], join(dir, "web"));
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(readdirSync(outdir).length).toBeGreaterThan(0);
  }, 200_000);
});
