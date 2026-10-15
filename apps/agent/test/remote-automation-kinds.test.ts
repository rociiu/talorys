import { beforeEach, describe, expect, it } from "vitest";
import { bearer, inAgent, loggedIn } from "./helpers";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const FORBIDDEN = "Access tokens cannot create or change AI prompt automations.";
const schedule = { type: "interval", minutes: 30 };

async function writeToken(): Promise<string> {
  return inAgent(async (agent) => {
    agent.services.remote.setEnabled(true);
    return (await agent.services.remote.create({ name: "script", scope: "write" })).token;
  });
}

const stored = (id: string) => inAgent((agent) => agent.services.automationsRepo.get(id));

beforeEach(async () => {
  await inAgent((agent) => {
    agent.services.remote.revokeAll();
    agent.services.remote.setEnabled(false);
  });
});

describe("remote automation kinds", () => {
  it("create: reminder and task_digest succeed, agent_prompt is 403 and stores nothing", async () => {
    const b = bearer(await writeToken());
    for (const kind of ["reminder", "task_digest"]) {
      const res = await b.call("/api/automations", { method: "POST", body: { name: `Remote ${kind}`, kind, message: "Ping", schedule } });
      expect(res.status, kind).toBe(201);
      const { automation } = (await res.json()) as any;
      expect(automation.kind).toBe(kind);
      expect((await b.call(`/api/automations/${automation.id}`, { method: "DELETE" })).status).toBe(200);
    }

    const name = "Remote AI prompt";
    const res = await b.call("/api/automations", { method: "POST", body: { name, kind: "agent_prompt", message: "Summarize", schedule } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toMatchObject({ code: "FORBIDDEN", message: FORBIDDEN });
    const count = await inAgent((agent) => agent.services.automationsRepo.list().filter((a) => a.name === name).length);
    expect(count).toBe(0);

    const invalid = await b.call("/api/automations", { method: "POST", body: { kind: "agent_prompt" } });
    expect(invalid.status).toBe(400);
  });

  it("create: a cookie session can still create agent_prompt", async () => {
    const owner = await loggedIn();
    const res = await owner.call("/api/automations", { method: "POST", body: { name: "Owner AI", kind: "agent_prompt", message: "Summarize", schedule } });
    expect(res.status).toBe(201);
    const { automation } = (await res.json()) as any;
    expect((await owner.call(`/api/automations/${automation.id}`, { method: "DELETE" })).status).toBe(200);
  });

  it("patch: name, message, schedule and enabled on agent_prompt are 403 and leave it unchanged", async () => {
    const owner = await loggedIn();
    const { automation } = await owner.json("/api/automations", {
      method: "POST",
      body: { name: "Owner AI", kind: "agent_prompt", message: "Summarize", schedule },
    });
    const before = await stored(automation.id);
    const b = bearer(await writeToken());
    for (const patch of [{ name: "Renamed" }, { message: "Do more" }, { schedule: { type: "daily", time: "09:00" } }, { enabled: false }]) {
      const res = await b.call(`/api/automations/${automation.id}`, { method: "PATCH", body: patch });
      expect(res.status, JSON.stringify(patch)).toBe(403);
      expect(((await res.json()) as any).error.message).toBe(FORBIDDEN);
    }
    expect(await stored(automation.id)).toEqual(before);

    expect((await b.call(`/api/automations/${ID}`, { method: "PATCH", body: { name: "x" } })).status).toBe(404);

    const reminder = (await b.json("/api/automations", {
      method: "POST",
      body: { name: "Remote reminder", kind: "reminder", message: "Ping", schedule },
    })).automation;
    const res = await b.call(`/api/automations/${reminder.id}`, { method: "PATCH", body: { name: "Renamed reminder", enabled: false } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).automation).toMatchObject({ name: "Renamed reminder", enabled: false });

    await owner.call(`/api/automations/${automation.id}`, { method: "DELETE" });
    await owner.call(`/api/automations/${reminder.id}`, { method: "DELETE" });
  });

  it("delete: a write token can delete an agent_prompt automation", async () => {
    const owner = await loggedIn();
    const { automation } = await owner.json("/api/automations", {
      method: "POST",
      body: { name: "Owner AI", kind: "agent_prompt", message: "Summarize", schedule },
    });
    const b = bearer(await writeToken());
    expect((await b.json(`/api/automations/${automation.id}`)).automation.kind).toBe("agent_prompt");
    const res = await b.call(`/api/automations/${automation.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(await stored(automation.id)).toBeNull();
  });
});
