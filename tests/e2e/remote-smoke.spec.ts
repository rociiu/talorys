import { execFileSync } from "node:child_process";
import { expect, type APIRequestContext, test } from "@playwright/test";

const PASSWORD = process.env.TALORYS_DEV_PASSWORD || "talorys-dev-password";
const BASE = "http://localhost:5173";
const CSRF = { "x-talorys-request": "1", origin: BASE };

async function login(request: APIRequestContext) {
  const res = await request.post("/api/auth/login", { headers: CSRF, data: { password: PASSWORD } });
  expect(res.status()).toBe(200);
}

async function mint(request: APIRequestContext, name: string, scope: "read" | "write"): Promise<{ id: string; token: string }> {
  const res = await request.post("/api/remote/tokens", { headers: CSRF, data: { name, scope } });
  expect(res.status()).toBe(201);
  const { token } = await res.json();
  return { id: token.id, token: token.token };
}

/** Runs the smoke script and returns its exit status and output; the token travels only in the environment. */
function smoke(token: string, ...flags: string[]): { status: number; output: string } {
  try {
    const output = execFileSync("node", ["scripts/remote-smoke.mjs", ...flags], {
      env: { ...process.env, TALORYS_URL: BASE, TALORYS_TOKEN: token },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, output };
  } catch (error) {
    const e = error as { status: number | null; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

test.describe("Remote smoke script", () => {
  test.afterEach(async ({ request }) => {
    await request.delete("/api/remote/tokens", { headers: CSRF });
    await request.patch("/api/remote/status", { headers: CSRF, data: { enabled: false } });
  });

  test("passes in write, read-only and expect-revoked modes without printing the token", async ({ request }) => {
    await login(request);
    expect((await request.patch("/api/remote/status", { headers: CSRF, data: { enabled: true } })).status()).toBe(200);

    const write = await mint(request, "Smoke write", "write");
    const written = smoke(write.token);
    expect(written.output).not.toContain(write.token);
    expect(written.status, written.output).toBe(0);
    for (const line of ["ok health", "ok create task", "ok get task", "ok list tasks", "ok list automations", "ok search", "ok delete task", "ok all"]) {
      expect(written.output).toContain(line);
    }
    const open = await (await request.get("/api/tasks?status=open&limit=200")).json();
    expect(open.tasks.some((t: { title: string }) => t.title.startsWith("remote-smoke "))).toBe(false);

    const read = await mint(request, "Smoke read", "read");
    const readOnly = smoke(read.token, "--read-only");
    expect(readOnly.output).not.toContain(read.token);
    expect(readOnly.status, readOnly.output).toBe(0);
    expect(readOnly.output).toContain("ok write denied");
    expect(readOnly.output).not.toContain("create task");

    // A live token fails the revoked check, so the mode is not a no-op.
    expect(smoke(read.token, "--expect-revoked").status).toBe(1);

    for (const t of [write, read]) expect((await request.delete(`/api/remote/tokens/${t.id}`, { headers: CSRF })).status()).toBe(200);
    for (const t of [write, read]) {
      const revoked = smoke(t.token, "--expect-revoked");
      expect(revoked.output).not.toContain(t.token);
      expect(revoked.status, revoked.output).toBe(0);
      expect(revoked.output).toContain("ok token rejected");
    }
    // And a revoked token fails the normal run.
    expect(smoke(write.token).status).toBe(1);
  });
});
