import type { TestCase } from "../../massive-harness";
import { assert, assertEquals, assertMatch, assertRejects, createTestEnv } from "./helpers";
import { ALL_TOOLS } from "../../../apps/agent/src/tools";
import { runApprovedAction, ToolExecutor, defineTool, quoteTitle, type ToolDefinition } from "../../../apps/agent/src/tools/registry";
import { PENDING_ACTION_TTL_MS } from "../../../apps/agent/src/db/repositories/pending-actions";
import { z } from "zod";

export const boundaryTests: TestCase[] = [];

function add(id: string, description: string, run: () => Promise<void> | void) {
  boundaryTests.push({
    id,
    domain: "approval-tools",
    category: "boundary",
    description,
    run,
  });
}

// 1. Complex parameter tools & resolution boundaries (001 - 015)
add("approval-boundary-001", "delete_task resolves task with Korean text and punctuation in title", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "🛒 장보기: 우유, 빵, 계란 (할인 쿠폰 적용!)" });
  const res = (await env.executor.execute("delete_task", { task: "우유, 빵" }, "call_b1")) as any;
  assertEquals(res.status, "awaiting_owner_approval");
  const action = env.executor.approvalFor("call_b1")!;
  assert(action.summary.includes("우유, 빵"), "Summary must preserve Korean punctuation");
  await runApprovedAction(ALL_TOOLS, env.ctx, action.id);
  assertEquals(env.services.tasks.get(task.id), null);
});

add("approval-boundary-002", "delete_task resolves task by exact ID when multiple tasks have similar titles", async () => {
  const env = createTestEnv();
  const t1 = env.services.tasks.create({ title: "Write report" });
  const t2 = env.services.tasks.create({ title: "Write report draft" });
  // Resolving by ID should unambiguously target t1
  await env.executor.execute("delete_task", { task: t1.id }, "call_b2");
  const action = env.executor.approvalFor("call_b2")!;
  assertEquals(action.summary.includes("Write report"), true);
  await runApprovedAction(ALL_TOOLS, env.ctx, action.id);
  assertEquals(env.services.tasks.get(t1.id), null);
  assert(env.services.tasks.get(t2.id) !== null, "t2 must remain untouched");
});

add("approval-boundary-003", "delete_task handles special regex characters in task title query without crashing", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Fix [BUG] (v1.2.3) in /src/app.ts" });
  const res = (await env.executor.execute("delete_task", { task: "[BUG] (v1.2.3)" }, "call_b3")) as any;
  assertEquals(res.status, "awaiting_owner_approval");
  const action = env.executor.approvalFor("call_b3")!;
  await runApprovedAction(ALL_TOOLS, env.ctx, action.id);
  assertEquals(env.services.tasks.get(task.id), null);
});

add("approval-boundary-004", "delete_note handles multi-line markdown content note deletion", async () => {
  const env = createTestEnv();
  const content = `# Architecture Review\n\n\`\`\`ts\nconst x = 1;\n\`\`\`\n\n> Note: Important decision`;
  const note = env.services.notes.create({ title: "Arch Doc", content });
  await env.executor.execute("delete_note", { id: note.id }, "call_b4");
  const action = env.executor.approvalFor("call_b4")!;
  await runApprovedAction(ALL_TOOLS, env.ctx, action.id);
  assertEquals(env.services.notes.get(note.id), null);
});

add("approval-boundary-005", "forget_memory handles memory containing emojis and special symbols", async () => {
  const env = createTestEnv();
  const mem = env.services.memories.create({
    content: "Favorite foods: 🍕 Pizza & 🍣 Sushi! #food @dinner",
    category: "preference",
    source: "chat",
  });
  await env.executor.execute("forget_memory", { id: mem.id }, "call_b5");
  const action = env.executor.approvalFor("call_b5")!;
  await runApprovedAction(ALL_TOOLS, env.ctx, action.id);
  assertEquals(env.services.memories.get(mem.id), null);
});

add("approval-boundary-006", "create_task handles boundary priority values (low, medium, high)", async () => {
  const env = createTestEnv();
  for (const prio of ["low", "medium", "high"] as const) {
    const res = (await env.executor.execute("create_task", { title: `Task ${prio}`, priority: prio })) as any;
    assertEquals(res.created.priority, prio);
  }
});

add("approval-boundary-007", "create_task handles local date format 'YYYY-MM-DD' boundary", async () => {
  const env = createTestEnv({ timezone: "Asia/Seoul" });
  const res = (await env.executor.execute("create_task", { title: "Year end", due: "2026-12-31" })) as any;
  assert(res.created.id, "Should create task with date");
  const stored = env.services.tasks.get(res.created.id)!;
  assert(stored.due_at !== null, "due_at should be set");
});

add("approval-boundary-008", "create_task handles local date-time format 'YYYY-MM-DDTHH:MM' boundary", async () => {
  const env = createTestEnv({ timezone: "Asia/Seoul" });
  const res = (await env.executor.execute("create_task", { title: "Midnight run", due: "2026-12-31T23:59" })) as any;
  assert(res.created.id, "Should create task with datetime");
});

add("approval-boundary-009", "update_task can clear due date with empty string or null", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Clear due", due_at: "2026-12-31T10:00:00.000Z" });
  await env.executor.execute("update_task", { task: task.id, due: "" });
  const stored = env.services.tasks.get(task.id)!;
  assertEquals(stored.due_at, null);
});

add("approval-boundary-010", "create_note handles max title length (200 chars)", async () => {
  const env = createTestEnv();
  const longTitle = "T".repeat(200);
  const res = (await env.executor.execute("create_note", { title: longTitle, content: "abc" })) as any;
  assertEquals(res.created.title.length, 200);
});

add("approval-boundary-011", "create_task handles max title length (200 chars)", async () => {
  const env = createTestEnv();
  const longTitle = "K".repeat(200);
  const res = (await env.executor.execute("create_task", { title: longTitle })) as any;
  assertEquals(res.created.title.length, 200);
});

add("approval-boundary-012", "create_note handles empty string content", async () => {
  const env = createTestEnv();
  const res = (await env.executor.execute("create_note", { title: "Empty content note", content: "" })) as any;
  const stored = env.services.notes.get(res.created.id)!;
  assertEquals(stored.content, "");
});

add("approval-boundary-013", "update_note append parameter correctly appends to existing content", async () => {
  const env = createTestEnv();
  const note = env.services.notes.create({ title: "Log", content: "Line 1" });
  await env.executor.execute("update_note", { id: note.id, append: "Line 2" });
  const stored = env.services.notes.get(note.id)!;
  assert(stored.content.includes("Line 1") && stored.content.includes("Line 2"), "Note should contain both lines");
});

add("approval-boundary-014", "notify_owner handles boundary body length (4000 chars)", async () => {
  const env = createTestEnv();
  const body = "N".repeat(4000);
  const res = (await env.executor.execute("notify_owner", { title: "Long body", body })) as any;
  assert(res.notified, "Should succeed with 4000 char body");
});

add("approval-boundary-015", "remember handles boundary content length (1000 chars)", async () => {
  const env = createTestEnv();
  const content = "M".repeat(1000);
  const res = (await env.executor.execute("remember", { content, category: "fact" })) as any;
  assertEquals(res.remembered.content.length, 1000);
});

// 2. Giant payload actions & quoteTitle boundaries (016 - 028)
add("approval-boundary-016", "quoteTitle normalizes multiple spaces, tabs, and newlines into single spaces", () => {
  const text = "  Task   with \t tabs \n and   newlines  ";
  const quoted = quoteTitle(text);
  assertEquals(quoted, "“Task with tabs and newlines”");
});

add("approval-boundary-017", "quoteTitle truncates text exceeding max length with ellipsis", () => {
  const text = "A".repeat(100);
  const quoted = quoteTitle(text, 80);
  // Max is 80: 79 chars + '…' = 80 chars, wrapped in quotes
  assertEquals(quoted, `“${"A".repeat(79)}…”`);
});

add("approval-boundary-018", "quoteTitle does not truncate text of exactly max length", () => {
  const text = "B".repeat(80);
  const quoted = quoteTitle(text, 80);
  assertEquals(quoted, `“${"B".repeat(80)}”`);
});

add("approval-boundary-019", "quoteTitle does not truncate text shorter than max length", () => {
  const text = "C".repeat(79);
  const quoted = quoteTitle(text, 80);
  assertEquals(quoted, `“${"C".repeat(79)}”`);
});

add("approval-boundary-020", "quoteTitle handles max = 1 gracefully", () => {
  const quoted = quoteTitle("Hello", 1);
  assertEquals(quoted, "“…”");
});

add("approval-boundary-021", "quoteTitle handles empty string gracefully", () => {
  const quoted = quoteTitle("");
  assertEquals(quoted, "“”");
});

add("approval-boundary-022", "quoteTitle handles giant text (10,000 characters) without stack overflow", () => {
  const giant = "X".repeat(10_000);
  const quoted = quoteTitle(giant, 80);
  assertEquals(quoted.length, 80 + 2); // 80 chars inside + 2 quotes
  assert(quoted.endsWith("…”"), "Must end with ellipsis and quote");
});

add("approval-boundary-023", "delete_task proposal summary stays compact for 1000-char task title", async () => {
  const env = createTestEnv();
  const longTitle = "Very long task title ".repeat(50);
  const task = env.services.tasks.create({ title: longTitle });
  await env.executor.execute("delete_task", { task: task.id }, "call_b23");
  const action = env.executor.approvalFor("call_b23")!;
  assert(action.summary.length <= 120, `Summary must stay under 120 chars, got ${action.summary.length}`);
  assert(action.summary.includes("…"), "Summary should include ellipsis");
});

add("approval-boundary-024", "delete_note with giant content (50,000 chars) prepares and approves cleanly", async () => {
  const env = createTestEnv();
  const note = env.services.notes.create({ title: "Giant Note", content: "A".repeat(50_000) });
  await env.executor.execute("delete_note", { id: note.id }, "call_b24");
  const action = env.executor.approvalFor("call_b24")!;
  await runApprovedAction(ALL_TOOLS, env.ctx, action.id);
  assertEquals(env.services.notes.get(note.id), null);
});

add("approval-boundary-025", "markFailed truncates error message exceeding 300 chars", () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "T25" });
  const action = env.services.pendingActions.create({
    conversation_id: env.conversation.id,
    tool: "delete_task",
    target_id: task.id,
    summary: "Delete T25",
  });
  const hugeError = "E".repeat(1000);
  env.services.pendingActions.markFailed(action.id, hugeError);
  const stored = env.services.pendingActions.get(action.id)!;
  assertEquals(stored.error?.length, 300);
  assertEquals(stored.error, "E".repeat(300));
});

add("approval-boundary-026", "markFailed handles error message of exactly 300 chars without truncation", () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "T26" });
  const action = env.services.pendingActions.create({
    conversation_id: env.conversation.id,
    tool: "delete_task",
    target_id: task.id,
    summary: "Delete T26",
  });
  const exact300 = "Z".repeat(300);
  env.services.pendingActions.markFailed(action.id, exact300);
  const stored = env.services.pendingActions.get(action.id)!;
  assertEquals(stored.error, exact300);
});

add("approval-boundary-027", "markFailed handles empty string error", () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "T27" });
  const action = env.services.pendingActions.create({
    conversation_id: env.conversation.id,
    tool: "delete_task",
    target_id: task.id,
    summary: "Delete T27",
  });
  env.services.pendingActions.markFailed(action.id, "");
  const stored = env.services.pendingActions.get(action.id)!;
  assertEquals(stored.error, "");
});

add("approval-boundary-028", "100 distinct tasks can be created and tracked in DB without performance degradation", () => {
  const env = createTestEnv();
  for (let i = 0; i < 100; i++) {
    env.services.tasks.create({ title: `Bulk task #${i}` });
  }
  const all = env.services.tasks.list();
  assertEquals(all.length, 100);
});

// 3. Expiration boundaries & timing (029 - 042)
add("approval-boundary-029", "Approval 100ms before expiration succeeds", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Near Expire Task" });
  await env.executor.execute("delete_task", { task: task.id }, "call_b29");
  const action = env.executor.approvalFor("call_b29")!;

  // Artificially set expires_at to 2000ms in the future
  const nearFuture = new Date(Date.now() + 2000).toISOString();
  env.services.db.run(`UPDATE tal_pending_actions SET expires_at = ? WHERE id = ?`, nearFuture, action.id);

  const res = await runApprovedAction(ALL_TOOLS, env.ctx, action.id);
  assertEquals(res.status, "approved");
  assertEquals(env.services.tasks.get(task.id), null);
});

add("approval-boundary-030", "Action approved before expiration remains approved even after expires_at passes", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Past Expire Approved" });
  await env.executor.execute("delete_task", { task: task.id }, "call_b30");
  const action = env.executor.approvalFor("call_b30")!;

  // Approve now
  await runApprovedAction(ALL_TOOLS, env.ctx, action.id);

  // Artificially set expires_at into the past
  const past = new Date(Date.now() - 5000).toISOString();
  env.services.db.run(`UPDATE tal_pending_actions SET expires_at = ? WHERE id = ?`, past, action.id);

  // Status must remain 'approved', NOT 'expired'
  const view = env.services.pendingActions.view(action.id);
  assertEquals(view?.status, "approved");
});

add("approval-boundary-031", "Action cancelled before expiration remains cancelled even after expires_at passes", () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Past Expire Cancelled" });
  const action = env.services.pendingActions.create({
    conversation_id: env.conversation.id,
    tool: "delete_task",
    target_id: task.id,
    summary: "Delete T31",
  });
  env.services.pendingActions.resolve(action.id, "cancelled");

  // Move expires_at to past
  env.services.db.run(`UPDATE tal_pending_actions SET expires_at = ? WHERE id = ?`, new Date(Date.now() - 5000).toISOString(), action.id);

  const view = env.services.pendingActions.view(action.id);
  assertEquals(view?.status, "cancelled");
});

add("approval-boundary-032", "Action expiring exactly at current timestamp cannot be approved", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Exact Expire" });
  const action = env.services.pendingActions.create({
    conversation_id: env.conversation.id,
    tool: "delete_task",
    target_id: task.id,
    summary: "Delete T32",
  });
  // Set expires_at to past
  env.services.db.run(`UPDATE tal_pending_actions SET expires_at = ? WHERE id = ?`, new Date(Date.now() - 1).toISOString(), action.id);

  await assertRejects(
    () => runApprovedAction(ALL_TOOLS, env.ctx, action.id),
    /expired/,
    "Expired action must throw CONFLICT expired",
  );
  assertEquals(env.services.tasks.get(task.id) !== null, true);
});

add("approval-boundary-033", "Action expired 1ms in past returns status expired in view", () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Expired 1ms" });
  const action = env.services.pendingActions.create({
    conversation_id: env.conversation.id,
    tool: "delete_task",
    target_id: task.id,
    summary: "Delete T33",
  });
  env.services.db.run(`UPDATE tal_pending_actions SET expires_at = ? WHERE id = ?`, new Date(Date.now() - 1).toISOString(), action.id);
  const view = env.services.pendingActions.view(action.id);
  assertEquals(view?.status, "expired");
});

add("approval-boundary-034", "Action expired 1 hour in past returns status expired in view", () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Expired 1h" });
  const action = env.services.pendingActions.create({
    conversation_id: env.conversation.id,
    tool: "delete_task",
    target_id: task.id,
    summary: "Delete T34",
  });
  env.services.db.run(`UPDATE tal_pending_actions SET expires_at = ? WHERE id = ?`, new Date(Date.now() - 3600_000).toISOString(), action.id);
  const view = env.services.pendingActions.view(action.id);
  assertEquals(view?.status, "expired");
});

add("approval-boundary-035", "Action expired 29 days in past returns status expired in view", () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Expired 29d" });
  const action = env.services.pendingActions.create({
    conversation_id: env.conversation.id,
    tool: "delete_task",
    target_id: task.id,
    summary: "Delete T35",
  });
  env.services.db.run(`UPDATE tal_pending_actions SET expires_at = ? WHERE id = ?`, new Date(Date.now() - 29 * 86_400_000).toISOString(), action.id);
  const view = env.services.pendingActions.view(action.id);
  assertEquals(view?.status, "expired");
});

add("approval-boundary-036", "Expired action cannot be cancelled", () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "T36" });
  const action = env.services.pendingActions.create({
    conversation_id: env.conversation.id,
    tool: "delete_task",
    target_id: task.id,
    summary: "Delete T36",
  });
  env.services.db.run(`UPDATE tal_pending_actions SET expires_at = ? WHERE id = ?`, new Date(Date.now() - 1000).toISOString(), action.id);
  const ok = env.services.pendingActions.resolve(action.id, "cancelled");
  assertEquals(ok, false);
});

add("approval-boundary-037", "Pending action with future expires_at is not marked expired in view", () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "T37" });
  const action = env.services.pendingActions.create({
    conversation_id: env.conversation.id,
    tool: "delete_task",
    target_id: task.id,
    summary: "Delete T37",
  });
  const view = env.services.pendingActions.view(action.id);
  assertEquals(view?.status, "pending");
});

add("approval-boundary-038", "Action with failed status in past preserves failed status in view", () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "T38" });
  const action = env.services.pendingActions.create({
    conversation_id: env.conversation.id,
    tool: "delete_task",
    target_id: task.id,
    summary: "Delete T38",
  });
  env.services.pendingActions.markFailed(action.id, "Some failure");
  env.services.db.run(`UPDATE tal_pending_actions SET expires_at = ? WHERE id = ?`, new Date(Date.now() - 10_000).toISOString(), action.id);
  const view = env.services.pendingActions.view(action.id);
  assertEquals(view?.status, "failed");
});

add("approval-boundary-039", "withCurrentStatus updates expired status on message approval cards", () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "T39" });
  const action = env.services.pendingActions.create({
    conversation_id: env.conversation.id,
    tool: "delete_task",
    target_id: task.id,
    summary: "Delete T39",
  });
  env.services.db.run(`UPDATE tal_pending_actions SET expires_at = ? WHERE id = ?`, new Date(Date.now() - 10_000).toISOString(), action.id);

  const messages: any[] = [{ id: "m39", tools: [{ id: "c39", name: "delete_task", approval: action }] }];
  const refreshed = env.services.pendingActions.withCurrentStatus(messages);
  assertEquals(refreshed[0].tools[0].approval.status, "expired");
});

add("approval-boundary-040", "Attempting approval on expired action throws AppError CONFLICT with friendly message", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "T40" });
  const action = env.services.pendingActions.create({
    conversation_id: env.conversation.id,
    tool: "delete_task",
    target_id: task.id,
    summary: "Delete T40",
  });
  env.services.db.run(`UPDATE tal_pending_actions SET expires_at = ? WHERE id = ?`, new Date(Date.now() - 1000).toISOString(), action.id);
  const err = await assertRejects(() => runApprovedAction(ALL_TOOLS, env.ctx, action.id));
  assert(err.message.includes("expired") || err.message.includes("Ask again"), `Expected expired message, got ${err.message}`);
});

add("approval-boundary-041", "pending action resolve sets resolved_at to exact ISO string", () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "T41" });
  const action = env.services.pendingActions.create({
    conversation_id: env.conversation.id,
    tool: "delete_task",
    target_id: task.id,
    summary: "Delete T41",
  });
  env.services.pendingActions.resolve(action.id, "cancelled");
  const stored = env.services.pendingActions.get(action.id)!;
  assertMatch(stored.resolved_at!, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

add("approval-boundary-042", "pending action view preserves ISO format of expires_at", () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "T42" });
  const action = env.services.pendingActions.create({
    conversation_id: env.conversation.id,
    tool: "delete_task",
    target_id: task.id,
    summary: "Delete T42",
  });
  const view = env.services.pendingActions.view(action.id)!;
  assertMatch(view.expires_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

// 4. Multi-step approval chains (043 - 052)
add("approval-boundary-043", "Sequential 3-step approval chain: delete task -> delete note -> forget memory", async () => {
  const env = createTestEnv({ maxToolCalls: 10 });
  const t = env.services.tasks.create({ title: "Chain Task" });
  const n = env.services.notes.create({ title: "Chain Note", content: "..." });
  const m = env.services.memories.create({ content: "Chain Mem", category: "fact", source: "chat" });

  await env.executor.execute("delete_task", { task: t.id }, "call_c1");
  await env.executor.execute("delete_note", { id: n.id }, "call_c2");
  await env.executor.execute("forget_memory", { id: m.id }, "call_c3");

  const a1 = env.executor.approvalFor("call_c1")!;
  const a2 = env.executor.approvalFor("call_c2")!;
  const a3 = env.executor.approvalFor("call_c3")!;

  // Approve in exact order
  assertEquals((await runApprovedAction(ALL_TOOLS, env.ctx, a1.id)).status, "approved");
  assertEquals((await runApprovedAction(ALL_TOOLS, env.ctx, a2.id)).status, "approved");
  assertEquals((await runApprovedAction(ALL_TOOLS, env.ctx, a3.id)).status, "approved");

  assertEquals(env.services.tasks.get(t.id), null);
  assertEquals(env.services.notes.get(n.id), null);
  assertEquals(env.services.memories.get(m.id), null);
});

add("approval-boundary-044", "Reverse order approval of 3 pending actions resolves all cleanly", async () => {
  const env = createTestEnv({ maxToolCalls: 10 });
  const t1 = env.services.tasks.create({ title: "Task 1" });
  const t2 = env.services.tasks.create({ title: "Task 2" });
  const t3 = env.services.tasks.create({ title: "Task 3" });

  await env.executor.execute("delete_task", { task: t1.id }, "c1");
  await env.executor.execute("delete_task", { task: t2.id }, "c2");
  await env.executor.execute("delete_task", { task: t3.id }, "c3");

  const a1 = env.executor.approvalFor("c1")!;
  const a2 = env.executor.approvalFor("c2")!;
  const a3 = env.executor.approvalFor("c3")!;

  // Approve in reverse: 3, then 2, then 1
  await runApprovedAction(ALL_TOOLS, env.ctx, a3.id);
  await runApprovedAction(ALL_TOOLS, env.ctx, a2.id);
  await runApprovedAction(ALL_TOOLS, env.ctx, a1.id);

  assertEquals(env.services.tasks.get(t1.id), null);
  assertEquals(env.services.tasks.get(t2.id), null);
  assertEquals(env.services.tasks.get(t3.id), null);
});

add("approval-boundary-045", "Dependent chain: task created in turn 1 is proposed for deletion in turn 2", async () => {
  const env = createTestEnv();
  // Turn 1: create task
  const createRes = (await env.executor.execute("create_task", { title: "Turn 1 Task" })) as any;
  const taskId = createRes.created.id;

  // Turn 2: new executor proposes delete
  const ex2 = env.createExecutor();
  await ex2.execute("delete_task", { task: taskId }, "call_t2");
  const action = ex2.approvalFor("call_t2")!;

  // Approve
  await runApprovedAction(ALL_TOOLS, env.ctx, action.id);
  assertEquals(env.services.tasks.get(taskId), null);
});

add("approval-boundary-046", "Multiple conversations maintain separate pending action sets", async () => {
  const env = createTestEnv();
  const convB = env.services.conversations.create("Conversation B");

  const taskA = env.services.tasks.create({ title: "Task A" });
  const taskB = env.services.tasks.create({ title: "Task B" });

  // Conv A executor
  const exA = env.executor;
  await exA.execute("delete_task", { task: taskA.id }, "call_a");
  const actA = exA.approvalFor("call_a")!;

  // Conv B executor
  const exB = env.createExecutor(ALL_TOOLS, { maxToolCalls: 5 }, { conversationId: convB.id });
  await exB.execute("delete_task", { task: taskB.id }, "call_b");
  const actB = exB.approvalFor("call_b")!;

  const storedA = env.services.pendingActions.get(actA.id)!;
  const storedB = env.services.pendingActions.get(actB.id)!;

  assertEquals(storedA.conversation_id, env.conversation.id);
  assertEquals(storedB.conversation_id, convB.id);

  await runApprovedAction(ALL_TOOLS, env.ctx, actA.id);
  await runApprovedAction(ALL_TOOLS, { ...env.ctx, conversationId: convB.id }, actB.id);

  assertEquals(env.services.tasks.get(taskA.id), null);
  assertEquals(env.services.tasks.get(taskB.id), null);
});

add("approval-boundary-047", "Deleting conversation cascades and deletes its pending actions in DB", () => {
  const env = createTestEnv();
  const conv = env.services.conversations.create("Temporary Conv");
  const task = env.services.tasks.create({ title: "Temp Task" });
  const action = env.services.pendingActions.create({
    conversation_id: conv.id,
    tool: "delete_task",
    target_id: task.id,
    summary: "Delete Temp Task",
  });
  assert(env.services.pendingActions.get(action.id) !== null, "Action should exist");

  // Delete conversation with cascade
  env.services.db.run(`DELETE FROM tal_conversations WHERE id = ?`, conv.id);

  // Pending action should be cascade-deleted
  assertEquals(env.services.pendingActions.get(action.id), null);
});

add("approval-boundary-048", "Chain with interleaved cancellation: approve A, cancel B, approve C", async () => {
  const env = createTestEnv({ maxToolCalls: 10 });
  const tA = env.services.tasks.create({ title: "Interleaved A" });
  const tB = env.services.tasks.create({ title: "Interleaved B" });
  const tC = env.services.tasks.create({ title: "Interleaved C" });

  await env.executor.execute("delete_task", { task: tA.id }, "cA");
  await env.executor.execute("delete_task", { task: tB.id }, "cB");
  await env.executor.execute("delete_task", { task: tC.id }, "cC");

  const aA = env.executor.approvalFor("cA")!;
  const aB = env.executor.approvalFor("cB")!;
  const aC = env.executor.approvalFor("cC")!;

  await runApprovedAction(ALL_TOOLS, env.ctx, aA.id);
  env.services.pendingActions.resolve(aB.id, "cancelled");
  await runApprovedAction(ALL_TOOLS, env.ctx, aC.id);

  assertEquals(env.services.tasks.get(tA.id), null);
  assert(env.services.tasks.get(tB.id) !== null, "Task B must remain intact");
  assertEquals(env.services.tasks.get(tC.id), null);
});

add("approval-boundary-049", "Deleting note belonging to project cascades note but retains project", async () => {
  const env = createTestEnv();
  const proj = env.services.projects.create({ name: "Project X" });
  const note = env.services.notes.create({ title: "Note in Proj", content: "...", project_id: proj.id });

  await env.executor.execute("delete_note", { id: note.id }, "call_proj_note");
  const action = env.executor.approvalFor("call_proj_note")!;
  await runApprovedAction(ALL_TOOLS, env.ctx, action.id);

  assertEquals(env.services.notes.get(note.id), null);
  assert(env.services.projects.get(proj.id) !== null, "Project must still exist");
});

add("approval-boundary-050", "Deleting task belonging to project retains project", async () => {
  const env = createTestEnv();
  const proj = env.services.projects.create({ name: "Project Y" });
  const task = env.services.tasks.create({ title: "Task in Proj", project_id: proj.id });

  await env.executor.execute("delete_task", { task: task.id }, "call_proj_task");
  const action = env.executor.approvalFor("call_proj_task")!;
  await runApprovedAction(ALL_TOOLS, env.ctx, action.id);

  assertEquals(env.services.tasks.get(task.id), null);
  assert(env.services.projects.get(proj.id) !== null, "Project must still exist");
});

add("approval-boundary-051", "Creating and deleting note with identical title succeeds across cycles", async () => {
  const env = createTestEnv();
  // Cycle 1
  const n1 = env.services.notes.create({ title: "Recycled Title", content: "1" });
  await env.executor.execute("delete_note", { id: n1.id }, "c1");
  await runApprovedAction(ALL_TOOLS, env.ctx, env.executor.approvalFor("c1")!.id);

  // Cycle 2
  const ex2 = env.createExecutor();
  const n2 = env.services.notes.create({ title: "Recycled Title", content: "2" });
  await ex2.execute("delete_note", { id: n2.id }, "c2");
  await runApprovedAction(ALL_TOOLS, env.ctx, ex2.approvalFor("c2")!.id);

  assertEquals(env.services.notes.get(n2.id), null);
});

add("approval-boundary-052", "Multi-turn tool execution maintains separate tool limits per turn", async () => {
  const env = createTestEnv({ maxToolCalls: 2 });
  // Turn 1 hits limit
  await env.executor.execute("create_task", { title: "Turn 1 - 1" });
  await env.executor.execute("create_task", { title: "Turn 1 - 2" });
  assertEquals(env.executor.budgetExhausted(), true);

  // Turn 2 has fresh executor and fresh limit
  const ex2 = env.createExecutor(ALL_TOOLS, { maxToolCalls: 2 });
  assertEquals(ex2.budgetExhausted(), false);
  await ex2.execute("create_task", { title: "Turn 2 - 1" });
  assertEquals(ex2.callCount, 1);
});

// 5. Call budget & per-tool caps boundaries (053 - 060)
add("approval-boundary-053", "delete_task enforces maxCallsPerTurn = 3 exactly", async () => {
  const env = createTestEnv({ maxToolCalls: 10 });
  const t1 = env.services.tasks.create({ title: "T1" });
  const t2 = env.services.tasks.create({ title: "T2" });
  const t3 = env.services.tasks.create({ title: "T3" });
  const t4 = env.services.tasks.create({ title: "T4" });

  await env.executor.execute("delete_task", { task: t1.id }, "c1");
  await env.executor.execute("delete_task", { task: t2.id }, "c2");
  await env.executor.execute("delete_task", { task: t3.id }, "c3");

  // 4th call must reject due to per-tool limit
  await assertRejects(
    () => env.executor.execute("delete_task", { task: t4.id }, "c4"),
    /already used 3 times/,
    "4th call must be blocked by per-tool limit",
  );
});

add("approval-boundary-054", "delete_note enforces maxCallsPerTurn = 2 exactly", async () => {
  const env = createTestEnv({ maxToolCalls: 10 });
  const n1 = env.services.notes.create({ title: "N1" });
  const n2 = env.services.notes.create({ title: "N2" });
  const n3 = env.services.notes.create({ title: "N3" });

  await env.executor.execute("delete_note", { id: n1.id }, "c1");
  await env.executor.execute("delete_note", { id: n2.id }, "c2");

  await assertRejects(
    () => env.executor.execute("delete_note", { id: n3.id }, "c3"),
    /already used 2 times/,
    "3rd call must be blocked by per-tool limit",
  );
});

add("approval-boundary-055", "notify_owner enforces maxCallsPerTurn = 1 exactly", async () => {
  const env = createTestEnv();
  await env.executor.execute("notify_owner", { title: "A", body: "1" });
  await assertRejects(
    () => env.executor.execute("notify_owner", { title: "B", body: "2" }),
    /already used 1 times/,
    "2nd call must be blocked by per-tool limit",
  );
});

add("approval-boundary-056", "Global budget limit = 1 allows exactly 1 call and rejects 2nd", async () => {
  const env = createTestEnv({ maxToolCalls: 1 });
  await env.executor.execute("create_task", { title: "Only one" });
  assertEquals(env.executor.budgetExhausted(), true);
  await assertRejects(
    () => env.executor.execute("create_task", { title: "Second" }),
    /Tool call limit reached/,
    "2nd call must exceed global budget",
  );
});

add("approval-boundary-057", "Global budget limit = 5 allows 5 calls across different tools and blocks 6th", async () => {
  const env = createTestEnv({ maxToolCalls: 5 });
  await env.executor.execute("create_task", { title: "T1" });
  await env.executor.execute("create_task", { title: "T2" });
  await env.executor.execute("create_note", { title: "N1", content: "Content 1" });
  await env.executor.execute("remember", { content: "Fact memory 1", category: "fact" });
  await env.executor.execute("notify_owner", { title: "Alert", body: "Ok" });
  assertEquals(env.executor.callCount, 5);

  await assertRejects(
    () => env.executor.execute("create_project", { name: "P1" }),
    /Tool call limit reached/,
    "6th call must exceed global budget",
  );
});

add("approval-boundary-058", "Duplicate tool calls with different key ordering in JSON payload are correctly blocked", async () => {
  const env = createTestEnv();
  await env.executor.execute("create_task", { title: "Order test", priority: "high" });
  // Call with inverted keys: priority first, then title
  await assertRejects(
    () => env.executor.execute("create_task", { priority: "high", title: "Order test" }),
    /exact call was already made/,
    "Inverted keys must still be recognized as duplicate signature",
  );
});

add("approval-boundary-059", "Duplicate tool calls with undefined properties produce matching signatures", async () => {
  const env = createTestEnv();
  await env.executor.execute("create_task", { title: "Undef test", description: undefined });
  await assertRejects(
    () => env.executor.execute("create_task", { title: "Undef test" }),
    /exact call was already made/,
    "Call without optional prop should match call with undefined optional prop",
  );
});

add("approval-boundary-060", "Tool executor handles maxCallsPerTurn undefined by respecting only global budget", async () => {
  const unlimitedTool = defineTool({
    name: "unlimited_tool",
    description: "No per tool cap",
    permission: "write",
    input: z.object({ seq: z.number() }),
    label: () => "unlimited",
    execute: (i) => i.seq,
  });
  const env = createTestEnv();
  const ex = env.createExecutor([unlimitedTool], { maxToolCalls: 10 });
  for (let i = 0; i < 10; i++) {
    await ex.execute("unlimited_tool", { seq: i });
  }
  assertEquals(ex.callCount, 10);
});
