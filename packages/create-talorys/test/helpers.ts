import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SelectChoice, Ui } from "../src/ui";
import { CancelledError } from "../src/errors";
import { CloudflareCli } from "../src/cf";
import { exec } from "../src/exec";
import type { FetchLike } from "../src/verify";

export const FAKE_CF = join(dirname(fileURLToPath(import.meta.url)), "fake-cf.mjs");

export interface FakeState {
  loggedIn: boolean;
  accounts: { id: string; name: string }[];
  workers: Record<string, Record<string, FakeWorker>>;
  /** Pages projects of older installations; the installer must never touch them. */
  pages: Record<string, Record<string, { subdomain: string; deployments: number; services?: unknown[] }>>;
  calls: { key: string; args: string[]; cwd: string; env: Record<string, string | undefined> }[];
  failNext: Record<string, string>;
  /** The account's workers.dev subdomain ("owner" when unset); null = never registered. */
  workersSubdomain?: string | null;
  /** Simulate Cloudflare marking deploys / secret changes as "via the script API" (cf strict mode then aborts). */
  deployMarksApi?: boolean;
  secretsBulkMarksApi?: boolean;
  /** Path of the last secrets file cf was given, to check it was removed. */
  lastSecretsFile?: string;
}

export interface FakeWorker {
  secrets: Record<string, { length: number; prefix: string; tail?: string }>;
  /** Wrangler-era Durable Object migrations (kept as history; cf never sends them). */
  migrations: { tag: string; new_sqlite_classes?: string[] }[];
  exports?: Record<string, { type: string; storage?: string; state?: string }>;
  workers_dev: boolean;
  assets?: { notFoundHandling?: string; runWorkerFirst?: string[]; files?: string[] } | null;
  env?: Record<string, { type: string; value?: string; worker?: string; exportName?: string }>;
  vars: Record<string, string>;
  deploys: number;
  durableObjectData: string;
  lastDeployedFrom?: string;
}

export function makeSandbox(initial: Partial<FakeState> = {}) {
  const root = mkdtempSync(join(tmpdir(), "talorys-cli-test-"));
  const statePath = join(root, "cf-state.json");
  const state: FakeState = {
    loggedIn: true,
    accounts: [{ id: "acc1", name: "Personal Account" }],
    workers: {},
    pages: {},
    calls: [],
    failNext: {},
    ...initial,
  };
  writeFileSync(statePath, JSON.stringify(state));
  process.env.FAKE_CF_STATE = statePath;
  const templates = makeTemplates(root, "0.1.0");
  return {
    root,
    templates,
    dir: join(root, "talorys"),
    state: () => JSON.parse(readFileSync(statePath, "utf8")) as FakeState,
    update: (fn: (s: FakeState) => void) => {
      const s = JSON.parse(readFileSync(statePath, "utf8")) as FakeState;
      fn(s);
      writeFileSync(statePath, JSON.stringify(s));
    },
    cf: () => new CloudflareCli(exec, FAKE_CF),
  };
}

export function makeTemplates(root: string, version: string): string {
  const dir = join(root, `templates-${version}`);
  mkdirSync(join(dir, "public"), { recursive: true });
  writeFileSync(join(dir, "version.json"), JSON.stringify({ version, built_at: "test" }));
  writeFileSync(join(dir, "worker.js"), `export default {}; // ${version}`);
  writeFileSync(join(dir, "public/index.html"), "<title>Talorys</title>");
  writeFileSync(join(dir, "public/_headers"), "/*\n  X-Frame-Options: DENY\n");
  return dir;
}

/**
 * Recreates an installation made by create-talorys 0.1.x (Wrangler, before the
 * single-Worker layout): a private agent Worker created with the `v1` Durable
 * Object migration (with secrets and data), a Pages project bound to it, the
 * old manifest and the old agent/ + web/ directories.
 */
export function makeLegacyInstallation(sb: ReturnType<typeof makeSandbox>) {
  const id = "abcd1234";
  const workerName = `talorys-${id}-agent`;
  const pagesProjectName = `talorys-${id}-web`;
  sb.update((s) => {
    s.workers.acc1 = {
      [workerName]: {
        secrets: { OWNER_PASSWORD_HASH: { length: 90, prefix: "pbkdf2-sha256$" }, SESSION_SECRET: { length: 43, prefix: "legacy-session" } },
        migrations: [{ tag: "v1", new_sqlite_classes: ["TalorysAgent"] }],
        workers_dev: false,
        assets: null,
        vars: { TALORYS_DEPLOYED_VERSION: "0.1.4" },
        deploys: 3,
        durableObjectData: "legacy-owner-data",
        lastDeployedFrom: "wrangler",
      },
    };
    s.pages.acc1 = {
      [pagesProjectName]: { subdomain: `${pagesProjectName}.pages.dev`, deployments: 3, services: [{ binding: "AGENT", service: workerName }] },
    };
  });
  for (const [file, text] of Object.entries({
    "agent/worker.js": "export default {}; // 0.1.4",
    "agent/wrangler.jsonc": JSON.stringify({ name: workerName, workers_dev: false }),
    "web/wrangler.jsonc": JSON.stringify({ name: pagesProjectName, services: [{ binding: "AGENT", service: workerName }] }),
    "web/dist/index.html": "<title>Talorys</title>",
    "web/functions/api/[[path]].ts": "export const onRequest = () => new Response('ok');",
  })) {
    mkdirSync(dirname(join(sb.dir, file)), { recursive: true });
    writeFileSync(join(sb.dir, file), text);
  }
  const now = "2026-09-01T00:00:00.000Z";
  writeFileSync(
    join(sb.dir, "talorys.json"),
    JSON.stringify({
      manifest_version: 1,
      installation_id: id,
      account_id: "acc1",
      account_name: "Personal Account",
      worker_name: workerName,
      pages_project_name: pagesProjectName,
      public_url: `https://${pagesProjectName}.pages.dev`,
      deployment_version: "0.1.4",
      agent_name: "Talorys",
      timezone: "Europe/London",
      semantic: false,
      status: "deployed",
      steps: ["scaffold", "worker", "secrets", "pages", "verified"],
      created_at: now,
      updated_at: now,
    }),
  );
  return { workerName, pagesProjectName };
}

/** Scripted, non-TTY-free UI for tests. Answers are consumed in order. */
export class ScriptedUi implements Ui {
  readonly interactive: boolean;
  readonly log: string[] = [];
  readonly prompts: string[] = [];
  constructor(
    private readonly answers: unknown[] = [],
    interactive = true,
  ) {
    this.interactive = interactive;
  }
  private next<T>(message: string): T {
    this.prompts.push(message);
    if (this.answers.length === 0) throw new Error(`Unexpected prompt: ${message}`);
    const a = this.answers.shift();
    if (a === CANCEL) throw new CancelledError();
    return a as T;
  }
  intro(t: string) {
    this.log.push(`intro:${t}`);
  }
  info(m: string) {
    this.log.push(`info:${m}`);
  }
  warn(m: string) {
    this.log.push(`warn:${m}`);
  }
  success(m: string) {
    this.log.push(`success:${m}`);
  }
  note(m: string, t?: string) {
    this.log.push(`note:${t ?? ""}:${m}`);
  }
  outro(m: string) {
    this.log.push(`outro:${m}`);
  }
  error(m: string) {
    this.log.push(`error:${m}`);
  }
  async step<T>(title: string, fn: (u: (m: string) => void) => Promise<T>, done?: (r: T) => string) {
    try {
      const r = await fn(() => {});
      this.log.push(`step:✓ ${done ? done(r) : title}`);
      return r;
    } catch (e) {
      this.log.push(`step:✗ ${title}`);
      throw e;
    }
  }
  async text(message: string, opts: { initial?: string } = {}) {
    const v = this.next<string>(message);
    return v === "" ? (opts.initial ?? "") : v;
  }
  async password(message: string) {
    return this.next<string>(message);
  }
  async select<T>(message: string, choices: SelectChoice<T>[]) {
    const label = this.next<string>(message);
    const c = choices.find((x) => x.label === label);
    if (!c) throw new Error(`No choice ${label}`);
    return c.value;
  }
  async confirm(message: string, initial?: boolean) {
    // A prompt with an explicit default (e.g. the semantic recall opt-in) takes that default
    // when the script has no boolean ready, so scripts written before the prompt still line up.
    if (initial !== undefined && typeof this.answers[0] !== "boolean" && this.answers[0] !== CANCEL) {
      this.prompts.push(message);
      return initial;
    }
    return this.next<boolean>(message);
  }
}

export const CANCEL = Symbol("cancel");

export const STRONG_PASSWORD = "correct-horse-Battery-9";

/** Simulates a healthy (or unhealthy) deployed Talorys at its workers.dev URL. */
export function fakeSite(opts: { healthy?: boolean; failFirst?: number } = {}): FetchLike & { calls: string[] } {
  let failures = opts.failFirst ?? 0;
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    if (failures > 0) {
      failures--;
      throw new Error("getaddrinfo ENOTFOUND");
    }
    const path = new URL(url).pathname;
    if (path === "/") return new Response("<!doctype html><title>Talorys</title>", { status: 200 });
    if (path === "/api/auth/session") return Response.json({ authenticated: false, configured: true });
    if (path === "/api/tasks") return Response.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });
    if (path === "/api/health") {
      return opts.healthy === false
        ? Response.json({ ok: false, storage: "ok", configured: { password: false, session_secret: false } }, { status: 503 })
        : Response.json({ ok: true, storage: "ok", schema_version: 1, configured: { password: true, session_secret: true } });
    }
    return new Response("not found", { status: 404 });
  }) as FetchLike & { calls: string[] };
  fn.calls = calls;
  return fn;
}
