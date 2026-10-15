import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthService } from "../src/auth/auth-service";
import { bearer, inAgent } from "./helpers";

const SESSION_SECRET = "test-session-secret-0123456789abcdefghijklmnop";

let original: AuthService | null = null;

async function mint(): Promise<string> {
  return inAgent(async (agent) => {
    agent.services.remote.setEnabled(true);
    return (await agent.services.remote.create({ name: "retained", scope: "write" })).token;
  });
}

/** Swaps in owner auth with no password, as when the password secret is removed after minting. */
async function unconfigureOwner(): Promise<void> {
  await inAgent((agent) => {
    original = agent.services.auth;
    agent.services.auth = new AuthService(agent.services.db, agent.services.settings, { sessionSecret: SESSION_SECRET });
    expect(agent.services.auth.isConfigured()).toBe(false);
  });
}

beforeEach(async () => {
  await inAgent((agent) => {
    agent.services.remote.revokeAll();
    agent.services.remote.setEnabled(false);
    agent.services.db.run(`DELETE FROM tal_remote_auth_failures`);
  });
});

afterEach(async () => {
  if (!original) return;
  const restore = original;
  original = null;
  await inAgent((agent) => {
    agent.services.auth = restore;
  });
});

describe("bearer auth without owner credentials", () => {
  it("configured owner: a valid token is accepted", async () => {
    const b = bearer(await mint());
    expect((await b.call("/api/tasks")).status).toBe(200);
  });

  it("unconfigured owner: a retained token is rejected like an invalid one", async () => {
    const token = await mint();
    await unconfigureOwner();
    const res = await bearer(token).call("/api/tasks");
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).error.message).toBe("Invalid or revoked access token.");
    // Not deleted automatically: the token works again once the owner is configured.
    expect(await inAgent((agent) => agent.services.remote.count())).toBe(1);
  });

  it("unconfigured owner: the rejection counts toward the throttle", async () => {
    const token = await mint();
    await unconfigureOwner();
    const b = bearer(token);
    await b.call("/api/tasks");
    const n = await inAgent((agent) =>
      agent.services.db.one<{ n: number }>(`SELECT count(*) AS n FROM tal_remote_auth_failures WHERE client = ?`, b.ip)!.n,
    );
    expect(n).toBe(1);
  });

  it("restoring credentials restores the retained token", async () => {
    const token = await mint();
    await unconfigureOwner();
    expect((await bearer(token).call("/api/tasks")).status).toBe(401);
    const restore = original!;
    original = null;
    await inAgent((agent) => {
      agent.services.auth = restore;
    });
    expect((await bearer(token).call("/api/tasks")).status).toBe(200);
  });
});
