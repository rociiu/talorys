#!/usr/bin/env node
// A stand-in for Cloudflare's `cf` CLI used by installer tests. It simulates one
// or more Cloudflare accounts in a JSON state file (FAKE_CF_STATE) and records
// every invocation, so tests can assert idempotency and failure recovery.
//
// It models the cf@1.0.0-beta.14 behaviour the installer relies on:
//  - JSON on stdout for API commands, an error box with `[code]` on stderr and exit 1 on API errors;
//  - `deploy --prebuilt` reads .cloudflare/output/v0 from the cwd, keeps existing secrets,
//    uploads --secrets-file values, and appends a deploy record to WRANGLER_OUTPUT_FILE_PATH;
//  - Durable Object `exports` on a Worker created by Wrangler `migrations` keep the namespace,
//    while an `exports` map that omits a live class is refused (never deleted);
//  - strict mode: a Worker last updated "via the script API" aborts the deploy without a TTY.
//
// Failure injection: state.failNext = { "<command key>": "<stderr text>" } fails the next
// matching call once. Keys: "deploy", "secrets bulk", "auth whoami", "scripts search".
// state.workersSubdomain is the account's workers.dev subdomain ("owner" when unset);
// null simulates an account that has never registered one.
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const statePath = process.env.FAKE_CF_STATE;
if (!statePath) {
  console.error("FAKE_CF_STATE not set");
  process.exit(2);
}
const state = JSON.parse(readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const key =
  args[0] === "workers" ? `${args[1]} ${args[2]}` : args[0] === "auth" ? `auth ${args[1]}` : args[0] === "ai" ? `ai ${args[1]}` : args[0];
state.calls.push({ key, args, cwd: process.cwd(), env: { CF_SEND_TELEMETRY: process.env.CF_SEND_TELEMETRY } });

function apiError(code, message) {
  save();
  process.stderr.write(`┌ APIError\n│ [${code}] ${message}\n│ 404 Not Found\n└\n`);
  process.exit(1);
}
function fail(message) {
  save();
  process.stderr.write(`■ ${message}\n`);
  process.exit(1);
}
if (state.failNext?.[key]) {
  const msg = state.failNext[key];
  delete state.failNext[key];
  fail(msg);
}

let account = process.env.CLOUDFLARE_ACCOUNT_ID ?? state.accounts[0]?.id;
const workersOf = (acc) => (state.workers[acc] ??= {});

const listFiles = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String) : []);

switch (key) {
  case "--version":
    console.log("1.0.0-beta.14");
    break;
  case "auth whoami":
    console.log(
      JSON.stringify(
        state.loggedIn
          ? { authenticated: true, authSource: "OAuth token", tokenValid: true, email: "owner@example.com", accounts: state.accounts }
          : { authenticated: false, error: "Not logged in" },
      ),
    );
    break;
  case "auth login":
    state.loggedIn = true;
    break;
  case "scripts search": {
    const name = flag("--name");
    // Substring match, like the real API.
    console.log(JSON.stringify(Object.keys(workersOf(account)).filter((n) => n.includes(name)).map((n) => ({ id: n, script_name: n }))));
    break;
  }
  case "secrets list": {
    const ws = workersOf(account)[flag("--worker")];
    if (!ws) apiError(10007, "This Worker does not exist on your account.");
    console.log(JSON.stringify(Object.keys(ws.secrets).map((n) => ({ name: n, type: "secret_text" }))));
    break;
  }
  case "secrets bulk": {
    const ws = workersOf(account)[flag("--worker")];
    const file = flag("--file");
    state.lastSecretsFile = file;
    if (!ws) apiError(10007, "This Worker does not exist on your account.");
    const body = JSON.parse(readFileSync(file, "utf8"));
    for (const [k, v] of Object.entries(body.secrets)) {
      if (v === null) delete ws.secrets[k];
      else ws.secrets[k] = { length: String(v.text).length, prefix: String(v.text).slice(0, 14), tail: String(v.text).slice(-6) };
    }
    if (state.secretsBulkMarksApi) ws.lastDeployedFrom = "api";
    console.log(JSON.stringify(Object.fromEntries(Object.keys(body.secrets).map((k) => [k, { name: k, type: "secret_text" }]))));
    break;
  }
  case "deploy": {
    if (!args.includes("--prebuilt")) fail("fake-cf: only `deploy --prebuilt` is supported");
    const out = join(process.cwd(), ".cloudflare/output/v0");
    if (!existsSync(join(out, "config.json"))) fail("No Build Output found in .cloudflare/output/v0. Run `cf build` first.");
    const root = JSON.parse(readFileSync(join(out, "config.json"), "utf8"));
    account = root.accountId ?? account;
    const workerDir = join(out, "workers/default");
    const cfg = JSON.parse(readFileSync(join(workerDir, "worker.config.json"), "utf8"));
    if (cfg.migrations) fail('worker.config.json: Unrecognized key: "migrations"');
    if (!existsSync(join(workerDir, "bundle", cfg.manifest?.mainModule ?? "worker.js"))) fail("Main module not found in bundle/");
    const assets = listFiles(join(workerDir, "assets"));
    const secretsFile = flag("--secrets-file");
    state.lastSecretsFile = secretsFile ?? state.lastSecretsFile;
    const ws = workersOf(account);
    const existing = ws[cfg.name];
    // Strict mode is always on in cf; without a TTY a "continue?" confirm aborts but still prints "Deploy complete".
    if (existing?.lastDeployedFrom === "api") {
      save();
      console.log("│  ▲ You are about to upload a Worker that was last updated via the script API.");
      console.log("│  Aborting the upload operation because of conflicts…\n◆  Deploy complete");
      process.exit(1);
    }
    const subdomain = state.workersSubdomain === undefined ? "owner" : state.workersSubdomain;
    if (!existing && cfg.workersDev && !subdomain) {
      console.log("│  ▲ You need to register a workers.dev subdomain before publishing to workers.dev");
      fail(
        `You can either deploy your worker to one or more routes by specifying them in your wrangler.json file, or register a workers.dev subdomain here:\nhttps://dash.cloudflare.com/${account}/workers/onboarding`,
      );
    }
    // Durable Object lifecycle: every live class must stay declared; nothing is ever deleted implicitly.
    const liveClasses = existing ? [...(existing.migrations ?? []).flatMap((m) => m.new_sqlite_classes ?? []), ...Object.keys(existing.exports ?? {})] : [];
    const declared = Object.entries(cfg.exports ?? {}).filter(([, v]) => v.type === "durable-object" && (v.state ?? "created") === "created").map(([k]) => k);
    const missing = liveClasses.filter((c) => !declared.includes(c));
    if (missing.length) apiError(100402, `Durable Object exports reconciliation failed: ${missing.join(", ")} is still exported by the Worker but missing from exports`);
    const secrets = { ...(existing?.secrets ?? {}) };
    if (secretsFile) {
      for (const [k, v] of Object.entries(JSON.parse(readFileSync(secretsFile, "utf8")))) secrets[k] = { length: String(v).length, prefix: String(v).slice(0, 14), tail: String(v).slice(-6) };
    }
    ws[cfg.name] = {
      secrets,
      migrations: existing?.migrations ?? [],
      exports: cfg.exports ?? {},
      workers_dev: cfg.workersDev ?? false,
      assets: { ...(cfg.assets ?? {}), files: assets },
      env: cfg.env ?? {},
      vars: Object.fromEntries(Object.entries(cfg.env ?? {}).filter(([, v]) => v.type === "text").map(([k, v]) => [k, v.value])),
      deploys: (existing?.deploys ?? 0) + 1,
      durableObjectData: existing?.durableObjectData ?? "owner-data",
      lastDeployedFrom: state.deployMarksApi ? "api" : "wrangler",
    };
    const url = cfg.workersDev ? `https://${cfg.name}.${subdomain}.workers.dev` : null;
    if (process.env.WRANGLER_OUTPUT_FILE_PATH) {
      appendFileSync(
        process.env.WRANGLER_OUTPUT_FILE_PATH,
        `${JSON.stringify({ type: "deploy", version: 1, worker_name: cfg.name, version_id: "11111111-2222-3333-4444-555555555555", targets: url ? [url] : [] })}\n`,
      );
    }
    console.log(
      [
        "├  Deploy",
        `│  ✨ Read ${assets.length} files from the assets directory`,
        "│  Durable Object exports reconciliation: TalorysAgent unchanged",
        `│  Uploaded ${cfg.name} (0.03 sec)`,
        url ? `│  Deployed ${cfg.name} triggers (0.01 sec)\n│    ${url}` : `│  No targets deployed for ${cfg.name}`,
        "│  Current Version ID: 11111111-2222-3333-4444-555555555555",
        "◆  Deploy complete",
      ].join("\n"),
    );
    break;
  }
  case "ai get-model-schema":
    console.log(JSON.stringify({ input: {}, output: {} }));
    break;
  default:
    fail(`fake-cf: unsupported command ${args.join(" ")}`);
}
save();
