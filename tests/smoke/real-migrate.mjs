// Optional migration test against a REAL Cloudflare account.
//
// Proves that an installation made by the last two-resource release (Pages
// project + private Worker, deployed with Wrangler) keeps its data and owner
// password when it is updated by the locally built single-Worker CLI (cf):
//
//   1. install with create-talorys@0.1.4 from npm
//   2. sign in through the old pages.dev URL and write a task and a memory
//   3. `update` with packages/create-talorys/dist/cli.js
//   4. sign in at the new workers.dev URL with the same password and read them back
//
// Required: CLOUDFLARE_ACCOUNT_ID, plus credentials: CLOUDFLARE_API_TOKEN (CI), or
// existing logins on this machine for both CLIs involved: `npx wrangler login`
// (step 1 uses the old Wrangler-based installer) and `npx cf auth login` (step 3).
// A token needs Workers Scripts:Edit, Cloudflare Pages:Edit (for step 1 only),
// Workers AI:Read and Account Settings:Read.
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
  console.log("Skipping real-account migration test: set CLOUDFLARE_ACCOUNT_ID (and CLOUDFLARE_API_TOKEN, or sign in with wrangler and cf) to run it.");
  process.exit(0);
}

const LEGACY_VERSION = process.env.TALORYS_LEGACY_VERSION ?? "0.1.4";
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(root, "packages/create-talorys/dist/cli.js");
const work = mkdtempSync(join(tmpdir(), "talorys-migrate-"));
const dir = join(work, "agent");
const password = `Migrate-${randomBytes(9).toString("base64url")}`;
const env = { ...process.env, TALORYS_OWNER_PASSWORD: password };
const readManifest = () => JSON.parse(readFileSync(join(dir, "talorys.json"), "utf8"));

function client(base) {
  let cookie = "";
  return async (path, init = {}) => {
    const r = await fetch(`${base}${path}`, {
      ...init,
      headers: { "x-talorys-request": "1", origin: base, "content-type": "application/json", ...(cookie ? { cookie } : {}), ...init.headers },
      redirect: "manual",
    });
    const set = r.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return r;
  };
}

/** New pages.dev / workers.dev hosts can take a little while to resolve. */
async function waitForLogin(call) {
  const deadline = Date.now() + 5 * 60_000;
  for (;;) {
    try {
      const r = await call("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) });
      if (r.status === 200) return;
      if (r.status === 401) throw new Error("password rejected");
    } catch (error) {
      if (error instanceof Error && error.message === "password rejected") throw error;
    }
    if (Date.now() > deadline) throw new Error("login did not succeed in time");
    await new Promise((r) => setTimeout(r, 5000));
  }
}

console.log(`• Installing create-talorys@${LEGACY_VERSION} (two-resource layout) into ${dir}`);
const legacy = spawnSync("npx", ["-y", `create-talorys@${LEGACY_VERSION}`, "--yes", "--dir", dir, "--account-id", CLOUDFLARE_ACCOUNT_ID, "--name", "Migrate"], {
  // Outside the monorepo, so npx fetches the published package instead of the local workspace of the same name.
  cwd: work,
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
});
assert.equal(legacy.status, 0, "legacy installer failed");
const before = readManifest();
assert.match(before.public_url, /\.pages\.dev$/, "legacy install should be served from pages.dev");
console.log(`• Legacy deployment at ${before.public_url} (Worker ${before.worker_name})`);

const oldApi = client(before.public_url);
await waitForLogin(oldApi);
const marker = `migration-${randomBytes(4).toString("hex")}`;
const task = await (await oldApi("/api/tasks", { method: "POST", body: JSON.stringify({ title: `Task ${marker}` }) })).json();
assert.equal(task.task.title, `Task ${marker}`);
const memory = await oldApi("/api/memories", { method: "POST", body: JSON.stringify({ content: `Memory ${marker}` }) });
assert.ok(memory.ok, `creating a memory failed: HTTP ${memory.status}`);
console.log(`✓ Wrote a task and a memory tagged ${marker}`);

console.log("• Updating with the single-Worker CLI");
const update = spawnSync(process.execPath, [cli, "update", "--yes", "--dir", dir], { env: { ...process.env }, stdio: "inherit" });
assert.equal(update.status, 0, "update failed");
const after = readManifest();
assert.equal(after.worker_name, before.worker_name, "the Worker (and so its Durable Object) must be the same");
assert.match(after.public_url, /\.workers\.dev$/, "the app should now be served from workers.dev");
assert.equal(after.status, "deployed");
console.log(`• Single Worker at ${after.public_url}`);

const home = await fetch(after.public_url);
assert.equal(home.status, 200);
assert.match(await home.text(), /<title>Talorys<\/title>/, "the Worker must serve the web app");

const newApi = client(after.public_url);
await waitForLogin(newApi); // same password: secrets survived
const tasks = await (await newApi(`/api/tasks?q=${encodeURIComponent(marker)}`)).json();
assert.ok(JSON.stringify(tasks).includes(`Task ${marker}`), "the task written before the update must still exist");
const memories = await (await newApi(`/api/memories?q=${encodeURIComponent(marker)}`)).json();
assert.ok(JSON.stringify(memories).includes(`Memory ${marker}`), "the memory written before the update must still exist");
console.log("✓ Owner password, task and memory survived the migration");

console.log("• Updating again (must be a no-op for data)");
const again = spawnSync(process.execPath, [cli, "update", "--yes", "--dir", dir], { env: { ...process.env }, stdio: "inherit" });
assert.equal(again.status, 0, "second update failed");
const tasksAgain = await (await newApi(`/api/tasks?q=${encodeURIComponent(marker)}`)).json();
assert.ok(JSON.stringify(tasksAgain).includes(`Task ${marker}`), "data must survive a second cf deploy");

console.log(`
✓ Migration test passed for ${after.public_url}
To remove the test deployment:
  npx cf pages delete ${before.pages_project_name}
  npx cf workers delete ${after.worker_name}
`);
