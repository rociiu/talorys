import { beforeEach, describe, expect, it } from "vitest";
import { REMOTE_REQUESTS_PER_WINDOW } from "../src/remote/tokens";
import { bearer, inAgent } from "./helpers";

const OWNER_EVENTS = ["auth.password_changed", "remote.token_created", "remote.token_revoked"];
/** Leaves room for two more rows before the 1000-row trim starts evicting the oldest. */
const FILLER = 1000 - OWNER_EVENTS.length - 2;

beforeEach(async () => {
  await inAgent((agent) => {
    const { db, remote } = agent.services;
    remote.revokeAll();
    remote.setEnabled(false);
    db.run(`DELETE FROM tal_remote_write_days`);
    db.run(`DELETE FROM tal_activity`);
    // Owner security events are the oldest rows, so the trim would evict them first.
    for (const type of OWNER_EVENTS) {
      db.run(`INSERT INTO tal_activity (id, type, summary, created_at) VALUES (?, ?, ?, ?)`, crypto.randomUUID(), type, type, "2026-01-01T00:00:00.000Z");
    }
    for (let i = 0; i < FILLER; i++) {
      db.run(`INSERT INTO tal_activity (id, type, summary, created_at) VALUES (?, "task.created", "filler", ?)`, crypto.randomUUID(), "2026-01-02T00:00:00.000Z");
    }
  });
});

const ownerEvents = () =>
  inAgent((agent) =>
    agent.services.activity
      .list(1000)
      .filter((a) => OWNER_EVENTS.includes(a.type))
      .map((a) => a.type)
      .sort(),
  );
const remoteRequestRows = () => inAgent((agent) => agent.services.activity.list(1000).filter((a) => a.type === "remote.request"));

describe("remote write activity coalesce", () => {
  it("a flood of remote writes keeps owner events and coalesces activity to one row per token", async () => {
    const { token, id: tokenId } = await inAgent(async (agent) => {
      agent.services.remote.setEnabled(true);
      const created = await agent.services.remote.create({ name: "flood-bot", scope: "write" });
      return { token: created.token, id: created.id };
    });
    const b = bearer(token);
    // Stay under the soft per-token rate limit so every attempt is a real write.
    const attempts = REMOTE_REQUESTS_PER_WINDOW;
    const statuses: number[] = [];
    for (let i = 0; i < attempts; i++) {
      statuses.push((await b.call("/api/tasks", { method: "POST", body: { title: `flood-${i}` } })).status);
    }
    expect(statuses.every((s) => s === 201)).toBe(true);
    expect(await ownerEvents()).toEqual([...OWNER_EVENTS].sort());
    const rows = await remoteRequestRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.summary.startsWith(`flood-bot (${tokenId.slice(0, 8)}) POST /api/tasks → 201 `)).toBe(true);
    expect(await inAgent((agent) => agent.services.remote.writesToday(tokenId))).toBe(attempts);
  });

  it("two tokens each get one coalesced row; counters stay per-token", async () => {
    const tokens = await inAgent(async (agent) => {
      agent.services.remote.setEnabled(true);
      const a = await agent.services.remote.create({ name: "bot-a", scope: "write" });
      const b = await agent.services.remote.create({ name: "bot-b", scope: "write" });
      return [
        { token: a.token, id: a.id, name: "bot-a" },
        { token: b.token, id: b.id, name: "bot-b" },
      ];
    });
    for (const t of tokens) {
      const client = bearer(t.token);
      for (let i = 0; i < 5; i++) {
        expect((await client.call("/api/tasks", { method: "POST", body: { title: `${t.name}-${i}` } })).status).toBe(201);
      }
    }
    expect(await ownerEvents()).toEqual([...OWNER_EVENTS].sort());
    const rows = await remoteRequestRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.summary.split(" ")[0]!).sort()).toEqual(["bot-a", "bot-b"]);
    for (const t of tokens) {
      expect(await inAgent((agent) => agent.services.remote.writesToday(t.id))).toBe(5);
    }
    expect(await inAgent((agent) => agent.services.remote.writesToday())).toBe(10);
  });
});
