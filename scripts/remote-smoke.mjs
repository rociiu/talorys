// Checks machine access to a Talorys install with a personal access token.
// Usage: TALORYS_URL=<origin> TALORYS_TOKEN=<token> node scripts/remote-smoke.mjs [--read-only] [--expect-revoked]
// Prints one `ok <step>` or `FAIL <step>: <status>` line per step and never the token.
const USAGE = "usage: TALORYS_URL=<origin> TALORYS_TOKEN=<token> node scripts/remote-smoke.mjs [--read-only] [--expect-revoked]";

const base = (process.env.TALORYS_URL ?? "").replace(/\/+$/, "");
const token = process.env.TALORYS_TOKEN ?? "";
const args = new Set(process.argv.slice(2));
const unknown = [...args].filter((a) => a !== "--read-only" && a !== "--expect-revoked");
if (!base || !token || unknown.length > 0 || (args.has("--read-only") && args.has("--expect-revoked"))) {
  console.error(USAGE);
  process.exit(2);
}

class StepFailure extends Error {}

/** Calls the API with the token; the response body is parsed when it is JSON and ignored otherwise. */
async function call(method, path, body) {
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "manual",
    });
  } catch (error) {
    return { status: 0, json: null, retryAfter: null, network: error?.cause?.code ?? error?.name ?? "error" };
  }
  let json = null;
  if ((res.headers.get("content-type") ?? "").includes("application/json")) {
    try {
      json = await res.json();
    } catch {}
  }
  return { status: res.status, json, retryAfter: res.headers.get("retry-after"), network: null };
}

/** Describes a failed response by status and error code only, never by body text. */
function describe(r) {
  if (r.network) return `network ${r.network}`;
  const parts = [String(r.status)];
  if (r.status === 429) parts.push(`retry-after=${r.retryAfter ?? "?"}`);
  const code = r.json?.error?.code;
  if (typeof code === "string") parts.push(code);
  return parts.join(" ");
}

function fail(step, detail) {
  console.log(`FAIL ${step}: ${detail}`);
  throw new StepFailure(step);
}

/** Runs one request and fails the step unless the status is one of `ok`. */
async function step(name, method, path, { body, ok = [200], note } = {}) {
  const r = await call(method, path, body);
  if (!ok.includes(r.status)) fail(name, describe(r));
  const extra = typeof note === "function" ? note(r) : note;
  console.log(`ok ${name}${extra ? ` (${extra})` : ""}`);
  return r;
}

const count = (key) => (r) => `${Array.isArray(r.json?.[key]) ? r.json[key].length : 0} ${key}`;
const searchNote = (r) => (r.status === 409 ? "semantic off" : `${Array.isArray(r.json?.hits) ? r.json.hits.length : 0} hits`);

async function readSteps() {
  await step("list tasks", "GET", "/api/tasks?status=open&limit=5", { note: count("tasks") });
  await step("list automations", "GET", "/api/automations", { note: count("automations") });
  await step("search", "GET", `/api/semantic/search?q=${encodeURIComponent("remote smoke")}`, { ok: [200, 409], note: searchNote });
}

async function writeMode() {
  await step("health", "GET", "/api/health");
  const created = await step("create task", "POST", "/api/tasks", { body: { title: `remote-smoke ${new Date().toISOString()}` }, ok: [200, 201] });
  const id = created.json?.task?.id;
  if (typeof id !== "string") fail("create task", "no task id in response");
  try {
    const got = await step("get task", "GET", `/api/tasks/${id}`, { note: `id ${id}` });
    if (got.json?.task?.id !== id) fail("get task", "id mismatch");
    await readSteps();
  } finally {
    await step("delete task", "DELETE", `/api/tasks/${id}`);
  }
}

async function readOnlyMode() {
  await step("health", "GET", "/api/health");
  await readSteps();
  await step("write denied", "POST", "/api/tasks", { body: { title: "remote-smoke read-only probe" }, ok: [403] });
}

async function expectRevokedMode() {
  await step("token rejected", "GET", "/api/tasks", { ok: [401] });
}

try {
  if (args.has("--expect-revoked")) await expectRevokedMode();
  else if (args.has("--read-only")) await readOnlyMode();
  else await writeMode();
  console.log("ok all");
} catch (error) {
  if (!(error instanceof StepFailure)) console.log(`FAIL unexpected: ${error?.name ?? "error"}`);
  process.exit(1);
}
