import { MAX_REMOTE_TOKENS } from "@talorys/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { client, inAgent, loggedIn } from "./helpers";

beforeEach(async () => {
  await inAgent((agent) => {
    agent.services.remote.revokeAll();
    agent.services.remote.setEnabled(false);
  });
});

describe("remote access admin API", () => {
  it("admin flow: enable, create once, list, revoke and revoke all", async () => {
    const c = await loggedIn();
    expect(await c.json("/api/remote/status")).toEqual({ enabled: false, max_tokens: MAX_REMOTE_TOKENS });
    expect(await c.json("/api/remote/status", { method: "PATCH", body: { enabled: true } })).toEqual({ enabled: true });
    expect((await c.json("/api/remote/status")).enabled).toBe(true);

    const res = await c.call("/api/remote/tokens", { method: "POST", body: { name: "  laptop  " } });
    expect(res.status).toBe(201);
    const { token: first } = (await res.json()) as any;
    expect(first).toMatchObject({ name: "laptop", scope: "read", last_used_at: null });
    expect(first.token).toMatch(/^tal_/);
    expect(first.hint).toBe(first.token.slice(-4));
    const second = (await c.json("/api/remote/tokens", { method: "POST", body: { name: "script", scope: "write" } })).token;
    expect(second.scope).toBe("write");

    const listed = await c.call("/api/remote/tokens");
    const text = await listed.text();
    expect(text).not.toContain(first.token);
    expect(text).not.toContain("token_hash");
    const { tokens } = JSON.parse(text);
    expect(tokens.map((t: { id: string }) => t.id)).toEqual([first.id, second.id]);
    for (const t of tokens) expect(t).not.toHaveProperty("token");

    expect(await c.json(`/api/remote/tokens/${first.id}`, { method: "DELETE" })).toEqual({ revoked: true });
    expect((await c.call(`/api/remote/tokens/${first.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await c.json("/api/remote/tokens")).tokens.map((t: { id: string }) => t.id)).toEqual([second.id]);

    await c.json("/api/remote/tokens", { method: "POST", body: { name: "third" } });
    expect(await c.json("/api/remote/tokens", { method: "DELETE" })).toEqual({ revoked: 2 });
    expect((await c.json("/api/remote/tokens")).tokens).toEqual([]);
    expect(await c.json("/api/remote/tokens", { method: "DELETE" })).toEqual({ revoked: 0 });
  });

  it("admin flow: rejects invalid names and scopes", async () => {
    const c = await loggedIn();
    await c.json("/api/remote/status", { method: "PATCH", body: { enabled: true } });
    expect((await c.call("/api/remote/tokens", { method: "POST", body: { name: "   " } })).status).toBe(400);
    expect((await c.call("/api/remote/tokens", { method: "POST", body: { name: "x", scope: "admin" } })).status).toBe(400);
    expect((await c.call("/api/remote/status", { method: "PATCH", body: { enabled: "yes" } })).status).toBe(400);
    expect((await c.json("/api/remote/tokens")).tokens).toEqual([]);
  });

  it("session only: anonymous gets 401 and a missing CSRF header gets 403", async () => {
    const anon = client();
    for (const [path, method] of [
      ["/api/remote/status", "GET"],
      ["/api/remote/status", "PATCH"],
      ["/api/remote/tokens", "GET"],
      ["/api/remote/tokens", "POST"],
      ["/api/remote/tokens/x", "DELETE"],
      ["/api/remote/tokens", "DELETE"],
    ] as const) {
      expect((await anon.call(path, { method, body: method === "GET" ? undefined : {} })).status).toBe(401);
    }
    const c = await loggedIn();
    const noCsrf = { headers: { "x-talorys-request": "0" } };
    expect((await c.call("/api/remote/status", { method: "PATCH", body: { enabled: true }, ...noCsrf })).status).toBe(403);
    expect((await c.json("/api/remote/status")).enabled).toBe(false);
    await c.json("/api/remote/status", { method: "PATCH", body: { enabled: true } });
    expect((await c.call("/api/remote/tokens", { method: "POST", body: { name: "laptop" }, ...noCsrf })).status).toBe(403);
    expect((await c.call("/api/remote/tokens", { method: "DELETE", ...noCsrf })).status).toBe(403);
    expect((await c.json("/api/remote/tokens")).tokens).toEqual([]);
  });

  it("disabled: create is refused while list and revoke still work", async () => {
    const c = await loggedIn();
    expect((await c.call("/api/remote/tokens", { method: "POST", body: { name: "laptop" } })).status).toBe(403);
    await c.json("/api/remote/status", { method: "PATCH", body: { enabled: true } });
    const a = (await c.json("/api/remote/tokens", { method: "POST", body: { name: "a" } })).token;
    await c.json("/api/remote/tokens", { method: "POST", body: { name: "b" } });
    await c.json("/api/remote/status", { method: "PATCH", body: { enabled: false } });

    expect((await c.call("/api/remote/tokens", { method: "POST", body: { name: "c" } })).status).toBe(403);
    expect((await c.json("/api/remote/tokens")).tokens).toHaveLength(2);
    expect(await c.json(`/api/remote/tokens/${a.id}`, { method: "DELETE" })).toEqual({ revoked: true });
    expect(await c.json("/api/remote/tokens", { method: "DELETE" })).toEqual({ revoked: 1 });
  });

  it("activity: token events are recorded without the plaintext", async () => {
    const c = await loggedIn();
    await c.json("/api/remote/status", { method: "PATCH", body: { enabled: true } });
    const token = (await c.json("/api/remote/tokens", { method: "POST", body: { name: "laptop", scope: "write" } })).token;
    await c.json(`/api/remote/tokens/${token.id}`, { method: "DELETE" });
    await c.json("/api/remote/tokens", { method: "DELETE" });
    await c.json("/api/remote/status", { method: "PATCH", body: { enabled: false } });

    const res = await c.call("/api/activity");
    const text = await res.text();
    expect(text).not.toContain(token.token);
    const activity: { type: string; summary: string }[] = JSON.parse(text).activity;
    // Newest first: keep each type's latest event, not one left by an earlier test.
    const summaries = new Map(activity.reverse().map((a) => [a.type, a.summary]));
    expect(summaries.get("remote.enabled")).toBeTruthy();
    expect(summaries.get("remote.disabled")).toBeTruthy();
    expect(summaries.get("remote.token_created")).toBe('Created access token "laptop" (write)');
    expect(summaries.get("remote.token_revoked")).toBe('Revoked access token "laptop"');
    expect(summaries.get("remote.token_revoked_all")).toBe("Revoked all 0 access tokens");
  });
});
