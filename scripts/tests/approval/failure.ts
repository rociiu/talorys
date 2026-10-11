import type { TestCase } from "../../massive-harness";
import { assert, assertEquals, assertMatch, assertRejects, createTestEnv } from "./helpers";
import { ALL_TOOLS } from "../../../apps/agent/src/tools";
import { runApprovedAction, ToolExecutor, defineTool, type ToolDefinition } from "../../../apps/agent/src/tools/registry";
import { z } from "zod";

export const failureTests: TestCase[] = [];

function add(id: string, description: string, run: () => Promise<void> | void) {
  failureTests.push({
    id,
    domain: "approval-tools",
    category: "failure",
    description,
    run,
  });
}

// 1. Blocked unauthorized / premature execution without approval (001 - 015)
add("approval-failure-001", "delete_task directly in executor does not delete task from DB", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Must not delete" });
  await env.executor.execute("delete_task", { task: task.id }, "call_f1");
  assert(env.services.tasks.get(task.id) !== null, "Task must still exist in DB");
});

add("approval-failure-002", "delete_task with confirmed: true does NOT bypass approval card", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Confirmed bypass attempt" });
  const res = (await env.executor.execute("delete_task", { task: task.id, confirmed: true }, "call_f2")) as any;
  assertEquals(res.status, "awaiting_owner_approval");
  assert(env.services.tasks.get(task.id) !== null, "Bypass attempt must fail; task must exist");
});

add("approval-failure-003", "delete_task with force: true does NOT bypass approval card", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Force bypass attempt" });
  const res = (await env.executor.execute("delete_task", { task: task.id, force: true }, "call_f3")) as any;
  assertEquals(res.status, "awaiting_owner_approval");
  assert(env.services.tasks.get(task.id) !== null, "Force flag must be ignored");
});

add("approval-failure-004", "delete_task with sudo/admin/approve flags does NOT bypass approval card", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Sudo bypass attempt" });
  const res = (await env.executor.execute("delete_task", { task: task.id, sudo: true, admin: true, approve: true }, "call_f4")) as any;
  assertEquals(res.status, "awaiting_owner_approval");
  assert(env.services.tasks.get(task.id) !== null, "Sudo/admin flags must be ignored");
});

add("approval-failure-005", "delete_note directly in executor does not delete note from DB", async () => {
  const env = createTestEnv();
  const note = env.services.notes.create({ title: "Must not delete note", content: "..." });
  await env.executor.execute("delete_note", { id: note.id }, "call_f5");
  assert(env.services.notes.get(note.id) !== null, "Note must still exist in DB");
});

add("approval-failure-006", "forget_memory directly in executor does not delete memory from DB", async () => {
  const env = createTestEnv();
  const mem = env.services.memories.create({ content: "Must not forget", category: "fact", source: "chat" });
  await env.executor.execute("forget_memory", { id: mem.id }, "call_f6");
  assert(env.services.memories.get(mem.id) !== null, "Memory must still exist in DB");
});

add("approval-failure-007", "cancel_automation directly in executor does not delete automation from DB", async () => {
  const env = createTestEnv();
  const auto = env.services.automationsRepo.create({
    name: "Must not cancel",
    kind: "reminder",
    schedule: "0 8 * * *",
    message: "Wake up",
  });
  await env.executor.execute("cancel_automation", { id: auto.id }, "call_f7");
  assert(env.services.automationsRepo.get(auto.id) !== null, "Automation must still exist in DB");
});

add("approval-failure-008", "delete_task in scheduled mode is blocked as unavailable tool", async () => {
  const env = createTestEnv({ mode: "scheduled" });
  const task = env.services.tasks.create({ title: "Scheduled victim" });
  await assertRejects(
    () => env.executor.execute("delete_task", { task: task.id }),
    /Tool "delete_task" is not available/,
    "Destructive tool must not be available in scheduled mode",
  );
  assert(env.services.tasks.get(task.id) !== null, "Task must remain intact");
});

add("approval-failure-009", "delete_note in scheduled mode is blocked as unavailable tool", async () => {
  const env = createTestEnv({ mode: "scheduled" });
  const note = env.services.notes.create({ title: "Scheduled victim", content: "..." });
  await assertRejects(
    () => env.executor.execute("delete_note", { id: note.id }),
    /Tool "delete_note" is not available/,
    "Destructive tool must not be available in scheduled mode",
  );
});

add("approval-failure-010", "forget_memory in scheduled mode is blocked as unavailable tool", async () => {
  const env = createTestEnv({ mode: "scheduled" });
  const mem = env.services.memories.create({ content: "Scheduled victim", category: "fact", source: "chat" });
  await assertRejects(
    () => env.executor.execute("forget_memory", { id: mem.id }),
    /Tool "forget_memory" is not available/,
    "Destructive tool must not be available in scheduled mode",
  );
});

add("approval-failure-011", "cancel_automation in scheduled mode is blocked as unavailable tool", async () => {
  const env = createTestEnv({ mode: "scheduled" });
  const auto = env.services.automationsRepo.create({ name: "A", kind: "reminder", schedule: "* * * * *", message: "m" });
  await assertRejects(
    () => env.executor.execute("cancel_automation", { id: auto.id }),
    /Tool "cancel_automation" is not available/,
    "Destructive tool must not be available in scheduled mode",
  );
});

add("approval-failure-012", "Destructive tool execution without conversationId throws ToolError", async () => {
  const env = createTestEnv({ conversationId: undefined });
  const task = env.services.tasks.create({ title: "No conversation task" });
  await assertRejects(
    () => env.executor.execute("delete_task", { task: task.id }),
    /needs the owner's approval and can only be used in chat/,
    "Destructive tool must throw when conversationId is missing",
  );
});

add("approval-failure-013", "runApprovedAction on non-existent action ID throws NotFoundError", async () => {
  const env = createTestEnv();
  await assertRejects(
    () => runApprovedAction(ALL_TOOLS, env.ctx, "00000000-0000-0000-0000-000000000000"),
    /This action no longer exists/,
    "Non-existent action must throw NotFoundError",
  );
});

add("approval-failure-014", "runApprovedAction on empty string action ID throws NotFoundError", async () => {
  const env = createTestEnv();
  await assertRejects(
    () => runApprovedAction(ALL_TOOLS, env.ctx, ""),
    /This action no longer exists/,
    "Empty string action ID must throw NotFoundError",
  );
});

add("approval-failure-015", "runApprovedAction rejects non-destructive tool name with NotFoundError", async () => {
  const env = createTestEnv();
  // Manually insert row with a non-destructive tool
  const fakeId = "fake-action-immediate";
  env.services.db.run(
    `INSERT INTO tal_pending_actions (id, conversation_id, tool, target_id, summary, status, created_at, expires_at)
     VALUES (?, ?, 'create_task', 'dummy', 'Fake', 'pending', ?, ?)`,
    fakeId,
    env.conversation.id,
    new Date().toISOString(),
    new Date(Date.now() + 60_000).toISOString(),
  );

  await assertRejects(
    () => runApprovedAction(ALL_TOOLS, env.ctx, fakeId),
    /This action no longer exists/,
    "Non-destructive tool must be rejected by runApprovedAction",
  );
});

// 2. Blocked execution of cancelled or expired actions (016 - 030)
add("approval-failure-016", "runApprovedAction on already approved action throws AppError CONFLICT", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Task F16" });
  await env.executor.execute("delete_task", { task: task.id }, "call_f16");
  const action = env.executor.approvalFor("call_f16")!;
  await runApprovedAction(ALL_TOOLS, env.ctx, action.id);

  const err: any = await assertRejects(
    () => runApprovedAction(ALL_TOOLS, env.ctx, action.id),
    /already handled/,
    "Already approved action must reject with already handled",
  );
  assertEquals(err.code ?? err.name, "CONFLICT");
});

add("approval-failure-017", "runApprovedAction on cancelled action throws AppError CONFLICT", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Task F17" });
  await env.executor.execute("delete_task", { task: task.id }, "call_f17");
  const action = env.executor.approvalFor("call_f17")!;
  env.services.pendingActions.resolve(action.id, "cancelled");

  const err: any = await assertRejects(
    () => runApprovedAction(ALL_TOOLS, env.ctx, action.id),
    /already handled/,
    "Cancelled action must reject with already handled",
  );
  assertEquals(err.code ?? err.name, "CONFLICT");
});

add("approval-failure-018", "runApprovedAction on expired action throws AppError CONFLICT with expired text", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Task F18" });
  await env.executor.execute("delete_task", { task: task.id }, "call_f18");
  const action = env.executor.approvalFor("call_f18")!;
  env.services.db.run(`UPDATE tal_pending_actions SET expires_at = ? WHERE id = ?`, new Date(Date.now() - 1000).toISOString(), action.id);

  const err: any = await assertRejects(
    () => runApprovedAction(ALL_TOOLS, env.ctx, action.id),
    /expired/,
    "Expired action must reject with expired message",
  );
  assertEquals(err.code ?? err.name, "CONFLICT");
});

add("approval-failure-019", "pendingActions.resolve returns false on expired action", () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Task F19" });
  const action = env.services.pendingActions.create({
    conversation_id: env.conversation.id,
    tool: "delete_task",
    target_id: task.id,
    summary: "Delete F19",
  });
  env.services.db.run(`UPDATE tal_pending_actions SET expires_at = ? WHERE id = ?`, new Date(Date.now() - 1000).toISOString(), action.id);
  assertEquals(env.services.pendingActions.resolve(action.id, "approved"), false);
  assertEquals(env.services.pendingActions.resolve(action.id, "cancelled"), false);
});

add("approval-failure-020", "pendingActions.resolve returns false on already approved action", () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Task F20" });
  const action = env.services.pendingActions.create({
    conversation_id: env.conversation.id,
    tool: "delete_task",
    target_id: task.id,
    summary: "Delete F20",
  });
  assertEquals(env.services.pendingActions.resolve(action.id, "approved"), true);
  assertEquals(env.services.pendingActions.resolve(action.id, "approved"), false);
  assertEquals(env.services.pendingActions.resolve(action.id, "cancelled"), false);
});

add("approval-failure-021", "pendingActions.resolve returns false on already cancelled action", () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Task F21" });
  const action = env.services.pendingActions.create({
    conversation_id: env.conversation.id,
    tool: "delete_task",
    target_id: task.id,
    summary: "Delete F21",
  });
  assertEquals(env.services.pendingActions.resolve(action.id, "cancelled"), true);
  assertEquals(env.services.pendingActions.resolve(action.id, "cancelled"), false);
  assertEquals(env.services.pendingActions.resolve(action.id, "approved"), false);
});

add("approval-failure-022", "pendingActions.resolve returns false on non-existent action ID", () => {
  const env = createTestEnv();
  assertEquals(env.services.pendingActions.resolve("non_existent_id", "approved"), false);
  assertEquals(env.services.pendingActions.resolve("non_existent_id", "cancelled"), false);
});

add("approval-failure-023", "pendingActions.view returns null on non-existent action ID", () => {
  const env = createTestEnv();
  assertEquals(env.services.pendingActions.view("non_existent_id"), null);
});

add("approval-failure-024", "pendingActions.get returns null on non-existent action ID", () => {
  const env = createTestEnv();
  assertEquals(env.services.pendingActions.get("non_existent_id"), null);
});

add("approval-failure-025", "Cancelled action preserves target note from being deleted", async () => {
  const env = createTestEnv();
  const note = env.services.notes.create({ title: "Keep this note", content: "important" });
  await env.executor.execute("delete_note", { id: note.id }, "call_f25");
  const action = env.executor.approvalFor("call_f25")!;
  env.services.pendingActions.resolve(action.id, "cancelled");
  await assertRejects(() => runApprovedAction(ALL_TOOLS, env.ctx, action.id));
  assert(env.services.notes.get(note.id) !== null, "Note must still exist");
});

add("approval-failure-026", "Cancelled action preserves target memory from being deleted", async () => {
  const env = createTestEnv();
  const mem = env.services.memories.create({ content: "Keep this fact", category: "fact", source: "chat" });
  await env.executor.execute("forget_memory", { id: mem.id }, "call_f26");
  const action = env.executor.approvalFor("call_f26")!;
  env.services.pendingActions.resolve(action.id, "cancelled");
  await assertRejects(() => runApprovedAction(ALL_TOOLS, env.ctx, action.id));
  assert(env.services.memories.get(mem.id) !== null, "Memory must still exist");
});

add("approval-failure-027", "Cancelled action preserves target automation from being deleted", async () => {
  const env = createTestEnv();
  const auto = env.services.automationsRepo.create({ name: "Keep auto", kind: "reminder", schedule: "* * * * *", message: "m" });
  await env.executor.execute("cancel_automation", { id: auto.id }, "call_f27");
  const action = env.executor.approvalFor("call_f27")!;
  env.services.pendingActions.resolve(action.id, "cancelled");
  await assertRejects(() => runApprovedAction(ALL_TOOLS, env.ctx, action.id));
  assert(env.services.automationsRepo.get(auto.id) !== null, "Automation must still exist");
});

add("approval-failure-028", "Expired action preserves target task from being deleted", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Expired preserve" });
  await env.executor.execute("delete_task", { task: task.id }, "call_f28");
  const action = env.executor.approvalFor("call_f28")!;
  env.services.db.run(`UPDATE tal_pending_actions SET expires_at = ? WHERE id = ?`, new Date(Date.now() - 5000).toISOString(), action.id);
  await assertRejects(() => runApprovedAction(ALL_TOOLS, env.ctx, action.id));
  assert(env.services.tasks.get(task.id) !== null, "Task must still exist");
});

add("approval-failure-029", "Expired action preserves target note from being deleted", async () => {
  const env = createTestEnv();
  const note = env.services.notes.create({ title: "Expired note", content: "content" });
  await env.executor.execute("delete_note", { id: note.id }, "call_f29");
  const action = env.executor.approvalFor("call_f29")!;
  env.services.db.run(`UPDATE tal_pending_actions SET expires_at = ? WHERE id = ?`, new Date(Date.now() - 5000).toISOString(), action.id);
  await assertRejects(() => runApprovedAction(ALL_TOOLS, env.ctx, action.id));
  assert(env.services.notes.get(note.id) !== null, "Note must still exist");
});

add("approval-failure-030", "Expired action preserves target memory from being deleted", async () => {
  const env = createTestEnv();
  const mem = env.services.memories.create({ content: "Expired mem", category: "fact", source: "chat" });
  await env.executor.execute("forget_memory", { id: mem.id }, "call_f30");
  const action = env.executor.approvalFor("call_f30")!;
  env.services.db.run(`UPDATE tal_pending_actions SET expires_at = ? WHERE id = ?`, new Date(Date.now() - 5000).toISOString(), action.id);
  await assertRejects(() => runApprovedAction(ALL_TOOLS, env.ctx, action.id));
  assert(env.services.memories.get(mem.id) !== null, "Memory must still exist");
});

// 3. Schema violations & parameter rejections (031 - 045)
add("approval-failure-031", "create_task without title rejects with validation error", async () => {
  const env = createTestEnv();
  await assertRejects(
    () => env.executor.execute("create_task", {}),
    /Invalid input/,
    "Missing required title must fail validation",
  );
});

add("approval-failure-032", "create_task with empty string title rejects with validation error", async () => {
  const env = createTestEnv();
  await assertRejects(
    () => env.executor.execute("create_task", { title: "" }),
    /Invalid input/,
    "Empty title must fail validation",
  );
});

add("approval-failure-033", "create_task with invalid priority rejects with validation error", async () => {
  const env = createTestEnv();
  await assertRejects(
    () => env.executor.execute("create_task", { title: "Valid title", priority: "critical" }),
    /Invalid input at "priority"/,
    "Invalid priority must fail validation",
  );
});

add("approval-failure-034", "create_task with title exceeding 300 chars rejects with validation error", async () => {
  const env = createTestEnv();
  await assertRejects(
    () => env.executor.execute("create_task", { title: "A".repeat(301) }),
    /Invalid input at "title"/,
    "Title over 300 chars must fail validation",
  );
});

add("approval-failure-035", "delete_task without task parameter rejects with validation error", async () => {
  const env = createTestEnv();
  await assertRejects(
    () => env.executor.execute("delete_task", {}),
    /Invalid input at "task"/,
    "Missing task parameter must fail validation",
  );
});

add("approval-failure-036", "delete_task with empty string task parameter rejects with validation error", async () => {
  const env = createTestEnv();
  await assertRejects(
    () => env.executor.execute("delete_task", { task: "" }),
    /Invalid input at "task"/,
    "Empty task parameter must fail validation",
  );
});

add("approval-failure-037", "delete_task with non-existent task reference throws ToolError not found", async () => {
  const env = createTestEnv();
  await assertRejects(
    () => env.executor.execute("delete_task", { task: "Ghost task that never existed" }),
    /No single task matches/,
    "Non-existent task reference must throw ToolError",
  );
  // Ensure no approval was registered
  assertEquals(env.executor.approvalFor("call_ghost"), undefined);
});

add("approval-failure-038", "delete_note without id parameter rejects with validation error", async () => {
  const env = createTestEnv();
  await assertRejects(
    () => env.executor.execute("delete_note", {}),
    /Invalid input at "id"/,
    "Missing id parameter must fail validation",
  );
});

add("approval-failure-039", "delete_note with non-existent id throws ToolError Note not found", async () => {
  const env = createTestEnv();
  await assertRejects(
    () => env.executor.execute("delete_note", { id: "missing-note-id" }),
    /Note not found/,
    "Non-existent note must throw ToolError",
  );
});

add("approval-failure-040", "forget_memory without id parameter rejects with validation error", async () => {
  const env = createTestEnv();
  await assertRejects(
    () => env.executor.execute("forget_memory", {}),
    /Invalid input at "id"/,
    "Missing id parameter must fail validation",
  );
});

add("approval-failure-041", "forget_memory with non-existent id throws ToolError Memory not found", async () => {
  const env = createTestEnv();
  await assertRejects(
    () => env.executor.execute("forget_memory", { id: "missing-memory-id" }),
    /Memory not found/,
    "Non-existent memory must throw ToolError",
  );
});

add("approval-failure-042", "cancel_automation without id parameter rejects with validation error", async () => {
  const env = createTestEnv();
  await assertRejects(
    () => env.executor.execute("cancel_automation", {}),
    /Invalid input at "id"/,
    "Missing id parameter must fail validation",
  );
});

add("approval-failure-043", "cancel_automation with non-existent id throws ToolError Automation not found", async () => {
  const env = createTestEnv();
  await assertRejects(
    () => env.executor.execute("cancel_automation", { id: "missing-auto-id" }),
    /Automation not found/,
    "Non-existent automation must throw ToolError",
  );
});

add("approval-failure-044", "create_note with content exceeding 20000 chars rejects with validation error", async () => {
  const env = createTestEnv();
  await assertRejects(
    () => env.executor.execute("create_note", { title: "N", content: "B".repeat(20_001) }),
    /Invalid input at "content"/,
    "Content over 20000 chars must fail validation",
  );
});

add("approval-failure-045", "remember with invalid category rejects with validation error", async () => {
  const env = createTestEnv();
  await assertRejects(
    () => env.executor.execute("remember", { content: "Valid content", category: "invalid_category" }),
    /Invalid input at "category"/,
    "Invalid category must fail validation",
  );
});

// 4. Loop detection & budget violation failures (046 - 050)
add("approval-failure-046", "Exact duplicate tool call with same arguments throws ToolError", async () => {
  const env = createTestEnv();
  await env.executor.execute("create_task", { title: "Unique task name" });
  await assertRejects(
    () => env.executor.execute("create_task", { title: "Unique task name" }),
    /This exact call was already made in this request/,
    "Duplicate call must be blocked",
  );
});

add("approval-failure-047", "Duplicate read tool call with empty object throws ToolError", async () => {
  const env = createTestEnv();
  await env.executor.execute("list_tasks", {});
  await assertRejects(
    () => env.executor.execute("list_tasks", {}),
    /This exact call was already made in this request/,
    "Duplicate read call must be blocked",
  );
});

add("approval-failure-048", "Executing completely unknown tool name throws ToolError", async () => {
  const env = createTestEnv();
  await assertRejects(
    () => env.executor.execute("unknown_hack_tool", {}),
    /Tool "unknown_hack_tool" is not available/,
    "Unknown tool must throw ToolError",
  );
});

add("approval-failure-049", "When global maxToolCalls is 0 all tools are unavailable", async () => {
  const env = createTestEnv({ maxToolCalls: 0 });
  await assertRejects(
    () => env.executor.execute("list_tasks", {}),
    /Tool "list_tasks" is not available/,
    "All tools must be unavailable when budget is 0",
  );
});

add("approval-failure-050", "Validation failures do not count against turn call budget", async () => {
  const env = createTestEnv({ maxToolCalls: 2 });
  // Try 3 invalid calls
  await assertRejects(() => env.executor.execute("create_task", { title: "" }));
  await assertRejects(() => env.executor.execute("create_task", { title: "" }));
  await assertRejects(() => env.executor.execute("create_task", { title: "" }));
  // Call count must still be 0!
  assertEquals(env.executor.callCount, 0);
  // Valid call can still be made
  await env.executor.execute("create_task", { title: "Valid after invalid" });
  assertEquals(env.executor.callCount, 1);
});
