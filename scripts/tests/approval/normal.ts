import type { TestCase } from "../../massive-harness";
import { assert, assertEquals, assertMatch, assertRejects, createTestEnv } from "./helpers";
import { ALL_TOOLS } from "../../../apps/agent/src/tools";
import { runApprovedAction, ToolExecutor, defineTool, type ToolDefinition } from "../../../apps/agent/src/tools/registry";
import { PENDING_ACTION_TTL_MS } from "../../../apps/agent/src/db/repositories/pending-actions";
import { z } from "zod";

export const normalTests: TestCase[] = [];

function add(id: string, description: string, run: () => Promise<void> | void) {
  normalTests.push({
    id,
    domain: "approval-tools",
    category: "normal",
    description,
    run,
  });
}

// 1. Tool registration, discovery & structure (001 - 010)
add("approval-normal-001", "ALL_TOOLS contains expected set of core tools", () => {
  assert(ALL_TOOLS.length >= 20, `Expected at least 20 tools but found ${ALL_TOOLS.length}`);
  const names = ALL_TOOLS.map((t) => t.name);
  assert(names.includes("delete_task"), "Missing delete_task");
  assert(names.includes("delete_note"), "Missing delete_note");
  assert(names.includes("forget_memory"), "Missing forget_memory");
  assert(names.includes("cancel_automation"), "Missing cancel_automation");
});

add("approval-normal-002", "Every tool in ALL_TOOLS has unique name, valid description and schema", () => {
  const seen = new Set<string>();
  for (const t of ALL_TOOLS) {
    assert(!seen.has(t.name), `Duplicate tool name: ${t.name}`);
    seen.add(t.name);
    assert(typeof t.description === "string" && t.description.length > 0, `${t.name} missing description`);
    assert(typeof t.input?.safeParse === "function", `${t.name} missing valid zod schema`);
    assert(typeof t.label === "function", `${t.name} missing label generator`);
    assert(["read", "write", "destructive"].includes(t.permission), `${t.name} has invalid permission: ${t.permission}`);
  }
});

add("approval-normal-003", "Destructive tools implement prepare and commit, immediate tools implement execute", () => {
  for (const t of ALL_TOOLS) {
    if (t.permission === "destructive") {
      assert(typeof (t as any).prepare === "function", `Destructive tool ${t.name} must implement prepare`);
      assert(typeof (t as any).commit === "function", `Destructive tool ${t.name} must implement commit`);
      assert((t as any).execute === undefined, `Destructive tool ${t.name} must not have execute`);
    } else {
      assert(typeof (t as any).execute === "function", `Immediate tool ${t.name} must implement execute`);
      assert((t as any).prepare === undefined, `Immediate tool ${t.name} must not have prepare`);
      assert((t as any).commit === undefined, `Immediate tool ${t.name} must not have commit`);
    }
  }
});

add("approval-normal-004", "ToolExecutor.available() in chat mode returns all tools including write and destructive", () => {
  const env = createTestEnv({ mode: "chat" });
  const avail = env.executor.available();
  const destructive = avail.filter((t) => t.permission === "destructive");
  const write = avail.filter((t) => t.permission === "write");
  const read = avail.filter((t) => t.permission === "read");
  assert(destructive.length >= 4, "Chat mode must have destructive tools");
  assert(write.length >= 5, "Chat mode must have write tools");
  assert(read.length >= 5, "Chat mode must have read tools");
});

add("approval-normal-005", "ToolExecutor.available() in scheduled mode excludes write and destructive tools except notify_owner", () => {
  const env = createTestEnv({ mode: "scheduled" });
  const avail = env.executor.available();
  for (const t of avail) {
    assert(t.permission === "read" || t.name === "notify_owner", `Scheduled mode must only have read or notify_owner, found ${t.name}`);
  }
});

add("approval-normal-006", "ToolExecutor.find returns correct definition by name in chat mode", () => {
  const env = createTestEnv({ mode: "chat" });
  const t = env.executor.find("delete_task");
  assert(t !== undefined, "Should find delete_task");
  assertEquals(t?.permission, "destructive");
  assertEquals(t?.name, "delete_task");
});

add("approval-normal-007", "ToolExecutor.find returns undefined for non-existent tool", () => {
  const env = createTestEnv({ mode: "chat" });
  const t = env.executor.find("non_existent_tool_xyz");
  assertEquals(t, undefined);
});

add("approval-normal-008", "ToolExecutor tracks calls count correctly", async () => {
  const env = createTestEnv({ mode: "chat" });
  assertEquals(env.executor.callCount, 0);
  await env.executor.execute("create_task", { title: "Call count test 1" });
  assertEquals(env.executor.callCount, 1);
  await env.executor.execute("create_task", { title: "Call count test 2" });
  assertEquals(env.executor.callCount, 2);
});

add("approval-normal-009", "ToolExecutor.budgetExhausted returns false initially and true when limit reached", async () => {
  const env = createTestEnv({ mode: "chat", maxToolCalls: 2 });
  assertEquals(env.executor.budgetExhausted(), false);
  await env.executor.execute("create_task", { title: "Budget test 1" });
  assertEquals(env.executor.budgetExhausted(), false);
  await env.executor.execute("create_task", { title: "Budget test 2" });
  assertEquals(env.executor.budgetExhausted(), true);
});

add("approval-normal-010", "Tool label function generates readable label with input parameters", () => {
  const delTask = ALL_TOOLS.find((t) => t.name === "delete_task")!;
  const label = delTask.label({ task: "Clean desk" });
  assert(label.includes("Clean desk"), `Label must mention task name: ${label}`);
});

// 2. Immediate read & write tools execution (011 - 025)
add("approval-normal-011", "create_task tool creates task in DB and returns presentTask format", async () => {
  const env = createTestEnv();
  const res = (await env.executor.execute("create_task", { title: "Buy groceries", priority: "high" })) as any;
  assert(res?.created?.id, "Should return created task id");
  assertEquals(res.created.title, "Buy groceries");
  assertEquals(res.created.priority, "high");
  const stored = env.services.tasks.get(res.created.id);
  assert(stored !== null, "Task should exist in DB");
  assertEquals(stored?.title, "Buy groceries");
});

add("approval-normal-012", "list_tasks tool retrieves tasks created by agent", async () => {
  const env = createTestEnv();
  await env.executor.execute("create_task", { title: "Task A" });
  await env.executor.execute("create_task", { title: "Task B" });
  const res = (await env.executor.execute("list_tasks", {})) as any;
  assert(Array.isArray(res?.tasks), "Should return array of tasks");
  assert(res.tasks.some((t: any) => t.title === "Task A"), "Task A should be in list");
  assert(res.tasks.some((t: any) => t.title === "Task B"), "Task B should be in list");
});

add("approval-normal-013", "update_task tool updates task status and priority", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Old task", priority: "low" });
  const res = (await env.executor.execute("update_task", { task: task.id, title: "Updated task", priority: "high" })) as any;
  assertEquals(res?.updated?.title, "Updated task");
  assertEquals(res?.updated?.priority, "high");
  const stored = env.services.tasks.get(task.id);
  assertEquals(stored?.title, "Updated task");
  assertEquals(stored?.priority, "high");
});

add("approval-normal-014", "complete_task tool marks task as done", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Finish homework" });
  const res = (await env.executor.execute("complete_task", { task: task.id })) as any;
  assertEquals(res?.completed?.status, "done");
  const stored = env.services.tasks.get(task.id);
  assertEquals(stored?.status, "done");
  assert(stored?.completed_at !== null, "completed_at should be recorded");
});

add("approval-normal-015", "create_note tool stores note with markdown content", async () => {
  const env = createTestEnv();
  const res = (await env.executor.execute("create_note", { title: "Meeting Notes", content: "# Meeting\n- item 1" })) as any;
  assert(res?.created?.id, "Should return created note id");
  assertEquals(res.created.title, "Meeting Notes");
  const stored = env.services.notes.get(res.created.id);
  assertEquals(stored?.content, "# Meeting\n- item 1");
});

add("approval-normal-016", "read_note tool retrieves note by id", async () => {
  const env = createTestEnv();
  const note = env.services.notes.create({ title: "Design Spec", content: "Details here" });
  const res = (await env.executor.execute("read_note", { id: note.id })) as any;
  assertEquals(res?.id, note.id);
  assertEquals(res?.content, "Details here");
});

add("approval-normal-017", "search_notes tool finds note by text match", async () => {
  const env = createTestEnv();
  env.services.notes.create({ title: "Recipe", content: "Bake cookies with chocolate" });
  const res = (await env.executor.execute("search_notes", { query: "chocolate" })) as any;
  assert(Array.isArray(res?.results), "Should return results array");
  assert(res.results.some((n: any) => n.title === "Recipe"), "Should find Recipe note");
});

add("approval-normal-018", "create_project and list_projects tools manage projects", async () => {
  const env = createTestEnv();
  const res = (await env.executor.execute("create_project", { name: "Project Alpha", description: "First project" })) as any;
  assert(res?.created?.id, "Should return project id");
  const list = (await env.executor.execute("list_projects", {})) as any;
  assert(list.projects.some((p: any) => p.name === "Project Alpha"), "Should list created project");
});

add("approval-normal-019", "remember tool stores long-term memory fact", async () => {
  const env = createTestEnv();
  const res = (await env.executor.execute("remember", { content: "User lives in Seoul", category: "fact" })) as any;
  assert(res?.remembered?.id, "Should return remembered id");
  assertEquals(res.remembered.content, "User lives in Seoul");
  const stored = env.services.memories.get(res.remembered.id);
  assert(stored !== null, "Memory should be persisted in DB");
});

add("approval-normal-020", "search_memories tool retrieves matching memories", async () => {
  const env = createTestEnv();
  env.services.memories.create({ content: "Prefers oat milk in coffee", category: "preference", source: "chat" });
  const res = (await env.executor.execute("search_memories", { query: "coffee" })) as any;
  assert(Array.isArray(res?.memories), "Should return memories array");
  assert(res.memories.some((m: any) => m.content.includes("oat milk")), "Should find oat milk preference");
});

add("approval-normal-021", "notify_owner tool creates owner notification record", async () => {
  const env = createTestEnv();
  const res = (await env.executor.execute("notify_owner", { title: "Alert", body: "Task was completed" })) as any;
  assert(typeof res?.notified === "string", "notified should return notification id");
  const list = env.services.notifications.list();
  assert(list.some((n) => n.title === "Alert" && n.body === "Task was completed"), "Notification should be in DB");
});

add("approval-normal-022", "create_reminder tool creates a timed reminder automation", async () => {
  const env = createTestEnv();
  const res = (await env.executor.execute("create_reminder", { message: "Drink Water", at: "2026-10-15T14:00" })) as any;
  assert(res?.reminder?.id, "Should return created reminder id");
  assertEquals(res.reminder.message, "Drink Water");
  const stored = env.services.automationsRepo.get(res.reminder.id);
  assert(stored !== null, "Automation should be in DB");
  assertEquals(stored?.kind, "reminder");
});

add("approval-normal-023", "list_automations tool lists registered automations", async () => {
  const env = createTestEnv();
  await env.executor.execute("create_reminder", { message: "Walk Dog", at: "2026-10-15T18:00" });
  const res = (await env.executor.execute("list_automations", {})) as any;
  assert(Array.isArray(res?.automations), "Should return automations array");
  assert(res.automations.some((a: any) => a.name === "Walk Dog"), "Should list Walk Dog");
});

add("approval-normal-024", "search tool searches across tasks and notes simultaneously", async () => {
  const env = createTestEnv();
  env.services.tasks.create({ title: "Renew passport" });
  env.services.notes.create({ title: "Passport details", content: "Expires soon" });
  const res = (await env.executor.execute("search", { query: "passport" })) as any;
  assert(res.tasks?.some((t: any) => t.title.includes("passport")), "Should find passport task");
  assert(res.notes?.some((n: any) => n.title.includes("Passport")), "Should find passport note");
});

add("approval-normal-025", "read_note returns empty excerpt for note with empty content", async () => {
  const env = createTestEnv();
  const note = env.services.notes.create({ title: "Empty Note", content: "" });
  const res = (await env.executor.execute("read_note", { id: note.id })) as any;
  assertEquals(res?.id, note.id);
  assertEquals(res?.content, "");
});

// 3. Destructive tool preparation & proposal (026 - 045)
add("approval-normal-026", "delete_task execution creates pending action without deleting task", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Important Task" });
  const res = (await env.executor.execute("delete_task", { task: task.id }, "call_del_1")) as any;
  assertEquals(res.status, "awaiting_owner_approval");
  assert(res.action.includes("Important Task"), `Proposal summary must include task title: ${res.action}`);
  // Task must still exist!
  assert(env.services.tasks.get(task.id) !== null, "Task must NOT be deleted before approval");
});

add("approval-normal-027", "delete_task attaches PendingAction to callId via approvalFor", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Task 27" });
  await env.executor.execute("delete_task", { task: task.id }, "call_27");
  const action = env.executor.approvalFor("call_27");
  assert(action !== undefined, "approvalFor must return PendingAction");
  assertEquals(action?.status, "pending");
  assertEquals(action?.error, null);
  assert(action?.summary.includes("Task 27"), "Summary must mention task");
});

add("approval-normal-028", "delete_task resolves task by partial title in prepare", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Prepare quarterly budget review" });
  const res = (await env.executor.execute("delete_task", { task: "budget review" })) as any;
  assertEquals(res.status, "awaiting_owner_approval");
  assert(res.action.includes("budget review"), "Should resolve by partial title");
});

add("approval-normal-029", "delete_note creates pending action without deleting note", async () => {
  const env = createTestEnv();
  const note = env.services.notes.create({ title: "Secret Diary", content: "Top secret" });
  const res = (await env.executor.execute("delete_note", { id: note.id }, "call_note_1")) as any;
  assertEquals(res.status, "awaiting_owner_approval");
  assert(res.action.includes("Secret Diary"), "Summary must include note title");
  assert(env.services.notes.get(note.id) !== null, "Note must NOT be deleted yet");
});

add("approval-normal-030", "delete_note proposal records tool name and target_id in tal_pending_actions", async () => {
  const env = createTestEnv();
  const note = env.services.notes.create({ title: "Note 30", content: "abc" });
  await env.executor.execute("delete_note", { id: note.id }, "call_note_30");
  const action = env.executor.approvalFor("call_note_30")!;
  const stored = env.services.pendingActions.get(action.id);
  assert(stored !== null, "Stored pending action should exist in DB");
  assertEquals(stored?.tool, "delete_note");
  assertEquals(stored?.target_id, note.id);
  assertEquals(stored?.status, "pending");
});

add("approval-normal-031", "forget_memory creates pending action without deleting memory", async () => {
  const env = createTestEnv();
  const mem = env.services.memories.create({ content: "User likes cats", category: "preference", source: "chat" });
  const res = (await env.executor.execute("forget_memory", { id: mem.id }, "call_mem_1")) as any;
  assertEquals(res.status, "awaiting_owner_approval");
  assert(res.action.includes("User likes cats"), "Summary must include memory content");
  assert(env.services.memories.get(mem.id) !== null, "Memory must NOT be deleted yet");
});

add("approval-normal-032", "forget_memory records correct conversation_id in pending action", async () => {
  const env = createTestEnv();
  const mem = env.services.memories.create({ content: "Memory 32", category: "fact", source: "chat" });
  await env.executor.execute("forget_memory", { id: mem.id }, "call_32");
  const action = env.executor.approvalFor("call_32")!;
  const stored = env.services.pendingActions.get(action.id)!;
  assertEquals(stored.conversation_id, env.conversation.id);
});

add("approval-normal-033", "cancel_automation creates pending action without cancelling automation", async () => {
  const env = createTestEnv();
  const auto = env.services.automationsRepo.create({
    name: "Nightly Summary",
    kind: "automation",
    schedule: "0 22 * * *",
    message: "Summarize day",
  });
  const res = (await env.executor.execute("cancel_automation", { id: auto.id }, "call_auto_1")) as any;
  assertEquals(res.status, "awaiting_owner_approval");
  assert(res.action.includes("Nightly Summary"), "Summary must include automation name");
  assert(env.services.automationsRepo.get(auto.id) !== null, "Automation must NOT be deleted yet");
});

add("approval-normal-034", "pending action expires_at is set to exactly 30 minutes in the future", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Task 34" });
  const before = Date.now();
  await env.executor.execute("delete_task", { task: task.id }, "call_34");
  const action = env.executor.approvalFor("call_34")!;
  const after = Date.now();
  const expiresAtMs = Date.parse(action.expires_at);
  const diff = expiresAtMs - before;
  assert(diff >= PENDING_ACTION_TTL_MS - 5000 && diff <= PENDING_ACTION_TTL_MS + (after - before) + 5000, `Expected TTL around 30m, got diff ${diff}ms`);
});

add("approval-normal-035", "pendingActions.view returns clean public PendingAction object", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Task 35" });
  await env.executor.execute("delete_task", { task: task.id }, "call_35");
  const action = env.executor.approvalFor("call_35")!;
  const viewed = env.services.pendingActions.view(action.id);
  assert(viewed !== null, "Viewed action should not be null");
  assertEquals(viewed?.id, action.id);
  assertEquals(viewed?.status, "pending");
  assertEquals(viewed?.error, null);
  assert(viewed?.summary.length > 0, "Summary should exist");
  assert(viewed?.expires_at.length > 0, "expires_at should exist");
  // Ensure internal columns like target_id, conversation_id are not exposed on view
  assert((viewed as any).target_id === undefined, "target_id should not be on view object");
  assert((viewed as any).conversation_id === undefined, "conversation_id should not be on view object");
});

add("approval-normal-036", "pendingActions.get returns full stored record with internal metadata", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Task 36" });
  await env.executor.execute("delete_task", { task: task.id }, "call_36");
  const action = env.executor.approvalFor("call_36")!;
  const stored = env.services.pendingActions.get(action.id);
  assert(stored !== null, "Stored record should exist");
  assertEquals(stored?.tool, "delete_task");
  assertEquals(stored?.target_id, task.id);
  assertEquals(stored?.conversation_id, env.conversation.id);
  assertEquals(stored?.resolved_at, null);
});

add("approval-normal-037", "Multiple destructive proposals can be created in the same turn within limits", async () => {
  const env = createTestEnv({ maxToolCalls: 10 });
  const t1 = env.services.tasks.create({ title: "Task A" });
  const t2 = env.services.tasks.create({ title: "Task B" });
  const t3 = env.services.tasks.create({ title: "Task C" });
  await env.executor.execute("delete_task", { task: t1.id }, "call_a");
  await env.executor.execute("delete_task", { task: t2.id }, "call_b");
  await env.executor.execute("delete_task", { task: t3.id }, "call_c");
  const a1 = env.executor.approvalFor("call_a");
  const a2 = env.executor.approvalFor("call_b");
  const a3 = env.executor.approvalFor("call_c");
  assert(a1 && a2 && a3, "All three approvals should be registered");
  assert(a1.id !== a2.id && a2.id !== a3.id, "All action IDs must be distinct");
});

add("approval-normal-038", "destructive tool without callId still creates pending action in DB", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Task 38" });
  const res = (await env.executor.execute("delete_task", { task: task.id })) as any;
  assertEquals(res.status, "awaiting_owner_approval");
  // Check that row exists in DB
  const rows = env.services.db.all<{ id: string }>("SELECT id FROM tal_pending_actions WHERE target_id = ?", task.id);
  assertEquals(rows.length, 1);
});

add("approval-normal-039", "approval response contains instruction note for AI agent", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Task 39" });
  const res = (await env.executor.execute("delete_task", { task: task.id })) as any;
  assert(typeof res.note === "string", "Note should be a string");
  assert(res.note.includes("Approve button"), "Note should instruct about Approve button");
  assert(res.note.includes("Do not call this tool again"), "Note should instruct not to call again");
});

add("approval-normal-040", "pending action created_at matches current timestamp", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Task 40" });
  const t0 = new Date().toISOString();
  await env.executor.execute("delete_task", { task: task.id }, "call_40");
  const action = env.executor.approvalFor("call_40")!;
  const stored = env.services.pendingActions.get(action.id)!;
  assert(stored.created_at.slice(0, 10) === t0.slice(0, 10), "Date part of created_at should match today");
});

// 4. Approval and execution (041 - 055)
add("approval-normal-041", "runApprovedAction successfully deletes task upon approval", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Task to delete" });
  await env.executor.execute("delete_task", { task: task.id }, "call_41");
  const action = env.executor.approvalFor("call_41")!;
  const result = await runApprovedAction(ALL_TOOLS, env.ctx, action.id);
  assertEquals(result.status, "approved");
  assertEquals(result.error, null);
  assertEquals(env.services.tasks.get(task.id), null);
});

add("approval-normal-042", "runApprovedAction logs activity upon task deletion", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Tracked Task" });
  await env.executor.execute("delete_task", { task: task.id }, "call_42");
  const action = env.executor.approvalFor("call_42")!;
  await runApprovedAction(ALL_TOOLS, env.ctx, action.id);
  const activities = env.services.db.all<{ type: string; summary: string }>("SELECT type, summary FROM tal_activity ORDER BY created_at DESC");
  const delActivity = activities.find((a) => a.type === "task.deleted");
  assert(delActivity !== undefined, "Should log task.deleted activity");
  assert(delActivity.summary.includes("Tracked Task"), "Activity summary should mention task title");
});

add("approval-normal-043", "runApprovedAction successfully deletes note upon approval", async () => {
  const env = createTestEnv();
  const note = env.services.notes.create({ title: "Delete Me", content: "Content" });
  await env.executor.execute("delete_note", { id: note.id }, "call_43");
  const action = env.executor.approvalFor("call_43")!;
  const res = await runApprovedAction(ALL_TOOLS, env.ctx, action.id);
  assertEquals(res.status, "approved");
  assertEquals(env.services.notes.get(note.id), null);
});

add("approval-normal-044", "runApprovedAction logs activity upon note deletion", async () => {
  const env = createTestEnv();
  const note = env.services.notes.create({ title: "Tracked Note", content: "Spec" });
  await env.executor.execute("delete_note", { id: note.id }, "call_44");
  const action = env.executor.approvalFor("call_44")!;
  await runApprovedAction(ALL_TOOLS, env.ctx, action.id);
  const activities = env.services.db.all<{ type: string; summary: string }>("SELECT type, summary FROM tal_activity WHERE type = 'note.deleted'");
  assertEquals(activities.length, 1);
  assert(activities[0].summary.includes("Tracked Note"), "Summary must mention note title");
});

add("approval-normal-045", "runApprovedAction successfully forgets memory upon approval", async () => {
  const env = createTestEnv();
  const mem = env.services.memories.create({ content: "Old Fact", category: "fact", source: "chat" });
  await env.executor.execute("forget_memory", { id: mem.id }, "call_45");
  const action = env.executor.approvalFor("call_45")!;
  const res = await runApprovedAction(ALL_TOOLS, env.ctx, action.id);
  assertEquals(res.status, "approved");
  assertEquals(env.services.memories.get(mem.id), null);
});

add("approval-normal-046", "runApprovedAction logs activity upon memory deletion", async () => {
  const env = createTestEnv();
  const mem = env.services.memories.create({ content: "Disliked food", category: "preference", source: "chat" });
  await env.executor.execute("forget_memory", { id: mem.id }, "call_46");
  const action = env.executor.approvalFor("call_46")!;
  await runApprovedAction(ALL_TOOLS, env.ctx, action.id);
  const activities = env.services.db.all<{ type: string; summary: string }>("SELECT type, summary FROM tal_activity WHERE type = 'memory.deleted'");
  assertEquals(activities.length, 1);
  assert(activities[0].summary.includes("Disliked food"), "Summary must mention memory content");
});

add("approval-normal-047", "runApprovedAction successfully cancels automation upon approval", async () => {
  const env = createTestEnv();
  const auto = env.services.automationsRepo.create({
    name: "Morning Greeting",
    kind: "reminder",
    schedule: "0 8 * * *",
    message: "Good morning",
  });
  await env.executor.execute("cancel_automation", { id: auto.id }, "call_47");
  const action = env.executor.approvalFor("call_47")!;
  const res = await runApprovedAction(ALL_TOOLS, env.ctx, action.id);
  assertEquals(res.status, "approved");
  assertEquals(env.services.automationsRepo.get(auto.id), null);
});

add("approval-normal-048", "runApprovedAction sets resolved_at timestamp in database", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Task 48" });
  await env.executor.execute("delete_task", { task: task.id }, "call_48");
  const action = env.executor.approvalFor("call_48")!;
  await runApprovedAction(ALL_TOOLS, env.ctx, action.id);
  const stored = env.services.pendingActions.get(action.id)!;
  assert(stored.resolved_at !== null, "resolved_at must be populated after approval");
  assert(stored.resolved_at.length > 0, "resolved_at must not be empty");
});

add("approval-normal-049", "runApprovedAction cannot be executed twice on same action (idempotency)", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Task 49" });
  await env.executor.execute("delete_task", { task: task.id }, "call_49");
  const action = env.executor.approvalFor("call_49")!;
  await runApprovedAction(ALL_TOOLS, env.ctx, action.id);
  // Second approval should reject with already handled
  await assertRejects(
    () => runApprovedAction(ALL_TOOLS, env.ctx, action.id),
    /already handled/,
    "Second call must reject",
  );
});

add("approval-normal-050", "Approving task deletion does not affect other existing tasks", async () => {
  const env = createTestEnv();
  const keep1 = env.services.tasks.create({ title: "Keep 1" });
  const del = env.services.tasks.create({ title: "Delete Target" });
  const keep2 = env.services.tasks.create({ title: "Keep 2" });
  await env.executor.execute("delete_task", { task: del.id }, "call_50");
  const action = env.executor.approvalFor("call_50")!;
  await runApprovedAction(ALL_TOOLS, env.ctx, action.id);
  assertEquals(env.services.tasks.get(del.id), null);
  assert(env.services.tasks.get(keep1.id) !== null, "Keep 1 should still exist");
  assert(env.services.tasks.get(keep2.id) !== null, "Keep 2 should still exist");
});

add("approval-normal-051", "Sequential approvals of multiple different pending actions succeed", async () => {
  const env = createTestEnv({ maxToolCalls: 10 });
  const t1 = env.services.tasks.create({ title: "Seq Task 1" });
  const t2 = env.services.tasks.create({ title: "Seq Task 2" });
  await env.executor.execute("delete_task", { task: t1.id }, "call_s1");
  await env.executor.execute("delete_task", { task: t2.id }, "call_s2");
  const a1 = env.executor.approvalFor("call_s1")!;
  const a2 = env.executor.approvalFor("call_s2")!;
  const res1 = await runApprovedAction(ALL_TOOLS, env.ctx, a1.id);
  const res2 = await runApprovedAction(ALL_TOOLS, env.ctx, a2.id);
  assertEquals(res1.status, "approved");
  assertEquals(res2.status, "approved");
  assertEquals(env.services.tasks.get(t1.id), null);
  assertEquals(env.services.tasks.get(t2.id), null);
});

add("approval-normal-052", "runApprovedAction accepts custom timezone in context", async () => {
  const env = createTestEnv({ timezone: "America/New_York" });
  const task = env.services.tasks.create({ title: "TZ Task" });
  await env.executor.execute("delete_task", { task: task.id }, "call_52");
  const action = env.executor.approvalFor("call_52")!;
  const res = await runApprovedAction(ALL_TOOLS, env.ctx, action.id);
  assertEquals(res.status, "approved");
});

add("approval-normal-053", "runApprovedAction view reflects approved status immediately", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Task 53" });
  await env.executor.execute("delete_task", { task: task.id }, "call_53");
  const action = env.executor.approvalFor("call_53")!;
  await runApprovedAction(ALL_TOOLS, env.ctx, action.id);
  const view = env.services.pendingActions.view(action.id);
  assertEquals(view?.status, "approved");
});

add("approval-normal-054", "Approved action error field remains null on success", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Task 54" });
  await env.executor.execute("delete_task", { task: task.id }, "call_54");
  const action = env.executor.approvalFor("call_54")!;
  const res = await runApprovedAction(ALL_TOOLS, env.ctx, action.id);
  assertEquals(res.error, null);
  const stored = env.services.pendingActions.get(action.id)!;
  assertEquals(stored.error, null);
});

add("approval-normal-055", "runApprovedAction returns exactly the matching action ID", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Task 55" });
  await env.executor.execute("delete_task", { task: task.id }, "call_55");
  const action = env.executor.approvalFor("call_55")!;
  const res = await runApprovedAction(ALL_TOOLS, env.ctx, action.id);
  assertEquals(res.id, action.id);
});

// 5. Rejection / Cancellation handling (056 - 065)
add("approval-normal-056", "pendingActions.resolve with cancelled moves status to cancelled", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Do not delete" });
  await env.executor.execute("delete_task", { task: task.id }, "call_56");
  const action = env.executor.approvalFor("call_56")!;
  const ok = env.services.pendingActions.resolve(action.id, "cancelled");
  assertEquals(ok, true);
  const view = env.services.pendingActions.view(action.id);
  assertEquals(view?.status, "cancelled");
  // Task must remain in DB!
  assert(env.services.tasks.get(task.id) !== null, "Task must still exist after cancel");
});

add("approval-normal-057", "Cancelled action cannot subsequently be approved", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Task 57" });
  await env.executor.execute("delete_task", { task: task.id }, "call_57");
  const action = env.executor.approvalFor("call_57")!;
  env.services.pendingActions.resolve(action.id, "cancelled");
  await assertRejects(
    () => runApprovedAction(ALL_TOOLS, env.ctx, action.id),
    /already handled/,
    "Cancelled action must reject approval",
  );
  assert(env.services.tasks.get(task.id) !== null, "Task must not be deleted");
});

add("approval-normal-058", "Cancelled action cannot be cancelled a second time", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Task 58" });
  await env.executor.execute("delete_task", { task: task.id }, "call_58");
  const action = env.executor.approvalFor("call_58")!;
  assertEquals(env.services.pendingActions.resolve(action.id, "cancelled"), true);
  assertEquals(env.services.pendingActions.resolve(action.id, "cancelled"), false);
});

add("approval-normal-059", "Approved action cannot subsequently be cancelled", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Task 59" });
  await env.executor.execute("delete_task", { task: task.id }, "call_59");
  const action = env.executor.approvalFor("call_59")!;
  await runApprovedAction(ALL_TOOLS, env.ctx, action.id);
  const ok = env.services.pendingActions.resolve(action.id, "cancelled");
  assertEquals(ok, false);
  assertEquals(env.services.pendingActions.view(action.id)?.status, "approved");
});

add("approval-normal-060", "Cancellation records resolved_at timestamp in database", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Task 60" });
  await env.executor.execute("delete_task", { task: task.id }, "call_60");
  const action = env.executor.approvalFor("call_60")!;
  env.services.pendingActions.resolve(action.id, "cancelled");
  const stored = env.services.pendingActions.get(action.id)!;
  assert(stored.resolved_at !== null, "resolved_at must be populated on cancel");
});

add("approval-normal-061", "Cancelling memory deletion leaves memory intact", async () => {
  const env = createTestEnv();
  const mem = env.services.memories.create({ content: "Safe memory", category: "fact", source: "chat" });
  await env.executor.execute("forget_memory", { id: mem.id }, "call_61");
  const action = env.executor.approvalFor("call_61")!;
  env.services.pendingActions.resolve(action.id, "cancelled");
  assert(env.services.memories.get(mem.id) !== null, "Memory must still exist");
});

add("approval-normal-062", "Cancelling note deletion leaves note intact", async () => {
  const env = createTestEnv();
  const note = env.services.notes.create({ title: "Safe Note", content: "Content" });
  await env.executor.execute("delete_note", { id: note.id }, "call_62");
  const action = env.executor.approvalFor("call_62")!;
  env.services.pendingActions.resolve(action.id, "cancelled");
  assert(env.services.notes.get(note.id) !== null, "Note must still exist");
});

add("approval-normal-063", "Cancelling automation deletion leaves automation intact", async () => {
  const env = createTestEnv();
  const auto = env.services.automationsRepo.create({
    name: "Safe Auto",
    kind: "reminder",
    schedule: "0 9 * * *",
    message: "Wake up",
  });
  await env.executor.execute("cancel_automation", { id: auto.id }, "call_63");
  const action = env.executor.approvalFor("call_63")!;
  env.services.pendingActions.resolve(action.id, "cancelled");
  assert(env.services.automationsRepo.get(auto.id) !== null, "Automation must still exist");
});

add("approval-normal-064", "Cancelling one proposal does not affect sibling pending proposals", async () => {
  const env = createTestEnv({ maxToolCalls: 10 });
  const t1 = env.services.tasks.create({ title: "Sibling 1" });
  const t2 = env.services.tasks.create({ title: "Sibling 2" });
  await env.executor.execute("delete_task", { task: t1.id }, "call_sib1");
  await env.executor.execute("delete_task", { task: t2.id }, "call_sib2");
  const a1 = env.executor.approvalFor("call_sib1")!;
  const a2 = env.executor.approvalFor("call_sib2")!;
  env.services.pendingActions.resolve(a1.id, "cancelled");
  // a1 is cancelled, a2 is still pending
  assertEquals(env.services.pendingActions.view(a1.id)?.status, "cancelled");
  assertEquals(env.services.pendingActions.view(a2.id)?.status, "pending");
  // a2 can still be approved
  const res2 = await runApprovedAction(ALL_TOOLS, env.ctx, a2.id);
  assertEquals(res2.status, "approved");
  assertEquals(env.services.tasks.get(t2.id), null);
  assert(env.services.tasks.get(t1.id) !== null, "Sibling 1 must remain intact");
});

add("approval-normal-065", "Cancelled action error field remains null", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Task 65" });
  await env.executor.execute("delete_task", { task: task.id }, "call_65");
  const action = env.executor.approvalFor("call_65")!;
  env.services.pendingActions.resolve(action.id, "cancelled");
  const view = env.services.pendingActions.view(action.id)!;
  assertEquals(view.error, null);
});

// 6. withCurrentStatus & composite flows (066 - 070)
add("approval-normal-066", "withCurrentStatus updates message tool approval cards with current action status", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Task 66" });
  await env.executor.execute("delete_task", { task: task.id }, "call_66");
  const action = env.executor.approvalFor("call_66")!;

  const messages: any[] = [
    {
      id: "msg_1",
      tools: [
        {
          id: "call_66",
          name: "delete_task",
          approval: action,
        },
      ],
    },
  ];

  // While pending
  let refreshed = env.services.pendingActions.withCurrentStatus(messages);
  assertEquals(refreshed[0].tools[0].approval.status, "pending");

  // After approval
  await runApprovedAction(ALL_TOOLS, env.ctx, action.id);
  refreshed = env.services.pendingActions.withCurrentStatus(messages);
  assertEquals(refreshed[0].tools[0].approval.status, "approved");
});

add("approval-normal-067", "withCurrentStatus preserves messages without tools or without approval cards", () => {
  const env = createTestEnv();
  const messages: any[] = [
    { id: "m1", content: "Hello", tools: [] },
    { id: "m2", content: "World", tools: [{ id: "c1", name: "list_tasks" }] },
  ];
  const refreshed = env.services.pendingActions.withCurrentStatus(messages);
  assertEquals(refreshed.length, 2);
  assertEquals(refreshed[0].content, "Hello");
  assertEquals(refreshed[1].tools[0].name, "list_tasks");
});

add("approval-normal-068", "withCurrentStatus handles non-existent action gracefully by falling back to stored card", () => {
  const env = createTestEnv();
  const dummyAction: any = { id: "non_existent_id", status: "pending", summary: "Ghost action", error: null, expires_at: "" };
  const messages: any[] = [
    {
      id: "m_ghost",
      tools: [{ id: "c_ghost", name: "delete_task", approval: dummyAction }],
    },
  ];
  const refreshed = env.services.pendingActions.withCurrentStatus(messages);
  assertEquals(refreshed[0].tools[0].approval.id, "non_existent_id");
  assertEquals(refreshed[0].tools[0].approval.summary, "Ghost action");
});

add("approval-normal-069", "Custom defined destructive tool executes prepare and commit via approval flow", async () => {
  const env = createTestEnv();
  let commitCalledWith: string | null = null;

  const customTool = defineTool({
    name: "custom_purge",
    description: "Custom purge capability",
    permission: "destructive",
    input: z.object({ entityId: z.string().min(1) }),
    label: (i) => `Purging ${i.entityId}`,
    prepare: (i) => ({ targetId: `target_${i.entityId}`, summary: `Purge ${i.entityId}` }),
    commit: (targetId) => {
      commitCalledWith = targetId;
    },
  });

  const ex = env.createExecutor([customTool]);
  const res = (await ex.execute("custom_purge", { entityId: "ent_999" }, "call_custom")) as any;
  assertEquals(res.status, "awaiting_owner_approval");
  assertEquals(commitCalledWith, null);

  const action = ex.approvalFor("call_custom")!;
  assertEquals(action.summary, "Purge ent_999");

  const appResult = await runApprovedAction([customTool], env.ctx, action.id);
  assertEquals(appResult.status, "approved");
  assertEquals(commitCalledWith, "target_ent_999");
});

add("approval-normal-070", "Full turn flow: read state -> propose destructive action -> approve -> verify updated state", async () => {
  const env = createTestEnv({ maxToolCalls: 10 });
  // Step 1: create task
  const task = env.services.tasks.create({ title: "End to end lifecycle" });
  // Step 2: agent reads task list
  const listRes = (await env.executor.execute("list_tasks", {})) as any;
  assert(listRes.tasks.some((t: any) => t.id === task.id), "Task must appear in list");
  // Step 3: agent proposes deletion
  await env.executor.execute("delete_task", { task: task.id }, "call_e2e");
  const action = env.executor.approvalFor("call_e2e")!;
  // Step 4: user approves action
  await runApprovedAction(ALL_TOOLS, env.ctx, action.id);
  // Step 5: agent reads task list again in a fresh turn
  const exTurn2 = env.createExecutor();
  const listRes2 = (await exTurn2.execute("list_tasks", {})) as any;
  assert(!listRes2.tasks.some((t: any) => t.id === task.id), "Task must no longer appear in list");
});
