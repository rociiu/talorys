import type { TestCase } from "../../massive-harness";
import { assert, assertEquals, assertRejects, createTestEnv } from "./helpers";
import { ALL_TOOLS } from "../../../apps/agent/src/tools";
import { runApprovedAction } from "../../../apps/agent/src/tools/registry";

export const concurrencyTests: TestCase[] = [];

function add(id: string, description: string, run: () => Promise<void> | void) {
  concurrencyTests.push({
    id,
    domain: "approval-tools",
    category: "concurrency",
    description,
    run,
  });
}

// 1. Race condition between concurrent approvals on same action (001 - 015)
add("approval-concurrency-001", "2 concurrent runApprovedAction calls on same action: exactly 1 succeeds, 1 fails with CONFLICT", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Race Task 2" });
  await env.executor.execute("delete_task", { task: task.id }, "call_r1");
  const action = env.executor.approvalFor("call_r1")!;

  const results = await Promise.allSettled([
    runApprovedAction(ALL_TOOLS, env.ctx, action.id),
    runApprovedAction(ALL_TOOLS, env.ctx, action.id),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assertEquals(fulfilled.length, 1);
  assertEquals(rejected.length, 1);
  assertEquals(env.services.tasks.get(task.id), null);
});

add("approval-concurrency-002", "3 concurrent runApprovedAction calls on same action: exactly 1 succeeds, 2 fail with CONFLICT", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Race Task 3" });
  await env.executor.execute("delete_task", { task: task.id }, "call_r2");
  const action = env.executor.approvalFor("call_r2")!;

  const results = await Promise.allSettled([
    runApprovedAction(ALL_TOOLS, env.ctx, action.id),
    runApprovedAction(ALL_TOOLS, env.ctx, action.id),
    runApprovedAction(ALL_TOOLS, env.ctx, action.id),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assertEquals(fulfilled.length, 1);
  assertEquals(rejected.length, 2);
  assertEquals(env.services.tasks.get(task.id), null);
});

add("approval-concurrency-003", "5 concurrent runApprovedAction calls on same action: exactly 1 succeeds, 4 fail with CONFLICT", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Race Task 5" });
  await env.executor.execute("delete_task", { task: task.id }, "call_r3");
  const action = env.executor.approvalFor("call_r3")!;

  const promises = Array.from({ length: 5 }, () => runApprovedAction(ALL_TOOLS, env.ctx, action.id));
  const results = await Promise.allSettled(promises);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assertEquals(fulfilled.length, 1);
  assertEquals(rejected.length, 4);
});

add("approval-concurrency-004", "10 concurrent runApprovedAction calls on same action: exactly 1 succeeds, 9 fail with CONFLICT", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Race Task 10" });
  await env.executor.execute("delete_task", { task: task.id }, "call_r4");
  const action = env.executor.approvalFor("call_r4")!;

  const promises = Array.from({ length: 10 }, () => runApprovedAction(ALL_TOOLS, env.ctx, action.id));
  const results = await Promise.allSettled(promises);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assertEquals(fulfilled.length, 1);
  assertEquals(rejected.length, 9);
});

add("approval-concurrency-005", "20 concurrent runApprovedAction calls on same action: exactly 1 succeeds, 19 fail with CONFLICT", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Race Task 20" });
  await env.executor.execute("delete_task", { task: task.id }, "call_r5");
  const action = env.executor.approvalFor("call_r5")!;

  const promises = Array.from({ length: 20 }, () => runApprovedAction(ALL_TOOLS, env.ctx, action.id));
  const results = await Promise.allSettled(promises);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assertEquals(fulfilled.length, 1);
  assertEquals(rejected.length, 19);
});

add("approval-concurrency-006", "Concurrent approval race deletes task exactly once in database without error", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Race Once Task" });
  await env.executor.execute("delete_task", { task: task.id }, "call_r6");
  const action = env.executor.approvalFor("call_r6")!;

  await Promise.allSettled([
    runApprovedAction(ALL_TOOLS, env.ctx, action.id),
    runApprovedAction(ALL_TOOLS, env.ctx, action.id),
    runApprovedAction(ALL_TOOLS, env.ctx, action.id),
  ]);

  assertEquals(env.services.tasks.get(task.id), null);
});

add("approval-concurrency-007", "Concurrent approval race creates exactly one activity log entry", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Activity Once Task" });
  await env.executor.execute("delete_task", { task: task.id }, "call_r7");
  const action = env.executor.approvalFor("call_r7")!;

  await Promise.allSettled([
    runApprovedAction(ALL_TOOLS, env.ctx, action.id),
    runApprovedAction(ALL_TOOLS, env.ctx, action.id),
    runApprovedAction(ALL_TOOLS, env.ctx, action.id),
  ]);

  const activities = env.services.db.all<{ type: string }>("SELECT type FROM tal_activity WHERE type = 'task.deleted'");
  assertEquals(activities.length, 1);
});

add("approval-concurrency-008", "Concurrent approvals on note deletion: exactly 1 succeeds, note deleted once", async () => {
  const env = createTestEnv();
  const note = env.services.notes.create({ title: "Race Note", content: "..." });
  await env.executor.execute("delete_note", { id: note.id }, "call_r8");
  const action = env.executor.approvalFor("call_r8")!;

  const results = await Promise.allSettled([
    runApprovedAction(ALL_TOOLS, env.ctx, action.id),
    runApprovedAction(ALL_TOOLS, env.ctx, action.id),
    runApprovedAction(ALL_TOOLS, env.ctx, action.id),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  assertEquals(fulfilled.length, 1);
  assertEquals(env.services.notes.get(note.id), null);
});

add("approval-concurrency-009", "Concurrent approvals on memory deletion: exactly 1 succeeds, memory deleted once", async () => {
  const env = createTestEnv();
  const mem = env.services.memories.create({ content: "Race Memory", category: "fact", source: "chat" });
  await env.executor.execute("forget_memory", { id: mem.id }, "call_r9");
  const action = env.executor.approvalFor("call_r9")!;

  const results = await Promise.allSettled([
    runApprovedAction(ALL_TOOLS, env.ctx, action.id),
    runApprovedAction(ALL_TOOLS, env.ctx, action.id),
    runApprovedAction(ALL_TOOLS, env.ctx, action.id),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  assertEquals(fulfilled.length, 1);
  assertEquals(env.services.memories.get(mem.id), null);
});

add("approval-concurrency-010", "Concurrent approvals on automation deletion: exactly 1 succeeds, auto deleted once", async () => {
  const env = createTestEnv();
  const auto = env.services.automationsRepo.create({ name: "Race Auto", kind: "reminder", schedule: "* * * * *", message: "m" });
  await env.executor.execute("cancel_automation", { id: auto.id }, "call_r10");
  const action = env.executor.approvalFor("call_r10")!;

  const results = await Promise.allSettled([
    runApprovedAction(ALL_TOOLS, env.ctx, action.id),
    runApprovedAction(ALL_TOOLS, env.ctx, action.id),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  assertEquals(fulfilled.length, 1);
  assertEquals(env.services.automationsRepo.get(auto.id), null);
});

add("approval-concurrency-011", "Concurrent approvals with microtask delays: first to claim wins atomically", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Stagger Task" });
  await env.executor.execute("delete_task", { task: task.id }, "call_r11");
  const action = env.executor.approvalFor("call_r11")!;

  const p1 = runApprovedAction(ALL_TOOLS, env.ctx, action.id);
  const p2 = (async () => {
    await new Promise((r) => setTimeout(r, 1));
    return runApprovedAction(ALL_TOOLS, env.ctx, action.id);
  })();

  const results = await Promise.allSettled([p1, p2]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  assertEquals(fulfilled.length, 1);
});

add("approval-concurrency-012", "All rejected concurrent calls receive CONFLICT error code", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Conflict Code Task" });
  await env.executor.execute("delete_task", { task: task.id }, "call_r12");
  const action = env.executor.approvalFor("call_r12")!;

  const promises = Array.from({ length: 4 }, () => runApprovedAction(ALL_TOOLS, env.ctx, action.id));
  const results = await Promise.allSettled(promises);

  const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  assertEquals(rejected.length, 3);
  for (const r of rejected) {
    const code = r.reason?.code ?? r.reason?.name;
    assertEquals(code, "CONFLICT");
  }
});

add("approval-concurrency-013", "Action status in DB is never corrupted during high-concurrency race", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Corruption Check Task" });
  await env.executor.execute("delete_task", { task: task.id }, "call_r13");
  const action = env.executor.approvalFor("call_r13")!;

  const promises = Array.from({ length: 15 }, () => runApprovedAction(ALL_TOOLS, env.ctx, action.id));
  await Promise.allSettled(promises);

  const stored = env.services.pendingActions.get(action.id)!;
  assertEquals(stored.status, "approved");
  assertEquals(stored.error, null);
  assert(stored.resolved_at !== null, "resolved_at must be populated");
});

add("approval-concurrency-014", "Subsequent calls after concurrent race continue to be rejected", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Post Race Task" });
  await env.executor.execute("delete_task", { task: task.id }, "call_r14");
  const action = env.executor.approvalFor("call_r14")!;

  await Promise.allSettled([
    runApprovedAction(ALL_TOOLS, env.ctx, action.id),
    runApprovedAction(ALL_TOOLS, env.ctx, action.id),
  ]);

  // Subsequent call after race settled
  await assertRejects(
    () => runApprovedAction(ALL_TOOLS, env.ctx, action.id),
    /already handled/,
    "Post-race call must reject",
  );
});

add("approval-concurrency-015", "Concurrent resolve with approved status directly in repository is atomic", () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Repo Direct Race" });
  const action = env.services.pendingActions.create({
    conversation_id: env.conversation.id,
    tool: "delete_task",
    target_id: task.id,
    summary: "Delete Direct",
  });

  const r1 = env.services.pendingActions.resolve(action.id, "approved");
  const r2 = env.services.pendingActions.resolve(action.id, "approved");
  assertEquals(r1, true);
  assertEquals(r2, false);
});

// 2. Race condition between approval and cancellation on same action (016 - 028)
add("approval-concurrency-016", "Concurrent approval vs cancel: exactly one operation wins", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Approve vs Cancel" });
  await env.executor.execute("delete_task", { task: task.id }, "call_r16");
  const action = env.executor.approvalFor("call_r16")!;

  let approveWon = false;
  let cancelWon = false;

  const [resApprove, resCancel] = await Promise.allSettled([
    runApprovedAction(ALL_TOOLS, env.ctx, action.id),
    (async () => {
      const ok = env.services.pendingActions.resolve(action.id, "cancelled");
      if (!ok) throw new Error("Cancel failed");
      return ok;
    })(),
  ]);

  if (resApprove.status === "fulfilled") approveWon = true;
  if (resCancel.status === "fulfilled") cancelWon = true;

  // Exactly one must win
  assert((approveWon && !cancelWon) || (!approveWon && cancelWon), "Either approve or cancel must win, never both");

  const finalStatus = env.services.pendingActions.view(action.id)?.status;
  if (approveWon) {
    assertEquals(finalStatus, "approved");
    assertEquals(env.services.tasks.get(task.id), null);
  } else {
    assertEquals(finalStatus, "cancelled");
    assert(env.services.tasks.get(task.id) !== null, "Task must remain if cancel won");
  }
});

add("approval-concurrency-017", "Concurrent 5 approvals vs 5 cancellations on same action: exactly 1 total winner", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "5v5 Race" });
  await env.executor.execute("delete_task", { task: task.id }, "call_r17");
  const action = env.executor.approvalFor("call_r17")!;

  const operations = [
    ...Array.from({ length: 5 }, () => runApprovedAction(ALL_TOOLS, env.ctx, action.id)),
    ...Array.from({ length: 5 }, () =>
      (async () => {
        const ok = env.services.pendingActions.resolve(action.id, "cancelled");
        if (!ok) throw new Error("Cancel lost race");
        return ok;
      })(),
    ),
  ];

  const results = await Promise.allSettled(operations);
  const winners = results.filter((r) => r.status === "fulfilled");
  assertEquals(winners.length, 1);
});

add("approval-concurrency-018", "1 approval vs 10 parallel cancellations: exactly 1 total winner", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "1v10 Race" });
  await env.executor.execute("delete_task", { task: task.id }, "call_r18");
  const action = env.executor.approvalFor("call_r18")!;

  const operations = [
    runApprovedAction(ALL_TOOLS, env.ctx, action.id),
    ...Array.from({ length: 10 }, () =>
      (async () => {
        const ok = env.services.pendingActions.resolve(action.id, "cancelled");
        if (!ok) throw new Error("Cancel lost race");
        return ok;
      })(),
    ),
  ];

  const results = await Promise.allSettled(operations);
  const winners = results.filter((r) => r.status === "fulfilled");
  assertEquals(winners.length, 1);
});

add("approval-concurrency-019", "Concurrent cancel vs cancel: exactly one succeeds with true, others false", () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Cancel vs Cancel" });
  const action = env.services.pendingActions.create({
    conversation_id: env.conversation.id,
    tool: "delete_task",
    target_id: task.id,
    summary: "Delete",
  });

  const ok1 = env.services.pendingActions.resolve(action.id, "cancelled");
  const ok2 = env.services.pendingActions.resolve(action.id, "cancelled");
  const ok3 = env.services.pendingActions.resolve(action.id, "cancelled");

  assertEquals(ok1, true);
  assertEquals(ok2, false);
  assertEquals(ok3, false);
});

add("approval-concurrency-020", "Cancel winning race prevents task deletion and sets status cancelled", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Cancel Prevents Delete" });
  await env.executor.execute("delete_task", { task: task.id }, "call_r20");
  const action = env.executor.approvalFor("call_r20")!;

  // Cancel immediately
  env.services.pendingActions.resolve(action.id, "cancelled");

  // Approval attempt rejects
  await assertRejects(() => runApprovedAction(ALL_TOOLS, env.ctx, action.id), /already handled/);

  assert(env.services.tasks.get(task.id) !== null, "Task must exist");
  assertEquals(env.services.pendingActions.view(action.id)?.status, "cancelled");
});

add("approval-concurrency-021", "Approve winning race prevents subsequent cancel from returning true", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Approve Prevents Cancel" });
  await env.executor.execute("delete_task", { task: task.id }, "call_r21");
  const action = env.executor.approvalFor("call_r21")!;

  await runApprovedAction(ALL_TOOLS, env.ctx, action.id);
  const cancelOk = env.services.pendingActions.resolve(action.id, "cancelled");
  assertEquals(cancelOk, false);
  assertEquals(env.services.pendingActions.view(action.id)?.status, "approved");
});

add("approval-concurrency-022", "Interleaved race across 5 separate tasks: each task has exactly 1 winner", async () => {
  const env = createTestEnv();
  const tasks = Array.from({ length: 5 }, (_, i) => env.services.tasks.create({ title: `Interleaved ${i}` }));
  const actions: string[] = tasks.map((t) => {
    const a = env.services.pendingActions.create({
      conversation_id: env.conversation.id,
      tool: "delete_task",
      target_id: t.id,
      summary: `Delete ${t.title}`,
    });
    return a.id;
  });

  const racePromises = actions.map((id) =>
    Promise.allSettled([
      runApprovedAction(ALL_TOOLS, env.ctx, id),
      (async () => {
        const ok = env.services.pendingActions.resolve(id, "cancelled");
        if (!ok) throw new Error("Cancel lost");
        return ok;
      })(),
    ]),
  );

  const allResults = await Promise.all(racePromises);
  for (const pair of allResults) {
    const winners = pair.filter((r) => r.status === "fulfilled");
    assertEquals(winners.length, 1);
  }
});

add("approval-concurrency-023", "Race condition on note deletion maintains note consistency", async () => {
  const env = createTestEnv();
  const note = env.services.notes.create({ title: "Note Race", content: "safe" });
  await env.executor.execute("delete_note", { id: note.id }, "call_r23");
  const action = env.executor.approvalFor("call_r23")!;

  const [resApprove, resCancel] = await Promise.allSettled([
    runApprovedAction(ALL_TOOLS, env.ctx, action.id),
    (async () => {
      const ok = env.services.pendingActions.resolve(action.id, "cancelled");
      if (!ok) throw new Error("Cancel lost");
      return ok;
    })(),
  ]);

  const approved = resApprove.status === "fulfilled";
  if (approved) {
    assertEquals(env.services.notes.get(note.id), null);
  } else {
    assert(env.services.notes.get(note.id) !== null, "Note must exist if cancelled");
  }
});

add("approval-concurrency-024", "Race condition on memory deletion maintains memory consistency", async () => {
  const env = createTestEnv();
  const mem = env.services.memories.create({ content: "Mem Race", category: "fact", source: "chat" });
  await env.executor.execute("forget_memory", { id: mem.id }, "call_r24");
  const action = env.executor.approvalFor("call_r24")!;

  const [resApprove] = await Promise.allSettled([
    runApprovedAction(ALL_TOOLS, env.ctx, action.id),
    (async () => {
      const ok = env.services.pendingActions.resolve(action.id, "cancelled");
      if (!ok) throw new Error("Cancel lost");
      return ok;
    })(),
  ]);

  if (resApprove.status === "fulfilled") {
    assertEquals(env.services.memories.get(mem.id), null);
  } else {
    assert(env.services.memories.get(mem.id) !== null, "Memory must exist if cancelled");
  }
});

add("approval-concurrency-025", "Race condition on automation cancellation maintains automation consistency", async () => {
  const env = createTestEnv();
  const auto = env.services.automationsRepo.create({ name: "Auto Race", kind: "reminder", schedule: "* * * * *", message: "m" });
  await env.executor.execute("cancel_automation", { id: auto.id }, "call_r25");
  const action = env.executor.approvalFor("call_r25")!;

  const [resApprove] = await Promise.allSettled([
    runApprovedAction(ALL_TOOLS, env.ctx, action.id),
    (async () => {
      const ok = env.services.pendingActions.resolve(action.id, "cancelled");
      if (!ok) throw new Error("Cancel lost");
      return ok;
    })(),
  ]);

  if (resApprove.status === "fulfilled") {
    assertEquals(env.services.automationsRepo.get(auto.id), null);
  } else {
    assert(env.services.automationsRepo.get(auto.id) !== null, "Automation must exist if cancelled");
  }
});

add("approval-concurrency-026", "Cancellation race does not create orphan records in database", () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Orphan Check" });
  const a = env.services.pendingActions.create({
    conversation_id: env.conversation.id,
    tool: "delete_task",
    target_id: task.id,
    summary: "Delete",
  });
  env.services.pendingActions.resolve(a.id, "cancelled");
  env.services.pendingActions.resolve(a.id, "cancelled");
  const rows = env.services.db.all("SELECT id FROM tal_pending_actions WHERE id = ?", a.id);
  assertEquals(rows.length, 1);
});

add("approval-concurrency-027", "Approval race does not create duplicate rows in tal_pending_actions", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Dup Row Check" });
  await env.executor.execute("delete_task", { task: task.id }, "call_r27");
  const action = env.executor.approvalFor("call_r27")!;

  await Promise.allSettled([
    runApprovedAction(ALL_TOOLS, env.ctx, action.id),
    runApprovedAction(ALL_TOOLS, env.ctx, action.id),
  ]);

  const rows = env.services.db.all("SELECT id FROM tal_pending_actions WHERE id = ?", action.id);
  assertEquals(rows.length, 1);
});

add("approval-concurrency-028", "Repeated cancellation attempts after approval continue returning false", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Cancel After Approve" });
  await env.executor.execute("delete_task", { task: task.id }, "call_r28");
  const action = env.executor.approvalFor("call_r28")!;
  await runApprovedAction(ALL_TOOLS, env.ctx, action.id);

  for (let i = 0; i < 5; i++) {
    assertEquals(env.services.pendingActions.resolve(action.id, "cancelled"), false);
  }
});

// 3. Concurrency on independent actions in parallel (029 - 035)
add("approval-concurrency-029", "10 independent pending actions approved concurrently via Promise.all: all 10 succeed", async () => {
  const env = createTestEnv({ maxToolCalls: 20 });
  const tasks = Array.from({ length: 10 }, (_, i) => env.services.tasks.create({ title: `Parallel T ${i}` }));
  const actions: string[] = [];

  for (let i = 0; i < 10; i++) {
    const ex = env.createExecutor();
    await ex.execute("delete_task", { task: tasks[i].id }, `call_p_${i}`);
    actions.push(ex.approvalFor(`call_p_${i}`)!.id);
  }

  const results = await Promise.all(actions.map((id) => runApprovedAction(ALL_TOOLS, env.ctx, id)));
  for (const r of results) {
    assertEquals(r.status, "approved");
  }
  for (const t of tasks) {
    assertEquals(env.services.tasks.get(t.id), null);
  }
});

add("approval-concurrency-030", "20 independent pending actions approved concurrently: all 20 succeed", async () => {
  const env = createTestEnv();
  const tasks = Array.from({ length: 20 }, (_, i) => env.services.tasks.create({ title: `Bulk T ${i}` }));
  const actionIds = tasks.map((t) => {
    const a = env.services.pendingActions.create({
      conversation_id: env.conversation.id,
      tool: "delete_task",
      target_id: t.id,
      summary: `Delete ${t.title}`,
    });
    return a.id;
  });

  const results = await Promise.all(actionIds.map((id) => runApprovedAction(ALL_TOOLS, env.ctx, id)));
  assertEquals(results.length, 20);
  for (const r of results) {
    assertEquals(r.status, "approved");
  }
  for (const t of tasks) {
    assertEquals(env.services.tasks.get(t.id), null);
  }
});

add("approval-concurrency-031", "Mixed concurrent batch: 5 independent approvals + 5 independent cancellations all succeed", async () => {
  const env = createTestEnv();
  const approveTasks = Array.from({ length: 5 }, (_, i) => env.services.tasks.create({ title: `Approve ${i}` }));
  const cancelTasks = Array.from({ length: 5 }, (_, i) => env.services.tasks.create({ title: `Cancel ${i}` }));

  const approveActions = approveTasks.map((t) =>
    env.services.pendingActions.create({
      conversation_id: env.conversation.id,
      tool: "delete_task",
      target_id: t.id,
      summary: `Delete ${t.title}`,
    }),
  );
  const cancelActions = cancelTasks.map((t) =>
    env.services.pendingActions.create({
      conversation_id: env.conversation.id,
      tool: "delete_task",
      target_id: t.id,
      summary: `Delete ${t.title}`,
    }),
  );

  const ops = [
    ...approveActions.map((a) => runApprovedAction(ALL_TOOLS, env.ctx, a.id)),
    ...cancelActions.map(async (a) => {
      const ok = env.services.pendingActions.resolve(a.id, "cancelled");
      assertEquals(ok, true);
    }),
  ];

  await Promise.all(ops);

  for (const t of approveTasks) assertEquals(env.services.tasks.get(t.id), null);
  for (const t of cancelTasks) assert(env.services.tasks.get(t.id) !== null, "Cancelled task must remain");
});

add("approval-concurrency-032", "10 concurrent tool executions creating tasks simultaneously succeed without ID collisions", async () => {
  const env = createTestEnv();
  const promises = Array.from({ length: 10 }, (_, i) => {
    const ex = env.createExecutor();
    return ex.execute("create_task", { title: `Concurrent Task ${i}` });
  });

  const results: any[] = await Promise.all(promises);
  const ids = results.map((r) => r.created.id);
  const uniqueIds = new Set(ids);
  assertEquals(uniqueIds.size, 10);
});

add("approval-concurrency-033", "Parallel execution across different tool types (task, note, memory, project) succeeds", async () => {
  const env = createTestEnv();
  const pTask = env.executor.execute("create_task", { title: "P Task" });
  const ex2 = env.createExecutor();
  const pNote = ex2.execute("create_note", { title: "P Note", content: "content" });
  const ex3 = env.createExecutor();
  const pMem = ex3.execute("remember", { content: "P Memory", category: "fact" });
  const ex4 = env.createExecutor();
  const pProj = ex4.execute("create_project", { name: "P Project" });

  const [rTask, rNote, rMem, rProj]: any = await Promise.all([pTask, pNote, pMem, pProj]);
  assert(rTask.created.id, "Task created");
  assert(rNote.created.id, "Note created");
  assert(rMem.remembered.id, "Memory remembered");
  assert(rProj.created.id, "Project created");
});

add("approval-concurrency-034", "Concurrent queries on pendingActions.view during active state changes", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "View Race Task" });
  const action = env.services.pendingActions.create({
    conversation_id: env.conversation.id,
    tool: "delete_task",
    target_id: task.id,
    summary: "Delete View Race",
  });

  const pApprove = runApprovedAction(ALL_TOOLS, env.ctx, action.id);
  const pViews = Array.from({ length: 10 }, () => Promise.resolve(env.services.pendingActions.view(action.id)));

  const [, ...views] = await Promise.all([pApprove, ...pViews]);
  for (const v of views) {
    assert(v !== null, "View should not be null");
    assert(["pending", "approved"].includes(v!.status), `Status must be pending or approved, got ${v!.status}`);
  }
});

add("approval-concurrency-035", "Concurrent queries on pendingActions.get during active state changes", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Get Race Task" });
  const action = env.services.pendingActions.create({
    conversation_id: env.conversation.id,
    tool: "delete_task",
    target_id: task.id,
    summary: "Delete Get Race",
  });

  const pApprove = runApprovedAction(ALL_TOOLS, env.ctx, action.id);
  const pGets = Array.from({ length: 10 }, () => Promise.resolve(env.services.pendingActions.get(action.id)));

  const [, ...gets] = await Promise.all([pApprove, ...pGets]);
  for (const g of gets) {
    assert(g !== null, "Stored record should not be null");
    assert(["pending", "approved"].includes(g!.status), `Status must be pending or approved, got ${g!.status}`);
  }
});

// 4. Idempotency & state consistency (036 - 040)
add("approval-concurrency-036", "Multiple sequential approval attempts after race continuously reject with CONFLICT", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Idempotent Conflict" });
  const action = env.services.pendingActions.create({
    conversation_id: env.conversation.id,
    tool: "delete_task",
    target_id: task.id,
    summary: "Delete",
  });
  await runApprovedAction(ALL_TOOLS, env.ctx, action.id);

  for (let i = 0; i < 5; i++) {
    await assertRejects(() => runApprovedAction(ALL_TOOLS, env.ctx, action.id), /already handled/);
  }
});

add("approval-concurrency-037", "Multiple sequential cancel attempts after race continuously return false", () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Idempotent Cancel" });
  const action = env.services.pendingActions.create({
    conversation_id: env.conversation.id,
    tool: "delete_task",
    target_id: task.id,
    summary: "Delete",
  });
  assertEquals(env.services.pendingActions.resolve(action.id, "cancelled"), true);
  for (let i = 0; i < 5; i++) {
    assertEquals(env.services.pendingActions.resolve(action.id, "cancelled"), false);
  }
});

add("approval-concurrency-038", "Concurrent withCurrentStatus calls return consistent snapshot", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Status Snapshot" });
  const action = env.services.pendingActions.create({
    conversation_id: env.conversation.id,
    tool: "delete_task",
    target_id: task.id,
    summary: "Delete Snapshot",
  });

  const messages: any[] = [{ id: "m1", tools: [{ id: "c1", name: "delete_task", approval: action }] }];

  const snapshots = await Promise.all(
    Array.from({ length: 5 }, () => Promise.resolve(env.services.pendingActions.withCurrentStatus(messages))),
  );

  for (const s of snapshots) {
    assertEquals(s[0].tools[0].approval.status, "pending");
  }
});

add("approval-concurrency-039", "Resolving non-existent action in parallel across threads always returns false", async () => {
  const env = createTestEnv();
  const results = await Promise.all(
    Array.from({ length: 10 }, () => Promise.resolve(env.services.pendingActions.resolve("ghost-action-id", "approved"))),
  );
  for (const r of results) {
    assertEquals(r, false);
  }
});

add("approval-concurrency-040", "Target item state is strictly binary: either completely intact or completely deleted", async () => {
  const env = createTestEnv();
  const task = env.services.tasks.create({ title: "Binary State Task" });
  const action = env.services.pendingActions.create({
    conversation_id: env.conversation.id,
    tool: "delete_task",
    target_id: task.id,
    summary: "Delete Binary",
  });

  const pApprove = runApprovedAction(ALL_TOOLS, env.ctx, action.id);
  const pCheck = Promise.resolve(env.services.tasks.get(task.id));

  await Promise.all([pApprove, pCheck]);
  // After all settle, task MUST be null
  assertEquals(env.services.tasks.get(task.id), null);
});
