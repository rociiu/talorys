import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inAgent, loggedIn, password } from "./helpers";

const NEW_PASSWORD = "Another-pass-99";

async function mintTokens(n: number): Promise<void> {
  await inAgent(async (agent) => {
    agent.services.remote.setEnabled(true);
    for (let i = 0; i < n; i++) await agent.services.remote.create({ name: `client-${i}` });
  });
}

const tokenCount = () => inAgent((agent) => agent.services.remote.count());

beforeEach(async () => {
  await inAgent((agent) => {
    agent.services.remote.revokeAll();
    agent.services.remote.setEnabled(false);
  });
});

afterEach(async () => {
  await inAgent((agent) => agent.services.settings.delete("auth.password_override"));
});

describe("remote token lifecycle", () => {
  it("password change revokes every access token", async () => {
    await mintTokens(3);
    const c = await loggedIn();
    const res = await c.call("/api/auth/password", { method: "POST", body: { current_password: password(), new_password: NEW_PASSWORD } });
    expect(res.status).toBe(200);
    expect(await tokenCount()).toBe(0);
    await inAgent((agent) => {
      expect(agent.services.remote.isEnabled()).toBe(true);
      const latest = agent.services.db.one<{ summary: string }>(
        `SELECT summary FROM tal_activity WHERE type = 'auth.password_changed' ORDER BY rowid DESC LIMIT 1`,
      );
      expect(latest?.summary).toBe("Password changed; other sessions signed out and access tokens revoked");
    });
  });

  it("failed change (wrong or weak password) keeps access tokens", async () => {
    await mintTokens(2);
    const c = await loggedIn();
    const wrong = await c.call("/api/auth/password", { method: "POST", body: { current_password: "nope-nope-1", new_password: NEW_PASSWORD } });
    expect(wrong.status).toBe(401);
    const weak = await c.call("/api/auth/password", { method: "POST", body: { current_password: password(), new_password: "weak" } });
    expect(weak.status).toBe(400);
    expect(await tokenCount()).toBe(2);
  });

  it("cli reset (changed secret fingerprint) revokes every access token", async () => {
    await mintTokens(2);
    await inAgent(async (agent) => {
      const { auth, remote, settings } = agent.services;
      // First-ever fingerprint write is not a reset.
      settings.delete("auth.secret_fingerprint");
      await auth.syncSecretFingerprint();
      expect(remote.count()).toBe(2);
      // A different stored fingerprint is what a CLI password reset looks like.
      settings.setJson("auth.secret_fingerprint", "0".repeat(32));
      await auth.syncSecretFingerprint();
      expect(remote.count()).toBe(0);
    });
  });
});
