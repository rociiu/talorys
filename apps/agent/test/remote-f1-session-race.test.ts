import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BASE, type Client, inAgent, loggedIn, password } from "./helpers";

const NEW_PASSWORD = "Another-pass-99";

beforeEach(async () => {
  await inAgent((agent) => {
    agent.services.remote.revokeAll();
    agent.services.remote.setEnabled(true);
  });
});

afterEach(async () => {
  await inAgent((agent) => {
    agent.services.settings.delete("auth.password_override");
    agent.services.remote.setEnabled(false);
  });
});

/** Starts a token-create whose body stays open until `finish` is called, so the request is authenticated but pending. */
function pendingCreate(c: Client, name: string) {
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  const response = (exports as unknown as { default: Fetcher }).default.fetch(
    new Request(`${BASE}/api/remote/tokens`, {
      method: "POST",
      headers: { "cf-connecting-ip": c.ip, "x-talorys-request": "1", origin: BASE, "content-type": "application/json", cookie: c.cookie! },
      body: stream.readable,
    }),
  );
  return {
    response,
    async finish() {
      await writer.write(new TextEncoder().encode(JSON.stringify({ name })));
      await writer.close();
      return response;
    },
  };
}

const createdActivity = () =>
  inAgent((agent) => agent.services.db.one<{ n: number }>(`SELECT count(*) AS n FROM tal_activity WHERE type = 'remote.token_created'`)!.n);

describe("token create bound to the originating session", () => {
  it("a pending create is rejected once a password change elsewhere revokes its session", async () => {
    const victim = await loggedIn();
    const other = await loggedIn();
    const before = await createdActivity();
    const pending = pendingCreate(victim, "late");
    const changed = await other.call("/api/auth/password", { method: "POST", body: { current_password: password(), new_password: NEW_PASSWORD } });
    expect(changed.status).toBe(200);
    const res = await pending.finish();
    expect(res.status).toBe(401);
    expect(await inAgent((agent) => agent.services.remote.count())).toBe(0);
    expect(await createdActivity()).toBe(before);
  });

  it("the session kept by a password change may still mint", async () => {
    const c = await loggedIn();
    const changed = await c.call("/api/auth/password", { method: "POST", body: { current_password: password(), new_password: NEW_PASSWORD } });
    expect(changed.status).toBe(200);
    expect((await c.call("/api/remote/tokens", { method: "POST", body: { name: "kept" } })).status).toBe(201);
    expect(await inAgent((agent) => agent.services.remote.count())).toBe(1);
  });

  it("a pending create is rejected when its session is revoked by public id", async () => {
    const victim = await loggedIn();
    const other = await loggedIn();
    const { sessions } = await victim.json("/api/auth/sessions");
    const target = sessions.find((s: { current: boolean }) => s.current);
    const pending = pendingCreate(victim, "late");
    expect((await other.call(`/api/auth/sessions/${target.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await pending.finish()).status).toBe(401);
    expect(await inAgent((agent) => agent.services.remote.count())).toBe(0);
  });

  it("an expired session cannot mint even with a valid request", async () => {
    await inAgent(async (agent) => {
      const { remote, db } = agent.services;
      db.run(
        `INSERT INTO tal_sessions (id, created_at, last_seen_at, expires_at, user_agent) VALUES ('expired-session', ?, ?, ?, '')`,
        new Date(0).toISOString(), new Date().toISOString(), new Date(Date.now() - 1000).toISOString(),
      );
      await expect(remote.create({ name: "late" }, "expired-session")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      await expect(remote.create({ name: "late" }, null)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      db.run(`DELETE FROM tal_sessions WHERE id = 'expired-session'`);
      expect(remote.count()).toBe(0);
    });
  });
});
