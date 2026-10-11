import type { TestCase } from "../../massive-harness";
import { assert, assertEquals, assertMatch, assertRejects, createTestEnv } from "./helpers";
import { ALL_TOOLS } from "../../../apps/agent/src/tools";
import { runApprovedAction, ToolExecutor, defineTool, ToolError, type ToolDefinition } from "../../../apps/agent/src/tools/registry";
import { z } from "zod";

export const recoveryTests: TestCase[] = [];

function add(id: string, description: string, run: () => Promise<void> | void) {
  recoveryTests.push({
    id,
    domain: "approval-tools",
    category: "recovery",
    description,
    run,
  });
}

// 1. Error during action execution & status recording (001 - 010)
add("approval-recovery-001", "When tool.commit throws ToolError, status is marked failed with error message", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Fail ToolError Task" });
  await env.executor.execute("delete_task", { task: task.id }, "call_r1");
  const action = env.executor.approvalFor("call_r1")!;

  // Delete the task before approval so commit throws ToolError("This task no longer exists.")
  env.services.tasks.delete(task.id);

  const res = await runApprovedAction(ALL_TOOLS, env.ctx, action.id);
  assertEquals(res.status, "failed");
  assertEquals(res.error, "This task no longer exists.");

  const view = env.services.pendingActions.view(action.id)!;
  assertEquals(view.status, "failed");
  assertEquals(view.error, "This task no longer exists.");
});

add("approval-recovery-002", "When tool.commit throws generic Error, status is marked failed with generic error message", async () => {
  const env = createTestEnv();
  const failingTool = defineTool({
    name: "failing_generic",
    description: "Throws generic Error",
    permission: "destructive",
    input: z.object({ id: z.string() }),
    label: () => "failing",
    prepare: (i) => ({ targetId: i.id, summary: "Fail Generic" }),
    commit: () => {
      throw new Error("Underlying system failure");
    },
  });

  const ex = env.createExecutor([failingTool]);
  await ex.execute("failing_generic", { id: "tgt_1" }, "call_f_gen");
  const action = ex.approvalFor("call_f_gen")!;

  const res = await runApprovedAction([failingTool], env.ctx, action.id);
  assertEquals(res.status, "failed");
  assertEquals(res.error, "The action failed.");
});

add("approval-recovery-003", "When action execution fails, resolved_at is recorded in database", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Fail Timestamp Task" });
  await env.executor.execute("delete_task", { task: task.id }, "call_r3");
  const action = env.executor.approvalFor("call_r3")!;
  env.services.tasks.delete(task.id);

  await runApprovedAction(ALL_TOOLS, env.ctx, action.id);
  const stored = env.services.pendingActions.get(action.id)!;
  assert(stored.resolved_at !== null, "resolved_at must be populated on failure");
});

add("approval-recovery-004", "runApprovedAction does not throw when action fails; returns failed PendingAction", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "No Throw Task" });
  await env.executor.execute("delete_task", { task: task.id }, "call_r4");
  const action = env.executor.approvalFor("call_r4")!;
  env.services.tasks.delete(task.id);

  // Calling runApprovedAction should NOT reject with an exception
  const res = await runApprovedAction(ALL_TOOLS, env.ctx, action.id);
  assertEquals(res.status, "failed");
});

add("approval-recovery-005", "markFailed handles undefined or non-string errors safely without crashing", () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "T5" });
  const a1 = env.services.pendingActions.create({
    conversation_id: env.conversation.id,
    tool: "delete_task",
    target_id: task.id,
    summary: "Delete T5 A",
  });
  const a2 = env.services.pendingActions.create({
    conversation_id: env.conversation.id,
    tool: "delete_task",
    target_id: task.id,
    summary: "Delete T5 B",
  });

  // Pass undefined and null as error
  env.services.pendingActions.markFailed(a1.id, undefined as any);
  env.services.pendingActions.markFailed(a2.id, null as any);

  assertEquals(env.services.pendingActions.view(a1.id)?.status, "failed");
  assertEquals(env.services.pendingActions.view(a2.id)?.status, "failed");
});

add("approval-recovery-006", "Action status failed is visible in withCurrentStatus", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Status Failed Msg" });
  await env.executor.execute("delete_task", { task: task.id }, "call_r6");
  const action = env.executor.approvalFor("call_r6")!;
  env.services.tasks.delete(task.id);

  await runApprovedAction(ALL_TOOLS, env.ctx, action.id);

  const messages: any[] = [{ id: "m6", tools: [{ id: "call_r6", name: "delete_task", approval: action }] }];
  const refreshed = env.services.pendingActions.withCurrentStatus(messages);
  assertEquals(refreshed[0].tools[0].approval.status, "failed");
  assertEquals(refreshed[0].tools[0].approval.error, "This task no longer exists.");
});

add("approval-recovery-007", "Activity log does not record success when action execution fails", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "No Activity Task" });
  await env.executor.execute("delete_task", { task: task.id }, "call_r7");
  const action = env.executor.approvalFor("call_r7")!;
  env.services.tasks.delete(task.id);

  await runApprovedAction(ALL_TOOLS, env.ctx, action.id);
  const activities = env.services.db.all<{ type: string; summary: string }>(
    "SELECT type, summary FROM tal_activity WHERE summary LIKE '%No Activity Task%'",
  );
  assertEquals(activities.length, 0);
});

add("approval-recovery-008", "Failed action cannot subsequently be approved", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Fail No Reapprove" });
  await env.executor.execute("delete_task", { task: task.id }, "call_r8");
  const action = env.executor.approvalFor("call_r8")!;
  env.services.tasks.delete(task.id);

  await runApprovedAction(ALL_TOOLS, env.ctx, action.id);

  await assertRejects(
    () => runApprovedAction(ALL_TOOLS, env.ctx, action.id),
    /already handled/,
    "Failed action must reject approval attempts with already handled",
  );
});

add("approval-recovery-009", "Failed action cannot subsequently be cancelled", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Fail No Cancel" });
  await env.executor.execute("delete_task", { task: task.id }, "call_r9");
  const action = env.executor.approvalFor("call_r9")!;
  env.services.tasks.delete(task.id);

  await runApprovedAction(ALL_TOOLS, env.ctx, action.id);
  const ok = env.services.pendingActions.resolve(action.id, "cancelled");
  assertEquals(ok, false);
});

add("approval-recovery-010", "Failed action preserves error details across view reloads", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "T10" });
  const action = env.services.pendingActions.create({
    conversation_id: env.conversation.id,
    tool: "delete_task",
    target_id: task.id,
    summary: "Delete T10",
  });
  env.services.pendingActions.markFailed(action.id, "Connection timeout to external backend");

  const v1 = env.services.pendingActions.view(action.id)!;
  const v2 = env.services.pendingActions.view(action.id)!;
  assertEquals(v1.error, "Connection timeout to external backend");
  assertEquals(v2.error, "Connection timeout to external backend");
});

// 2. Database Rollback on action failure (011 - 020)
add("approval-recovery-011", "Destructive tool that mutates DB before throwing error rolls back DB mutations", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Must Rollback Task" });

  const rollbackTool = defineTool({
    name: "rollback_test_tool",
    description: "Mutates and throws",
    permission: "destructive",
    input: z.object({ id: z.string() }),
    label: () => "rollback",
    prepare: (i) => ({ targetId: i.id, summary: "Rollback Test" }),
    commit: (id, ctx) => {
      ctx.services.tasks.delete(id);
      throw new Error("Simulated failure midway through commit");
    },
  });

  const ex = env.createExecutor([rollbackTool]);
  await ex.execute("rollback_test_tool", { id: task.id }, "call_rb1");
  const action = ex.approvalFor("call_rb1")!;

  const res = await runApprovedAction([rollbackTool], env.ctx, action.id);
  assertEquals(res.status, "failed");

  // Crucial invariant: task MUST still exist in database due to transaction rollback!
  assert(env.services.tasks.get(task.id) !== null, "Task must NOT be deleted if commit threw an error");
});

add("approval-recovery-012", "Multi-table mutation rollback: task deletion and note creation rolled back atomically", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Multi Table Task" });

  const multiTool = defineTool({
    name: "multi_table_fail",
    description: "Deletes task, creates note, then throws",
    permission: "destructive",
    input: z.object({ id: z.string() }),
    label: () => "multi",
    prepare: (i) => ({ targetId: i.id, summary: "Multi Rollback" }),
    commit: (id, ctx) => {
      ctx.services.tasks.delete(id);
      ctx.services.notes.create({ title: "Ghost Note", content: "Should not persist" });
      throw new Error("Crash after note creation");
    },
  });

  const ex = env.createExecutor([multiTool]);
  await ex.execute("multi_table_fail", { id: task.id }, "call_multi");
  const action = ex.approvalFor("call_multi")!;

  await runApprovedAction([multiTool], env.ctx, action.id);

  // Both mutations must be rolled back
  assert(env.services.tasks.get(task.id) !== null, "Task must still exist");
  const ghostNotes = env.services.notes.list().filter((n) => n.title === "Ghost Note");
  assertEquals(ghostNotes.length, 0);
});

add("approval-recovery-013", "Activity log written during failed commit is rolled back atomically", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Activity Rollback Task" });

  const actTool = defineTool({
    name: "act_rollback_tool",
    description: "Writes activity then throws",
    permission: "destructive",
    input: z.object({ id: z.string() }),
    label: () => "act",
    prepare: (i) => ({ targetId: i.id, summary: "Act Rollback" }),
    commit: (id, ctx) => {
      ctx.services.activity.record("test.fail", "Should be rolled back");
      throw new Error("Crash after activity write");
    },
  });

  const ex = env.createExecutor([actTool]);
  await ex.execute("act_rollback_tool", { id: task.id }, "call_act_rb");
  const action = ex.approvalFor("call_act_rb")!;

  await runApprovedAction([actTool], env.ctx, action.id);
  const acts = env.services.db.all<{ type: string }>("SELECT type FROM tal_activity WHERE type = 'test.fail'");
  assertEquals(acts.length, 0);
});

add("approval-recovery-014", "Failed commit rollback does not affect pre-existing unrelated data", async () => {
  const env = createTestEnv();
  const existingTask = env.services.tasks.create({ title: "Pre-existing Task" });
  const existingNote = env.services.notes.create({ title: "Pre-existing Note", content: "Keep" });

  const failTool = defineTool({
    name: "fail_isolated",
    description: "Fails without collateral damage",
    permission: "destructive",
    input: z.object({ id: z.string() }),
    label: () => "fail",
    prepare: (i) => ({ targetId: i.id, summary: "Fail Isolated" }),
    commit: (id, ctx) => {
      ctx.services.tasks.delete(existingTask.id);
      throw new Error("Collateral test crash");
    },
  });

  const ex = env.createExecutor([failTool]);
  await ex.execute("fail_isolated", { id: existingTask.id }, "call_iso");
  const action = ex.approvalFor("call_iso")!;

  await runApprovedAction([failTool], env.ctx, action.id);

  assert(env.services.tasks.get(existingTask.id) !== null, "Pre-existing task must be restored");
  assert(env.services.notes.get(existingNote.id) !== null, "Pre-existing note must remain intact");
});

add("approval-recovery-015", "Batch deletion tool rollback restores all deleted items if one item fails", async () => {
  const env = createTestEnv();
  const t1 = env.services.tasks.create({ title: "Batch 1" });
  const t2 = env.services.tasks.create({ title: "Batch 2" });
  const t3 = env.services.tasks.create({ title: "Batch 3" });

  const batchTool = defineTool({
    name: "batch_delete_fail",
    description: "Deletes 3 tasks then fails on 3rd",
    permission: "destructive",
    input: z.object({ id: z.string() }),
    label: () => "batch",
    prepare: (i) => ({ targetId: i.id, summary: "Batch Fail" }),
    commit: (id, ctx) => {
      ctx.services.tasks.delete(t1.id);
      ctx.services.tasks.delete(t2.id);
      throw new Error("Failed before deleting t3");
    },
  });

  const ex = env.createExecutor([batchTool]);
  await ex.execute("batch_delete_fail", { id: "any" }, "call_batch");
  const action = ex.approvalFor("call_batch")!;

  await runApprovedAction([batchTool], env.ctx, action.id);

  assert(env.services.tasks.get(t1.id) !== null, "t1 must be restored");
  assert(env.services.tasks.get(t2.id) !== null, "t2 must be restored");
  assert(env.services.tasks.get(t3.id) !== null, "t3 must remain");
});

add("approval-recovery-016", "Rollback preserves pending action status failed in DB", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "T16" });

  const tool = defineTool({
    name: "fail_16",
    description: "Fails",
    permission: "destructive",
    input: z.object({ id: z.string() }),
    label: () => "fail",
    prepare: (i) => ({ targetId: i.id, summary: "Fail 16" }),
    commit: () => {
      throw new Error("Commit error 16");
    },
  });

  const ex = env.createExecutor([tool]);
  await ex.execute("fail_16", { id: task.id }, "call_16");
  const action = ex.approvalFor("call_16")!;

  await runApprovedAction([tool], env.ctx, action.id);
  const stored = env.services.pendingActions.get(action.id)!;
  assertEquals(stored.status, "failed");
  assertEquals(stored.error, "The action failed.");
});

add("approval-recovery-017", "Async tool commit error properly records failed status", async () => {
  const env = createTestEnv();
  const asyncTool = defineTool({
    name: "async_fail_tool",
    description: "Async failure",
    permission: "destructive",
    input: z.object({ id: z.string() }),
    label: () => "async_fail",
    prepare: (i) => ({ targetId: i.id, summary: "Async Fail" }),
    commit: async () => {
      await new Promise((r) => setTimeout(r, 5));
      throw new ToolError("Remote async API error");
    },
  });

  const ex = env.createExecutor([asyncTool]);
  await ex.execute("async_fail_tool", { id: "async_tgt" }, "call_async_fail");
  const action = ex.approvalFor("call_async_fail")!;

  const res = await runApprovedAction([asyncTool], env.ctx, action.id);
  assertEquals(res.status, "failed");
  assertEquals(res.error, "Remote async API error");
});

add("approval-recovery-018", "Async tool commit success permanently commits changes", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Async Success Task" });

  const asyncTool = defineTool({
    name: "async_success_tool",
    description: "Async success",
    permission: "destructive",
    input: z.object({ id: z.string() }),
    label: () => "async_succ",
    prepare: (i) => ({ targetId: i.id, summary: "Async Success" }),
    commit: async (id, ctx) => {
      await new Promise((r) => setTimeout(r, 5));
      ctx.services.tasks.delete(id);
    },
  });

  const ex = env.createExecutor([asyncTool]);
  await ex.execute("async_success_tool", { id: task.id }, "call_async_succ");
  const action = ex.approvalFor("call_async_succ")!;

  const res = await runApprovedAction([asyncTool], env.ctx, action.id);
  assertEquals(res.status, "approved");
  assertEquals(env.services.tasks.get(task.id), null);
});

add("approval-recovery-019", "When tool commit succeeds, database mutations are committed permanently", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Perm Delete Task" });
  await env.executor.execute("delete_task", { task: task.id }, "call_perm");
  const action = env.executor.approvalFor("call_perm")!;
  await runApprovedAction(ALL_TOOLS, env.ctx, action.id);
  assertEquals(env.services.tasks.get(task.id), null);
});

add("approval-recovery-020", "Tool commit throwing non-Error object stringifies error message safely", async () => {
  const env = createTestEnv();
  const weirdTool = defineTool({
    name: "weird_fail",
    description: "Throws string",
    permission: "destructive",
    input: z.object({ id: z.string() }),
    label: () => "weird",
    prepare: (i) => ({ targetId: i.id, summary: "Weird Fail" }),
    commit: () => {
      throw "Raw string error thrown";
    },
  });

  const ex = env.createExecutor([weirdTool]);
  await ex.execute("weird_fail", { id: "tgt" }, "call_weird");
  const action = ex.approvalFor("call_weird")!;

  const res = await runApprovedAction([weirdTool], env.ctx, action.id);
  assertEquals(res.status, "failed");
  assertEquals(res.error, "The action failed.");
});

// 3. Automatic cleanup of timed-out expired actions (021 - 030)
add("approval-recovery-021", "cleanupExpired deletes pending actions whose expires_at is in the past", () => {
  const env = createTestEnv();
  const a1 = env.services.pendingActions.create({
    conversation_id: env.conversation.id,
    tool: "delete_task",
    target_id: "t1",
    summary: "Expired Action 1",
  });
  const a2 = env.services.pendingActions.create({
    conversation_id: env.conversation.id,
    tool: "delete_task",
    target_id: "t2",
    summary: "Expired Action 2",
  });

  // Force both to be expired
  env.services.db.run(`UPDATE tal_pending_actions SET expires_at = ?`, new Date(Date.now() - 1000).toISOString());

  const deleted = env.services.pendingActions.cleanupExpired();
  assertEquals(deleted, 2);
  assertEquals(env.services.pendingActions.get(a1.id), null);
  assertEquals(env.services.pendingActions.get(a2.id), null);
});

add("approval-recovery-022", "cleanupExpired does NOT delete active, unexpired pending actions", () => {
  const env = createTestEnv();
  const active = env.services.pendingActions.create({
    conversation_id: env.conversation.id,
    tool: "delete_task",
    target_id: "t_act",
    summary: "Active Action",
  });

  const deleted = env.services.pendingActions.cleanupExpired();
  assertEquals(deleted, 0);
  assert(env.services.pendingActions.get(active.id) !== null, "Active action must not be cleaned up");
});

add("approval-recovery-023", "cleanupExpired does NOT delete approved actions even if expires_at is past", () => {
  const env = createTestEnv();
  const app = env.services.pendingActions.create({
    conversation_id: env.conversation.id,
    tool: "delete_task",
    target_id: "t_app",
    summary: "Approved Action",
  });
  env.services.pendingActions.resolve(app.id, "approved");
  env.services.db.run(`UPDATE tal_pending_actions SET expires_at = ? WHERE id = ?`, new Date(Date.now() - 1000).toISOString(), app.id);

  const deleted = env.services.pendingActions.cleanupExpired();
  assertEquals(deleted, 0);
  assert(env.services.pendingActions.get(app.id) !== null, "Approved action must be preserved");
});

add("approval-recovery-024", "cleanupExpired does NOT delete cancelled actions even if expires_at is past", () => {
  const env = createTestEnv();
  const can = env.services.pendingActions.create({
    conversation_id: env.conversation.id,
    tool: "delete_task",
    target_id: "t_can",
    summary: "Cancelled Action",
  });
  env.services.pendingActions.resolve(can.id, "cancelled");
  env.services.db.run(`UPDATE tal_pending_actions SET expires_at = ? WHERE id = ?`, new Date(Date.now() - 1000).toISOString(), can.id);

  const deleted = env.services.pendingActions.cleanupExpired();
  assertEquals(deleted, 0);
  assert(env.services.pendingActions.get(can.id) !== null, "Cancelled action must be preserved");
});

add("approval-recovery-025", "cleanupExpired does NOT delete failed actions even if expires_at is past", () => {
  const env = createTestEnv();
  const f = env.services.pendingActions.create({
    conversation_id: env.conversation.id,
    tool: "delete_task",
    target_id: "t_fail",
    summary: "Failed Action",
  });
  env.services.pendingActions.markFailed(f.id, "Failure");
  env.services.db.run(`UPDATE tal_pending_actions SET expires_at = ? WHERE id = ?`, new Date(Date.now() - 1000).toISOString(), f.id);

  const deleted = env.services.pendingActions.cleanupExpired();
  assertEquals(deleted, 0);
  assert(env.services.pendingActions.get(f.id) !== null, "Failed action must be preserved");
});

add("approval-recovery-026", "cleanupExpired with olderThanMs only deletes actions expired past threshold", () => {
  const env = createTestEnv();
  const aFresh = env.services.pendingActions.create({
    conversation_id: env.conversation.id,
    tool: "delete_task",
    target_id: "t_fresh",
    summary: "Fresh Expired",
  });
  const aOld = env.services.pendingActions.create({
    conversation_id: env.conversation.id,
    tool: "delete_task",
    target_id: "t_old",
    summary: "Old Expired",
  });

  // Fresh expired 10 seconds ago
  env.services.db.run(`UPDATE tal_pending_actions SET expires_at = ? WHERE id = ?`, new Date(Date.now() - 10_000).toISOString(), aFresh.id);
  // Old expired 2 hours ago
  env.services.db.run(`UPDATE tal_pending_actions SET expires_at = ? WHERE id = ?`, new Date(Date.now() - 7200_000).toISOString(), aOld.id);

  // Clean actions expired older than 1 hour (3600_000ms)
  const deleted = env.services.pendingActions.cleanupExpired(3600_000);
  assertEquals(deleted, 1);
  assert(env.services.pendingActions.get(aFresh.id) !== null, "Fresh expired action should still exist");
  assertEquals(env.services.pendingActions.get(aOld.id), null);
});

add("approval-recovery-027", "pendingActions.create automatically cleans up timed-out expired pending actions", () => {
  const env = createTestEnv();
  const stale = env.services.pendingActions.create({
    conversation_id: env.conversation.id,
    tool: "delete_task",
    target_id: "t_stale",
    summary: "Stale Pending",
  });
  env.services.db.run(`UPDATE tal_pending_actions SET expires_at = ? WHERE id = ?`, new Date(Date.now() - 5000).toISOString(), stale.id);

  // Creating a new pending action triggers automatic cleanup of expired actions
  const fresh = env.services.pendingActions.create({
    conversation_id: env.conversation.id,
    tool: "delete_task",
    target_id: "t_fresh2",
    summary: "Fresh New Action",
  });

  assertEquals(env.services.pendingActions.get(stale.id), null);
  assert(env.services.pendingActions.get(fresh.id) !== null, "Fresh action must exist");
});

add("approval-recovery-028", "cleanupExpired handles purge of 50 expired actions efficiently", () => {
  const env = createTestEnv();
  for (let i = 0; i < 50; i++) {
    env.services.pendingActions.create({
      conversation_id: env.conversation.id,
      tool: "delete_task",
      target_id: `t_bulk_${i}`,
      summary: `Bulk ${i}`,
    });
  }
  // Expire all 50 in bulk
  env.services.db.run(`UPDATE tal_pending_actions SET expires_at = ?`, new Date(Date.now() - 1000).toISOString());

  const deleted = env.services.pendingActions.cleanupExpired();
  assertEquals(deleted, 50);
});

add("approval-recovery-029", "cleanupExpired on empty database returns 0 changes without error", () => {
  const env = createTestEnv();
  const deleted = env.services.pendingActions.cleanupExpired();
  assertEquals(deleted, 0);
});

add("approval-recovery-030", "Referential integrity is maintained after expired action cleanup", () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Task for ref check" });
  const a = env.services.pendingActions.create({
    conversation_id: env.conversation.id,
    tool: "delete_task",
    target_id: task.id,
    summary: "Delete ref",
  });
  env.services.db.run(`UPDATE tal_pending_actions SET expires_at = ? WHERE id = ?`, new Date(Date.now() - 1000).toISOString(), a.id);

  env.services.pendingActions.cleanupExpired();

  // Task and conversation must remain intact and valid
  assert(env.services.tasks.get(task.id) !== null, "Task must remain intact");
  assert(env.services.conversations.get(env.conversation.id) !== null, "Conversation must remain intact");
});
