import type { RemoteScope } from "@talorys/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_REMOTE_AUTH_FAILURES, REMOTE_REQUESTS_PER_WINDOW } from "../src/remote/tokens";
import { bearer, client, freshIp, inAgent, password } from "./helpers";

async function mint(name: string, scope: RemoteScope = "write"): Promise<string> {
  return inAgent(async (agent) => {
    agent.services.remote.setEnabled(true);
    return (await agent.services.remote.create({ name, scope })).token;
  });
}

const BAD = "tal_not-a-real-token-at-all";

/** Seconds as an integer of at least 1. */
function expectRetryAfter(res: Response): void {
  const value = res.headers.get("retry-after");
  expect(value).toMatch(/^\d+$/);
  expect(Number(value)).toBeGreaterThanOrEqual(1);
}

beforeEach(async () => {
  await inAgent((agent) => {
    agent.services.remote.revokeAll();
    agent.services.remote.setEnabled(false);
    agent.services.db.run(`DELETE FROM tal_remote_auth_failures`);
  });
});

describe("remote rate limits", () => {
  it("failed bearer throttle: the 11th attempt after 10 failures is refused, even with a good token", async () => {
    const good = await mint("good");
    const ip = freshIp();
    for (let i = 0; i < MAX_REMOTE_AUTH_FAILURES; i++) expect((await bearer(BAD, { ip }).call("/api/tasks")).status).toBe(401);
    const res = await bearer(good, { ip }).call("/api/tasks");
    expect(res.status).toBe(429);
    expectRetryAfter(res);
    expect(((await res.json()) as any).error.details.retry_after).toBeGreaterThanOrEqual(1);
    // Another client with the same token is unaffected.
    expect((await bearer(good).call("/api/tasks")).status).toBe(200);
  });

  it("failed bearer throttle: failures older than the window no longer count", async () => {
    const good = await mint("good");
    const ip = freshIp();
    await inAgent((agent) => {
      for (let i = 0; i < MAX_REMOTE_AUTH_FAILURES; i++) {
        agent.services.db.run(`INSERT INTO tal_remote_auth_failures (client, at) VALUES (?, ?)`, ip, Date.now() - 16 * 60_000);
      }
    });
    expect((await bearer(good, { ip }).call("/api/tasks")).status).toBe(200);
  });

  it("separate counters: Bearer failures do not block browser login from the same client", async () => {
    const ip = freshIp();
    for (let i = 0; i < MAX_REMOTE_AUTH_FAILURES; i++) expect((await bearer(BAD, { ip }).call("/api/tasks")).status).toBe(401);
    expect((await bearer(BAD, { ip }).call("/api/tasks")).status).toBe(429);
    const login = await client({ ip }).call("/api/auth/login", { method: "POST", body: { password: password() } });
    expect(login.status).toBe(200);
    // Requests without Authorization never touch the Bearer counters.
    const rows = await inAgent((agent) => agent.services.db.one<{ n: number }>(`SELECT count(*) AS n FROM tal_remote_auth_failures`)!.n);
    expect(rows).toBe(MAX_REMOTE_AUTH_FAILURES);
  });

  it("valid client limit: the 121st request in a minute is refused while another token still succeeds", async () => {
    const busy = bearer(await mint("busy"));
    const other = bearer(await mint("other", "read"));
    for (let i = 0; i < REMOTE_REQUESTS_PER_WINDOW; i++) expect((await busy.call("/api/health")).status).toBe(200);
    const res = await busy.call("/api/tasks");
    expect(res.status).toBe(429);
    expectRetryAfter(res);
    expect(Number(res.headers.get("retry-after"))).toBeLessThanOrEqual(60);
    expect((await other.call("/api/tasks")).status).toBe(200);
  });
});
