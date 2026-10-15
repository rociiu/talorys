import { beforeEach, describe, expect, it } from "vitest";
import { MAX_REMOTE_AUTH_FAILURES } from "../src/remote/tokens";
import { client, bearer, freshIp, inAgent } from "./helpers";

const BAD = "tal_not-a-real-token-at-all";
const OWNER_EVENTS = ["auth.password_changed", "remote.token_created", "remote.token_revoked"];
/** Leaves room for two more rows before the 1000-row trim starts evicting the oldest. */
const FILLER = 1000 - OWNER_EVENTS.length - 2;

beforeEach(async () => {
  await inAgent((agent) => {
    const { db, remote } = agent.services;
    remote.revokeAll();
    remote.setEnabled(false);
    db.run(`DELETE FROM tal_remote_auth_failures`);
    db.run(`DELETE FROM tal_remote_auth_failure_days`);
    db.run(`DELETE FROM tal_activity`);
    // Owner security events are the oldest rows, so the trim would evict them first.
    for (const type of OWNER_EVENTS) {
      db.run(`INSERT INTO tal_activity (id, type, summary, created_at) VALUES (?, ?, ?, ?)`, crypto.randomUUID(), type, type, "2026-01-01T00:00:00.000Z");
    }
    for (let i = 0; i < FILLER; i++) {
      db.run(`INSERT INTO tal_activity (id, type, summary, created_at) VALUES (?, 'task.created', 'filler', ?)`, crypto.randomUUID(), "2026-01-02T00:00:00.000Z");
    }
  });
});

const ownerEvents = () => inAgent((agent) => agent.services.activity.list(1000).filter((a) => OWNER_EVENTS.includes(a.type)).map((a) => a.type).sort());
const authFailedRows = () => inAgent((agent) => agent.services.activity.list(1000).filter((a) => a.type === "remote.auth_failed"));
const failuresToday = () => inAgent((agent) => agent.services.remote.authFailuresToday());

async function flood(ip: string, attempts: number): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < attempts; i++) statuses.push((await bearer(BAD, { ip }).call("/api/tasks")).status);
  return statuses;
}

describe("remote auth failures and the activity log", () => {
  it("remote off: a flood of bad tokens writes no activity rows but is still counted", async () => {
    const attempts = MAX_REMOTE_AUTH_FAILURES + 5;
    for (const ip of [freshIp(), freshIp(), freshIp()]) {
      const statuses = await flood(ip, attempts);
      expect(statuses.filter((s) => s === 401)).toHaveLength(MAX_REMOTE_AUTH_FAILURES);
      expect(statuses.filter((s) => s === 429)).toHaveLength(5);
    }
    expect(await authFailedRows()).toHaveLength(0);
    expect(await ownerEvents()).toEqual([...OWNER_EVENTS].sort());
    // Throttled (429) attempts are counted too.
    expect(await failuresToday()).toBe(3 * attempts);
  });

  it("remote on: at most one coalesced row per client per window, owner events survive", async () => {
    await inAgent((agent) => agent.services.remote.setEnabled(true));
    const ips = [freshIp(), freshIp()];
    for (const ip of ips) await flood(ip, MAX_REMOTE_AUTH_FAILURES + 5);
    const rows = await authFailedRows();
    expect(rows.map((r) => r.summary).sort()).toEqual(ips.map((ip) => `Rejected access token from client ${ip}`).sort());
    expect(await ownerEvents()).toEqual([...OWNER_EVENTS].sort());
    expect(await failuresToday()).toBe(2 * (MAX_REMOTE_AUTH_FAILURES + 5));
  });

  it("malformed Authorization headers are rejected and counted without activity rows", async () => {
    const ip = freshIp();
    for (const header of ["Basic abc", "Bearer", "Bearer a b"]) {
      const res = await client({ ip }).call("/api/tasks", { headers: { authorization: header } });
      expect(res.status).toBe(401);
    }
    expect(await authFailedRows()).toHaveLength(0);
    expect(await failuresToday()).toBe(3);
  });

  it("remote toggled on mid-flood: the client's window already started, so no row is added", async () => {
    const ip = freshIp();
    await flood(ip, 3);
    await inAgent((agent) => agent.services.remote.setEnabled(true));
    await flood(ip, 3);
    expect(await authFailedRows()).toHaveLength(0);
    expect(await ownerEvents()).toEqual([...OWNER_EVENTS].sort());
    expect(await failuresToday()).toBe(6);
  });
});
