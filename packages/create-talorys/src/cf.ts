import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Exec, type ExecOptions, type ExecResult, exec as defaultExec } from "./exec";
import { CliError, explainCfFailure, sanitize } from "./errors";

export interface CloudflareAccount {
  id: string;
  name: string;
}

export interface WhoAmI {
  loggedIn: boolean;
  authSource?: string;
  email?: string;
  accounts: CloudflareAccount[];
}

export interface DeployResult {
  versionId: string | null;
  /** The workers.dev URL Cloudflare reports for the Worker, if it has one. */
  url: string | null;
}

/** Locates the `cf` CLI shipped as a dependency of create-talorys. */
export function resolveCfBin(): string {
  if (process.env.TALORYS_CF_BIN) return process.env.TALORYS_CF_BIN;
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("cf/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { bin: string | Record<string, string> };
  const bin = typeof pkg.bin === "string" ? pkg.bin : (pkg.bin.cf ?? Object.values(pkg.bin)[0]!);
  return join(dirname(pkgPath), bin);
}

/** Extracts the JSON document from CLI output that may contain warnings around it. */
export function parseJsonOutput<T>(stdout: string): T {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // Try each line that begins a JSON document (warnings may precede it).
    const lines = trimmed.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s*[[{]/.test(lines[i]!)) continue;
      try {
        return JSON.parse(lines.slice(i).join("\n")) as T;
      } catch {
        for (let j = lines.length; j > i; j--) {
          try {
            return JSON.parse(lines.slice(i, j).join("\n")) as T;
          } catch {
            /* keep trying shorter spans */
          }
        }
      }
    }
    throw new Error("No JSON in output");
  }
}

/** Runs `fn` with a private temporary JSON file holding `data`; the file is always removed afterwards. */
async function withPrivateJsonFile<T>(data: unknown, fn: (path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "talorys-"));
  const path = join(dir, "secrets.json");
  try {
    writeFileSync(path, JSON.stringify(data), { mode: 0o600 });
    return await fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Typed wrapper around Cloudflare's `cf` CLI. All calls use argument arrays and
 * disable telemetry. Secret values never appear in arguments or the project
 * directory: they go through a short-lived private temp file, because `cf`
 * reads secrets from files only.
 */
export class CloudflareCli {
  accountId: string | null = null;

  constructor(
    private readonly execFn: Exec = defaultExec,
    private readonly bin: string = resolveCfBin(),
  ) {}

  private run(args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    return this.execFn(process.execPath, [this.bin, ...args], {
      ...opts,
      env: {
        CF_SEND_TELEMETRY: "false",
        DO_NOT_TRACK: "1",
        CF_QUIET: "1",
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        ...(this.accountId ? { CLOUDFLARE_ACCOUNT_ID: this.accountId } : {}),
        ...opts.env,
      },
    });
  }

  private async runOk(action: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const result = await this.run(args, { timeoutMs: 5 * 60_000, ...opts });
    if (result.code !== 0) throw explainCfFailure(action, `${result.stderr}\n${result.stdout}`);
    return result;
  }

  async version(): Promise<string> {
    const r = await this.run(["--version"], { timeoutMs: 60_000 });
    if (r.code !== 0) throw new CliError("The bundled cf CLI could not start.", "Reinstall with `npx create-talorys@latest`.", sanitize(r.stderr, 3));
    return r.stdout.trim().split("\n").pop()!.trim();
  }

  async whoami(): Promise<WhoAmI> {
    const r = await this.run(["auth", "whoami"], { timeoutMs: 60_000 });
    if (r.code !== 0) return { loggedIn: false, accounts: [] };
    try {
      const parsed = parseJsonOutput<{ authenticated?: boolean; authSource?: string; email?: string; accounts?: CloudflareAccount[] }>(r.stdout);
      if (!parsed.authenticated) return { loggedIn: false, accounts: [] };
      return { loggedIn: true, authSource: parsed.authSource, email: parsed.email, accounts: parsed.accounts ?? [] };
    } catch {
      return { loggedIn: false, accounts: [] };
    }
  }

  /** Cloudflare's OAuth flow: opens the browser and prints a code to confirm (interactive). */
  async login(): Promise<void> {
    const r = await this.run(["auth", "login"], { interactive: true, timeoutMs: 10 * 60_000 });
    if (r.code !== 0) {
      throw new CliError("Cloudflare login did not complete.", "Re-run the installer and approve access in the browser window that opens.");
    }
  }

  async workerExists(name: string): Promise<boolean> {
    const r = await this.runOk("Checking the Worker", ["workers", "scripts", "search", "--name", name], { timeoutMs: 120_000 });
    // The search matches substrings, so only an exact name counts.
    return parseJsonOutput<{ id?: string; script_name?: string }[]>(r.stdout).some((s) => (s.script_name ?? s.id) === name);
  }

  async listSecrets(workerName: string): Promise<string[]> {
    const r = await this.runOk("Reading Worker secret names", ["workers", "secrets", "list", "--worker", workerName], { timeoutMs: 120_000 });
    return parseJsonOutput<{ name: string }[]>(r.stdout).map((s) => s.name);
  }

  /** Sets secrets on an existing Worker (JSON merge patch; other secrets are untouched). */
  async putSecrets(workerName: string, secrets: Record<string, string>): Promise<void> {
    const body = { secrets: Object.fromEntries(Object.entries(secrets).map(([name, text]) => [name, { name, type: "secret_text", text }])) };
    await withPrivateJsonFile(body, (file) => this.runOk("Storing Cloudflare secrets", ["workers", "secrets", "bulk", "--worker", workerName, "--file", file]));
  }

  /**
   * Deploys the prebuilt Build Output in `projectDir` (.cloudflare/output/v0).
   * `secrets` are uploaded with the new version, so a new Worker is never live
   * without them; existing secrets are always kept by cf.
   */
  async deploy(projectDir: string, secrets: Record<string, string> = {}): Promise<DeployResult> {
    const outDir = mkdtempSync(join(tmpdir(), "talorys-deploy-"));
    const outputFile = join(outDir, "output.ndjson");
    try {
      const deploy = (extra: string[]) =>
        this.runOk("Deploying the Talorys Worker", ["deploy", "--prebuilt", ...extra], {
          cwd: projectDir,
          timeoutMs: 10 * 60_000,
          env: { WRANGLER_OUTPUT_FILE_PATH: outputFile },
        });
      const r = Object.keys(secrets).length
        ? await withPrivateJsonFile(secrets, (file) => deploy(["--secrets-file", file]))
        : await deploy([]);
      return parseDeployResult(r.stdout, readOptional(outputFile));
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }

  /** Non-inference check that a Workers AI model exists in the catalog. */
  async modelAvailable(model: string): Promise<boolean | null> {
    const r = await this.run(["ai", "get-model-schema", "--model", model], { timeoutMs: 120_000 });
    if (r.code === 0) return true;
    const out = `${r.stderr}\n${r.stdout}`.toLowerCase();
    if (out.includes("not found") || out.includes("no such model") || out.includes("invalid model")) return false;
    return null; // Unknown (e.g. missing AI read scope); not fatal.
  }
}

function readOptional(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Reads the deploy record cf appends to WRANGLER_OUTPUT_FILE_PATH, falling back to the human output. */
export function parseDeployResult(stdout: string, ndjson: string): DeployResult {
  for (const line of ndjson.split("\n").reverse()) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; version_id?: string; targets?: string[] };
      if (entry.type !== "deploy") continue;
      const url = entry.targets?.find((t) => /^https:\/\/[a-z0-9.-]+\.workers\.dev$/i.test(t)) ?? null;
      return { versionId: entry.version_id ?? null, url: url?.toLowerCase() ?? null };
    } catch {
      /* ignore partial lines */
    }
  }
  return {
    versionId: stdout.match(/Current Version ID:\s*([0-9a-f-]{36})/i)?.[1] ?? null,
    url: stdout.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0]?.toLowerCase() ?? null,
  };
}
