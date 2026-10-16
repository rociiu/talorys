import { describe, expect, it } from "vitest";
import { LATEST_SCHEMA_VERSION } from "../src/db/migrations";
import { client, inAgent, loggedIn, readSse } from "./helpers";

describe("health", () => {
  it("reports storage and configuration without AI inference", async () => {
    const c = await loggedIn();
    const health = await c.json("/api/health");
    expect(health).toMatchObject({ ok: true, storage: "ok", schema_version: LATEST_SCHEMA_VERSION, configured: { password: true, session_secret: true } });
  });
});

describe("tasks", () => {
  it("supports create, read, update, complete, filter, search and delete", async () => {
    const c = await loggedIn();
    const { task } = await c.json("/api/tasks", { method: "POST", body: { title: "Write docs", priority: "high", due_at: "2000-01-01T10:00:00.000Z" } });
    expect(task).toMatchObject({ title: "Write docs", status: "todo", priority: "high" });
    expect((await c.json(`/api/tasks?view=overdue`)).tasks.some((t: any) => t.id === task.id)).toBe(true);
    expect((await c.json(`/api/tasks?q=docs`)).tasks.some((t: any) => t.id === task.id)).toBe(true);

    const { task: done } = await c.json(`/api/tasks/${task.id}`, { method: "PATCH", body: { status: "done" } });
    expect(done.completed_at).toBeTruthy();
    expect((await c.json(`/api/tasks?view=completed`)).tasks.some((t: any) => t.id === task.id)).toBe(true);
    const { task: reopened } = await c.json(`/api/tasks/${task.id}`, { method: "PATCH", body: { status: "todo" } });
    expect(reopened.completed_at).toBeNull();

    expect((await c.call(`/api/tasks/${task.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await c.call(`/api/tasks/${task.id}`)).status).toBe(404);
  });

  it("validates input with consistent typed errors", async () => {
    const c = await loggedIn();
    const res = await c.call("/api/tasks", { method: "POST", body: { title: "", priority: "extreme" } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    expect((await c.call("/api/tasks", { method: "POST", body: { title: "x", project_id: "missing" } })).status).toBe(400);
  });
});

describe("memories", () => {
  it("adds, searches with full-text ranking, edits, deduplicates and deletes", async () => {
    const c = await loggedIn();
    const { memory } = await c.json("/api/memories", { method: "POST", body: { content: "Prefers green tea in the morning", category: "preference" } });
    await c.json("/api/memories", { method: "POST", body: { content: "Daughter is called Maya", category: "person" } });
    const dup = await c.json("/api/memories", { method: "POST", body: { content: "prefers green tea in the morning" } });
    expect(dup.memory.id).toBe(memory.id);

    const found = await c.json("/api/memories?q=what%20tea%20do%20I%20like");
    expect(found.memories[0].id).toBe(memory.id);
    const { memory: edited } = await c.json(`/api/memories/${memory.id}`, { method: "PATCH", body: { content: "Prefers oolong tea" } });
    expect(edited.content).toBe("Prefers oolong tea");
    expect((await c.json("/api/memories?q=oolong")).memories).toHaveLength(1);
    expect((await c.json("/api/memories?q=green")).memories).toHaveLength(0);
    await c.call(`/api/memories/${memory.id}`, { method: "DELETE" });
    expect((await c.json("/api/memories?q=oolong")).memories).toHaveLength(0);
  });
});

describe("notes and projects", () => {
  it("manages Markdown notes with search and optional projects", async () => {
    const c = await loggedIn();
    const { project } = await c.json("/api/projects", { method: "POST", body: { name: "Garden" } });
    const { note } = await c.json("/api/notes", { method: "POST", body: { title: "Tomato plan", content: "# Plan\n- water daily", project_id: project.id } });
    expect((await c.json("/api/notes?q=tomato")).notes[0].id).toBe(note.id);
    expect((await c.json("/api/notes?q=water")).notes[0].id).toBe(note.id);
    await c.json(`/api/notes/${note.id}`, { method: "PATCH", body: { content: "fertilize weekly" } });
    expect((await c.json("/api/notes?q=water")).notes).toHaveLength(0);
    // Deleting a project keeps its notes.
    await c.call(`/api/projects/${project.id}`, { method: "DELETE" });
    expect((await c.json(`/api/notes/${note.id}`)).note.project_id).toBeNull();
    await c.call(`/api/notes/${note.id}`, { method: "DELETE" });
  });

  it("partial updates leave omitted fields unchanged", async () => {
    const c = await loggedIn();
    const { project } = await c.json("/api/projects", { method: "POST", body: { name: "Kitchen", description: "Renovation plan", status: "paused" } });
    const { project: archived } = await c.json(`/api/projects/${project.id}`, { method: "PATCH", body: { status: "archived" } });
    expect(archived).toMatchObject({ name: "Kitchen", description: "Renovation plan", status: "archived" });
    const { project: renamed } = await c.json(`/api/projects/${project.id}`, { method: "PATCH", body: { name: "Kitchen 2" } });
    expect(renamed).toMatchObject({ description: "Renovation plan", status: "archived" });
    await c.call(`/api/projects/${project.id}`, { method: "DELETE" });

    const { memory } = await c.json("/api/memories", { method: "POST", body: { content: "Allergic to peanuts", category: "fact" } });
    const { memory: edited } = await c.json(`/api/memories/${memory.id}`, { method: "PATCH", body: { content: "Allergic to peanuts and cashews" } });
    expect(edited.category).toBe("fact");
    await c.call(`/api/memories/${memory.id}`, { method: "DELETE" });
  });
});

describe("chat (mock provider)", () => {
  it("streams SSE events, executes tools and persists the conversation", async () => {
    const c = await loggedIn();
    const res = await c.call("/api/chat", { method: "POST", body: { message: "add task buy oat milk" } });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = await readSse(res);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("title");
    expect(types).toContain("start");
    expect(types.filter((t) => t === "text").length).toBeGreaterThan(1);
    const tools = events.filter((e) => e.type === "tool");
    expect(tools.map((t) => t.tool.status)).toEqual(["running", "success"]);
    const done = events.at(-1);
    expect(done.type).toBe("done");
    expect(done.message.content).toContain("buy oat milk");

    const convId = events.find((e) => e.type === "start").conversation_id;
    const conv = await c.json(`/api/conversations/${convId}`);
    expect(conv.messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
    expect(conv.messages[1].tools[0].name).toBe("create_task");
    expect((await c.json("/api/tasks?q=oat")).tasks).toHaveLength(1);

    // Continue the same conversation, rename, search and delete it.
    await readSse(await c.call("/api/chat", { method: "POST", body: { conversation_id: convId, message: "list tasks" } }));
    expect((await c.json(`/api/conversations/${convId}`)).messages).toHaveLength(4);
    await c.json(`/api/conversations/${convId}`, { method: "PATCH", body: { title: "Groceries" } });
    expect((await c.json("/api/conversations?q=oat")).conversations[0].title).toBe("Groceries");
    await c.call(`/api/conversations/${convId}`, { method: "DELETE" });
    expect((await c.call(`/api/conversations/${convId}`)).status).toBe(404);
  });

  it("deletes through chat only after the owner approves the proposed action", async () => {
    const c = await loggedIn();
    const { task } = await c.json("/api/tasks", { method: "POST", body: { title: "Approve-me chores" } });
    const events = await readSse(await c.call("/api/chat", { method: "POST", body: { message: "delete task Approve-me chores" } }));
    const toolEnd = events.filter((e) => e.type === "tool").at(-1).tool;
    expect(toolEnd).toMatchObject({ name: "delete_task", status: "success", approval: { status: "pending", summary: "Delete task “Approve-me chores”" } });
    expect((await c.call(`/api/tasks/${task.id}`)).status).toBe(200);

    const convId = events.find((e) => e.type === "start").conversation_id;
    const actionId = toolEnd.approval.id;
    // Anonymous callers and requests without the CSRF header cannot approve.
    expect((await client().call(`/api/actions/${actionId}/approve`, { method: "POST", body: {} })).status).toBe(401);
    expect((await c.call(`/api/actions/${actionId}/approve`, { method: "POST", body: {}, headers: { "x-talorys-request": "" } })).status).toBe(403);
    expect((await c.call(`/api/tasks/${task.id}`)).status).toBe(200);

    const approved = await c.json(`/api/actions/${actionId}/approve`, { method: "POST", body: {} });
    expect(approved.action.status).toBe("approved");
    expect((await c.call(`/api/tasks/${task.id}`)).status).toBe(404);
    expect((await c.call(`/api/actions/${actionId}/approve`, { method: "POST", body: {} })).status).toBe(409);
    const conv = await c.json(`/api/conversations/${convId}`);
    expect(conv.messages[1].tools[0].approval.status).toBe("approved");

    // A declined proposal leaves the task alone.
    const { task: other } = await c.json("/api/tasks", { method: "POST", body: { title: "Decline-me chores" } });
    const second = await readSse(
      await c.call("/api/chat", { method: "POST", body: { conversation_id: convId, message: "delete task Decline-me chores" } }),
    );
    const otherId = second.filter((e) => e.type === "tool").at(-1).tool.approval.id;
    expect((await c.json(`/api/actions/${otherId}/cancel`, { method: "POST", body: {} })).action.status).toBe("cancelled");
    expect((await c.call(`/api/actions/${otherId}/approve`, { method: "POST", body: {} })).status).toBe(409);
    expect((await c.call(`/api/tasks/${other.id}`)).status).toBe(200);
    expect((await c.call(`/api/actions/missing/approve`, { method: "POST", body: {} })).status).toBe(404);
  });

  it("rejects a second concurrent turn in the same conversation", async () => {
    const c = await loggedIn();
    const { conversation } = await c.json("/api/conversations", { method: "POST", body: {} });
    const body = { conversation_id: conversation.id, message: "list tasks" };
    const results = await Promise.all([c.call("/api/chat", { method: "POST", body }), c.call("/api/chat", { method: "POST", body })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    await readSse(results.find((r) => r.status === 200)!);
    expect((await c.json(`/api/conversations/${conversation.id}`)).messages).toHaveLength(2);
    await c.call(`/api/conversations/${conversation.id}`, { method: "DELETE" });
  });

  it("enforces the daily AI request limit and still serves non-AI features", async () => {
    const c = await loggedIn();
    await c.json("/api/settings", { method: "PATCH", body: { limits: { maxAiRequestsPerDay: 1 } } });
    await inAgent((a) => a.services.usage.increment({ ai_requests: 5 }));
    const events = await readSse(await c.call("/api/chat", { method: "POST", body: { message: "hello" } }));
    expect(events.find((e) => e.type === "error")).toMatchObject({ code: "AI_LIMIT_REACHED" });
    expect(events.at(-1).message.status).toBe("error");
    expect((await c.call("/api/tasks")).status).toBe(200);
    await c.json("/api/settings", { method: "PATCH", body: { limits: { maxAiRequestsPerDay: 200 } } });
    await inAgent((a) => a.services.db.run(`DELETE FROM tal_usage_daily`));
  });

  it("retries a failed reply without duplicating the owner's message", async () => {
    const c = await loggedIn();
    await c.json("/api/settings", { method: "PATCH", body: { limits: { maxAiRequestsPerDay: 1 } } });
    await inAgent((a) => a.services.usage.increment({ ai_requests: 5 }));
    const first = await readSse(await c.call("/api/chat", { method: "POST", body: { message: "list tasks" } }));
    const convId = first.find((e) => e.type === "start").conversation_id;
    await c.json("/api/settings", { method: "PATCH", body: { limits: { maxAiRequestsPerDay: 200 } } });
    await inAgent((a) => a.services.db.run(`DELETE FROM tal_usage_daily`));
    const retry = await readSse(await c.call("/api/chat", { method: "POST", body: { conversation_id: convId, message: "retry", retry: true } }));
    expect(retry.at(-1).message.status).toBe("complete");
    const msgs = (await c.json(`/api/conversations/${convId}`)).messages;
    expect(msgs.map((m: any) => `${m.role}:${m.status}`)).toEqual(["user:complete", "assistant:complete"]);
  });
});

describe("settings, usage, export and import", () => {
  it("validates settings changes", async () => {
    const c = await loggedIn();
    expect((await c.call("/api/settings", { method: "PATCH", body: { timezone: "Nowhere/City" } })).status).toBe(400);
    expect((await c.call("/api/settings", { method: "PATCH", body: { limits: { maxToolCalls: 9999 } } })).status).toBe(400);
    const { settings } = await c.json("/api/settings", { method: "PATCH", body: { agentName: "Ada", timezone: "Europe/Paris" } });
    expect(settings).toMatchObject({ agentName: "Ada", timezone: "Europe/Paris", model: "@cf/zai-org/glm-4.7-flash" });
    await c.json("/api/settings", { method: "PATCH", body: { agentName: "Talorys", timezone: "UTC" } });
  });

  it("stores the UI language and returns it with the session", async () => {
    const c = await loggedIn();
    expect((await c.json("/api/settings")).settings.language).toBe("system");
    expect((await c.call("/api/settings", { method: "PATCH", body: { language: "xx" } })).status).toBe(400);
    await c.json("/api/settings", { method: "PATCH", body: { language: "en" } });
    expect(await c.json("/api/auth/session")).toMatchObject({ authenticated: true, language: "en" });
    expect((await client().json("/api/auth/session")).language).toBeUndefined();
    await c.json("/api/settings", { method: "PATCH", body: { language: "system" } });
  });

  it("reports local usage estimates and clearly labels them", async () => {
    const usage = await (await loggedIn()).json("/api/usage");
    expect(usage.note).toMatch(/estimates/i);
    expect(usage.dashboard_url).toContain("dash.cloudflare.com");
  });

  it("exports a backup without secrets and imports it idempotently", async () => {
    const c = await loggedIn();
    await c.json("/api/tasks", { method: "POST", body: { title: "Backup me" } });
    await c.json("/api/memories", { method: "POST", body: { content: "Likes hiking in autumn" } });
    const res = await c.call("/api/export");
    expect(res.headers.get("content-disposition")).toContain("talorys-backup.json");
    const text = await res.text();
    expect(text).not.toMatch(/pbkdf2|tal_sessions|session_secret|password_override/i);
    const backup = JSON.parse(text);
    expect(backup).toMatchObject({ format: "talorys-backup", version: 1 });

    // Wipe a task, then import twice: restored once, no duplicates.
    const task = backup.data.tasks.find((t: any) => t.title === "Backup me");
    await c.call(`/api/tasks/${task.id}`, { method: "DELETE" });
    for (let i = 0; i < 2; i++) expect((await c.call("/api/import", { method: "POST", body: backup })).status).toBe(200);
    expect((await c.json("/api/tasks?q=Backup")).tasks).toHaveLength(1);

    // Importing a disabled copy of an armed automation pauses it and drops its live schedule.
    const { automation } = await c.json("/api/automations", { method: "POST", body: { name: "Daily", kind: "reminder", message: "Stretch", schedule: { type: "daily", time: "08:00" } } });
    const disabled = { ...backup, data: { ...backup.data, automations: [{ id: automation.id, name: "Daily", kind: "reminder", message: "Stretch", schedule: automation.schedule, enabled: false }] } };
    expect((await c.call("/api/import", { method: "POST", body: disabled })).status).toBe(200);
    const paused = (await c.json("/api/automations")).automations.find((a: any) => a.id === automation.id);
    expect(paused).toMatchObject({ enabled: false, status: "paused", schedule_id: null, next_run: null });
    expect(await inAgent((a) => a.getScheduleById(automation.schedule_id))).toBeUndefined();
    await c.call(`/api/automations/${automation.id}`, { method: "DELETE" });

    // Invalid and future-version backups are rejected without changes.
    expect((await c.call("/api/import", { method: "POST", body: { format: "nope" } })).status).toBe(400);
    expect((await c.call("/api/import", { method: "POST", body: { ...backup, version: 99 } })).status).toBe(400);
  });
});
