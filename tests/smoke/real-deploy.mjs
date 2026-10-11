// Optional end-to-end smoke test against a REAL Cloudflare account.
//
// Creates a new Talorys deployment with the locally built create-talorys CLI,
// then exercises it over HTTPS: login, private API, task CRUD, and (optionally)
// one streamed chat turn through the Worker to the agent Durable Object. It also runs
// two further updates, so consecutive cf deploys are covered.
//
// Required: CLOUDFLARE_ACCOUNT_ID, plus credentials: CLOUDFLARE_API_TOKEN (CI), or an
// existing `npx cf auth login` on this machine.
// Optional: TALORYS_SMOKE_AI=1 to also run one Workers AI chat turn (uses Neurons)
//
// Resources are left in place for inspection; the script prints how to remove them.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";

const { CLOUDFLARE_ACCOUNT_ID } = process.env;
if (!CLOUDFLARE_ACCOUNT_ID) {
  console.log("Skipping real-account smoke test: set CLOUDFLARE_ACCOUNT_ID (and CLOUDFLARE_API_TOKEN, or sign in with `npx cf auth login`) to run it.");
  process.exit(0);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(root, "packages/create-talorys/dist/cli.js");
const work = mkdtempSync(join(tmpdir(), "talorys-smoke-"));
const password = `Smoke-${randomBytes(9).toString("base64url")}`;

console.log(`• Installing into ${work}/agent`);
const res = spawnSync(process.execPath, [cli, "--yes", "--dir", join(work, "agent"), "--account-id", CLOUDFLARE_ACCOUNT_ID, "--name", "Smoke"], {
  env: { ...process.env, TALORYS_OWNER_PASSWORD: password },
  stdio: "inherit",
});
assert.equal(res.status, 0, "installer failed");
const manifest = JSON.parse(readFileSync(join(work, "agent/talorys.json"), "utf8"));
const base = manifest.public_url;
console.log(`• Deployed at ${base}`);

const H = { "x-talorys-request": "1", origin: base, "content-type": "application/json" };
let cookie = "";
async function call(path, init = {}) {
  const r = await fetch(`${base}${path}`, { ...init, headers: { ...H, ...(cookie ? { cookie } : {}), ...init.headers }, redirect: "manual" });
  const set = r.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  return r;
}

assert.equal((await call("/api/tasks")).status, 401, "private API must reject anonymous requests");
assert.equal((await call("/api/auth/login", { method: "POST", body: JSON.stringify({ password: "wrong-password-1" }) })).status, 401);
const login = await call("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) });
assert.equal(login.status, 200, "login failed");
assert.match(login.headers.get("set-cookie") ?? "", /__Host-talorys_session=.*HttpOnly.*SameSite=Strict/i);

const home = await fetch(base);
assert.equal(home.status, 200, "web app must be served by the Worker");
assert.match(await home.text(), /<title>Talorys<\/title>/);
assert.match(home.headers.get("content-security-policy") ?? "", /default-src 'self'/, "_headers must apply to static assets");
const deepLink = await fetch(`${base}/tasks`, { headers: { accept: "text/html", "sec-fetch-mode": "navigate" } });
assert.equal(deepLink.status, 200, "client-side routes must fall back to index.html");

const created = await (await call("/api/tasks", { method: "POST", body: JSON.stringify({ title: "Smoke test task" }) })).json();
assert.equal(created.task.title, "Smoke test task");
assert.equal((await call(`/api/tasks/${created.task.id}`, { method: "DELETE" })).status, 200);
console.log("✓ Auth, private API and Durable Object storage work");

if (process.env.TALORYS_SMOKE_AI === "1") {
  const t0 = Date.now();
  const chat = await call("/api/chat", { method: "POST", body: JSON.stringify({ message: "Add a task called smoke check, then say done." }) });
  assert.equal(chat.status, 200);
  const reader = chat.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let firstChunkAt = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!firstChunkAt) firstChunkAt = Date.now() - t0;
    text += decoder.decode(value);
  }
  assert.match(text, /event: done/);
  console.log(`✓ Streamed chat turn (first bytes after ${firstChunkAt} ms). Tool events: ${(text.match(/event: tool/g) ?? []).length}`);
  if (/event: error/.test(text)) console.log(text.split("event: error")[1].slice(0, 300));
}

// cf always runs in strict mode without a TTY: make sure Cloudflare does not treat our own
// deploys as "changed outside the installer", which would abort every later update.
console.log("• Updating twice more (consecutive cf deploys must not trip strict mode)");
for (let i = 0; i < 2; i++) {
  const again = spawnSync(process.execPath, [cli, "update", "--yes", "--dir", join(work, "agent")], { env: process.env, stdio: "inherit" });
  assert.equal(again.status, 0, `update ${i + 1} failed`);
}
assert.equal((await call("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) })).status, 200, "password must survive updates");
console.log("✓ Repeated updates keep the deployment and its secrets");

console.log(`
✓ Smoke test passed for ${base}
To remove the test deployment:
  npx cf workers delete ${manifest.worker_name}
`);
