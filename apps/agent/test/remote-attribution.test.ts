import { beforeEach, describe, expect, it } from "vitest";
import { bearer, inAgent, loggedIn } from "./helpers";

const schedule = { type: "interval", minutes: 30 };

async function writeToken(name = "script"): Promise<{ token: string; id: string }> {
  return inAgent(async (agent) => {
    agent.services.remote.setEnabled(true);
    const created = await agent.services.remote.create({ name, scope: "write" });
    return { token: created.token, id: created.id };
  });
}

const activity = (type: string) => inAgent((agent) => agent.services.activity.list(1000).filter((a) => a.type === type));

beforeEach(async () => {
  await inAgent((agent) => {
    agent.services.remote.revokeAll();
    agent.services.remote.setEnabled(false);
  });
});

describe("remote activity attribution", () => {
  it("activity attribution: the first write in a window names token, method, path, status and id; volume is counted", async () => {
    const { token, id: tokenId } = await writeToken("attribution-bot");
    const b = bearer(token);
    const title = "Secret task title 7f3a";
    const { task } = await b.json("/api/tasks", { method: "POST", body: { title } });
    const content = "Secret note body 91c2";
    const owner = await loggedIn();
    const { note } = await owner.json("/api/notes", { method: "POST", body: { title: "Note", content } });
    expect((await b.call(`/api/notes/${note.id}`, { method: "PATCH", body: { content: `${content} edited` } })).status).toBe(200);
    expect((await b.call("/api/tasks", { method: "GET" })).status).toBe(200);
    expect((await b.call("/api/projects", { method: "POST", body: { name: "Nope" } })).status).toBe(403);

    const entries = await activity("remote.request");
    const prefix = `attribution-bot (${tokenId.slice(0, 8)})`;
    // Coalesced: only the first write in the window reaches the activity log.
    expect(entries).toHaveLength(1);
    expect(entries[0]!.summary).toBe(`${prefix} POST /api/tasks → 201 ${task.id}`);
    expect(entries.some((e) => e.summary.includes(" GET "))).toBe(false);
    for (const e of entries) {
      expect(e.summary).not.toContain(title);
      expect(e.summary).not.toContain(content);
      expect(e.summary).not.toContain(token);
    }
    // POST task + PATCH note + POST projects = 3 counted writes (GET is not a write).
    const writes = await inAgent((agent) => agent.services.remote.writesToday(tokenId));
    expect(writes).toBe(3);

    // Further writes in the same window only bump the counter.
    const missing = "0f8fad5b-d9cb-469f-a165-70867728950e";
    expect((await b.call(`/api/tasks/${missing}`, { method: "PATCH", body: { title: "x" } })).status).toBe(404);
    expect(await activity("remote.request")).toHaveLength(1);
    expect(await inAgent((agent) => agent.services.remote.writesToday(tokenId))).toBe(4);
  });

  it("auth failed: a rejected token writes remote.auth_failed with the client, not the token", async () => {
    await writeToken();
    const bad = "tal_not_a_real_token_value";
    const b = bearer(bad);
    expect((await b.call("/api/tasks")).status).toBe(401);
    const entries = await activity("remote.auth_failed");
    const entry = entries.find((e) => e.summary === `Rejected access token from client ${b.ip}`);
    expect(entry).toBeDefined();
    expect(entry!.summary).not.toContain(bad);
  });
});

describe("remote memory source", () => {
  it("memory source: Bearer-created memories are remote, cookie-created ones stay manual", async () => {
    const { token } = await writeToken();
    const remote = await bearer(token).json("/api/memories", { method: "POST", body: { content: "Remote fact: prefers tea at 4pm" } });
    expect(remote.memory.source).toBe("remote");
    const owner = await loggedIn();
    const manual = await owner.json("/api/memories", { method: "POST", body: { content: "Owner fact: likes long walks on Sundays" } });
    expect(manual.memory.source).toBe("manual");
    const { memory } = await owner.json(`/api/memories/${remote.memory.id}`);
    expect(memory.source).toBe("remote");
  });
});

describe("remote write side effects", () => {
  it("side effects: scheduling, memory history and deletion match cookie writes", async () => {
    const { token } = await writeToken();
    const b = bearer(token);
    const owner = await loggedIn();

    const { automation } = await b.json("/api/automations", { method: "POST", body: { name: "Remote reminder", kind: "reminder", message: "Ping", schedule } });
    expect(automation.next_run).not.toBeNull();

    const { memory } = await b.json("/api/memories", { method: "POST", body: { content: "Works from the Lisbon office" } });
    const patched = await b.call(`/api/memories/${memory.id}`, { method: "PATCH", body: { content: "Works from the Porto office" } });
    expect(patched.status).toBe(200);
    const history = await owner.call(`/api/memories/${memory.id}/history`);
    expect(history.status).toBe(200);
    const body = (await history.json()) as any;
    const versions = [body.memory, ...body.previous, ...body.next].map((m: any) => m.content);
    expect(versions).toContain("Works from the Porto office");

    const { task } = await b.json("/api/tasks", { method: "POST", body: { title: "Remote doomed task" } });
    expect((await b.call(`/api/tasks/${task.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await owner.call(`/api/tasks/${task.id}`)).status).toBe(404);
  });
});
