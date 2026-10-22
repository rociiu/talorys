import { describe, expect, it, vi } from "vitest";
import { proposedPlanInputSchema, taskPlanContentSchema, type TaskPlanContent, type TaskPlanDraft } from "@talorys/shared";
import { type Client, inAgent, loggedIn, readSse } from "./helpers";
import { ALL_TOOLS, ToolExecutor } from "../src/tools";
import { AgentRunner } from "../src/agent/runner";
import type { AgentEvent, AIProvider, GenerateRequest, ToolRequest } from "../src/ai/provider";
import { MIGRATIONS, migrate } from "../src/db/migrations";
import type { Services } from "../src/services/container";
import { exportData } from "../src/services/backup";
import { isRemoteAllowed } from "../src/remote/allowlist";

let seq = 0;
/** Unique titles, since the Durable Object's data is shared by the tests in this file. */
const uniq = (s: string) => `${s} ${++seq}-${Math.random().toString(36).slice(2, 7)}`;

function executor(s: Services, conversationId?: string) {
  return new ToolExecutor(ALL_TOOLS, { services: s, timezone: "UTC", mode: "chat", conversationId: conversationId ?? s.conversations.create().id }, { maxToolCalls: 6 });
}

/** Proposes a plan through the real tool pipeline and returns the stored draft. */
async function propose(s: Services, input: Record<string, unknown>): Promise<TaskPlanDraft> {
  const ex = executor(s);
  const out = (await ex.execute("propose_task_plan", input, "call-1")) as { plan_id: string };
  expect(ex.planFor("call-1")).toBe(out.plan_id);
  return s.taskPlans.get(out.plan_id)!;
}

const taskCount = (s: Services) => s.db.one<{ n: number }>(`SELECT count(*) AS n FROM tal_tasks`)!.n;
const projectCount = (s: Services) => s.db.one<{ n: number }>(`SELECT count(*) AS n FROM tal_projects`)!.n;

async function proposeViaAgent(input: Record<string, unknown>): Promise<TaskPlanDraft> {
  return inAgent((a) => propose(a.services, input));
}

const url = (d: TaskPlanDraft, action = "") => `/api/conversations/${d.conversation_id}/task-plans/${d.id}${action}`;
const confirm = (c: Client, d: TaskPlanDraft, plan: TaskPlanContent = d.plan, revision = d.revision) =>
  c.call(url(d, "/confirm"), { method: "POST", body: { revision, plan } });

describe("plan validation", () => {
  it("accepts a valid multi-task proposal and stores a draft without creating tasks", async () => {
    const title = uniq("Japan trip");
    await inAgent(async (a) => {
      const s = a.services;
      const before = taskCount(s);
      const draft = await propose(s, {
        title,
        tasks: [
          { title: "Renew passport", priority: "high", due: "2026-12-01" },
          { title: "Book flights", priority: "high", due: "2026-11-15", due_is_suggestion: false },
          { title: "Get a rail pass" },
        ],
      });
      expect(draft).toMatchObject({ status: "pending", revision: 1, result: null, plan: { title, project: { mode: "none" } } });
      expect(draft.plan.tasks.map((t) => [t.client_id, t.title, t.priority, t.due, t.due_suggested])).toEqual([
        ["t1", "Renew passport", "high", "2026-12-01", true],
        ["t2", "Book flights", "high", "2026-11-15", false],
        ["t3", "Get a rail pass", "medium", null, false],
      ]);
      expect(taskCount(s)).toBe(before);
    });
  });

  it("rejects malformed proposals, invalid priorities, impossible dates and oversized plans", async () => {
    const task = (extra = {}) => ({ title: "Do it", ...extra });
    const bad = [
      {},
      { title: "x", tasks: "nope" },
      { title: "x", tasks: [task({ priority: "critical" }), task()] },
      { title: "x", tasks: [task({ due: "2026-02-30" }), task({ title: "b" })] },
      { title: "x", tasks: [task({ due: "next friday" }), task({ title: "b" })] },
      { title: "x", tasks: [task({ due: "2026-03-01T25:00" }), task({ title: "b" })] },
      { title: "x", tasks: Array.from({ length: 16 }, (_, i) => task({ title: `t${i}` })) },
      { title: "x", tasks: [task()] },
      { title: "x".repeat(201), tasks: [task(), task({ title: "b" })] },
    ];
    for (const input of bad) expect(proposedPlanInputSchema.safeParse(input).success, JSON.stringify(input).slice(0, 80)).toBe(false);
    await inAgent(async (a) => {
      const s = a.services;
      const before = s.db.one<{ n: number }>(`SELECT count(*) AS n FROM tal_task_plan_drafts`)!.n;
      for (const input of bad) await expect(executor(s).execute("propose_task_plan", input)).rejects.toThrow(/Invalid input/);
      expect(s.db.one<{ n: number }>(`SELECT count(*) AS n FROM tal_task_plan_drafts`)!.n).toBe(before);
    });
    // Leap days are real dates.
    expect(proposedPlanInputSchema.safeParse({ title: "x", tasks: [task({ due: "2028-02-29" }), task({ title: "b" })] }).success).toBe(true);
  });

  it("links an existing project by name and refuses a project that doesn't exist", async () => {
    const name = uniq("Launch");
    await inAgent(async (a) => {
      const s = a.services;
      const project = s.projects.create({ name });
      const draft = await propose(s, { title: "Launch", existing_project: name.toUpperCase(), tasks: [{ title: uniq("Write notes") }, { title: uniq("Ship") }] });
      expect(draft.plan.project).toEqual({ mode: "existing", id: project.id, name });
      await expect(
        executor(s).execute("propose_task_plan", { title: "x", existing_project: "No such project", tasks: [{ title: "a" }, { title: "b" }] }),
      ).rejects.toThrow(/does not exist/);
      // A "new" project that matches an existing one reuses it instead of duplicating it.
      const reuse = await propose(s, { title: "Again", new_project: name, tasks: [{ title: uniq("Plan") }, { title: uniq("Do") }] });
      expect(reuse.plan.project).toEqual({ mode: "existing", id: project.id, name });
    });
  });

  it("leaves out duplicate tasks within the plan and tasks that already exist", async () => {
    const existing = uniq("Pack boxes");
    await inAgent(async (a) => {
      const s = a.services;
      s.tasks.create({ title: existing });
      const ex = executor(s);
      const out = (await ex.execute("propose_task_plan", {
        title: "Move",
        tasks: [{ title: "Book movers" }, { title: "book  MOVERS" }, { title: existing }, { title: "Change address" }],
      }, "c")) as { left_out_as_duplicates: string[]; tasks: number };
      expect(out.tasks).toBe(2);
      expect(out.left_out_as_duplicates).toEqual(["book  MOVERS", existing]);
    });
  });

  it("is not available outside chat and only once per turn", async () => {
    await inAgent(async (a) => {
      const s = a.services;
      const scheduled = new ToolExecutor(ALL_TOOLS, { services: s, timezone: "UTC", mode: "scheduled" }, { maxToolCalls: 4 });
      expect(scheduled.find("propose_task_plan")).toBeUndefined();
      const ex = executor(s);
      await ex.execute("propose_task_plan", { title: "A", tasks: [{ title: uniq("a") }, { title: uniq("b") }] });
      await expect(ex.execute("propose_task_plan", { title: "B", tasks: [{ title: uniq("c") }, { title: uniq("d") }] })).rejects.toThrow(/already used/);
    });
  });
});

describe("rejected proposals", () => {
  it("a rejected proposal can be corrected in the same turn", async () => {
    await inAgent(async (a) => {
      const ex = executor(a.services);
      const tasks = [{ title: uniq("a") }, { title: uniq("b") }];
      await expect(ex.execute("propose_task_plan", { title: "A", existing_project: "No such project", tasks })).rejects.toThrow(/does not exist/);
      await ex.execute("propose_task_plan", { title: "A", tasks });
      await expect(ex.execute("propose_task_plan", { title: "B", tasks: [{ title: uniq("c") }, { title: uniq("d") }] })).rejects.toThrow(/already used/);
    });
  });
});

describe("confirmation workflow", () => {
  it("confirmation creates every task atomically, in a new project, and is idempotent", async () => {
    const projectName = uniq("App launch");
    const draft = await proposeViaAgent({
      title: "App launch",
      new_project: projectName,
      tasks: [
        { title: uniq("Finish features"), priority: "high" },
        { title: uniq("Test the app"), priority: "high", due: "2030-05-01T09:30" },
        { title: uniq("Announce"), description: "Blog + social" },
      ],
    });
    const c = await loggedIn();
    const before = await inAgent((a) => ({ tasks: taskCount(a.services), projects: projectCount(a.services) }));
    const res = await confirm(c, draft);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plan: TaskPlanDraft; replayed: boolean };
    expect(body.replayed).toBe(false);
    expect(body.plan.status).toBe("confirmed");
    expect(body.plan.result?.task_ids).toHaveLength(3);
    expect(body.plan.result?.project_created).toBe(true);

    // Repeating the confirmation returns the first result and creates nothing more.
    const again = (await (await confirm(c, draft)).json()) as { plan: TaskPlanDraft; replayed: boolean };
    expect(again.replayed).toBe(true);
    expect(again.plan.result).toEqual(body.plan.result);

    await inAgent((a) => {
      const s = a.services;
      expect(taskCount(s)).toBe(before.tasks + 3);
      expect(projectCount(s)).toBe(before.projects + 1);
      const projectId = body.plan.result!.project_id!;
      expect(s.projects.get(projectId)?.name).toBe(projectName);
      const tasks = s.tasks.list({ project_id: projectId });
      expect(tasks).toHaveLength(3);
      expect(tasks.every((t) => t.status === "todo")).toBe(true);
      // Local 09:30 UTC (the test owner's timezone).
      expect(tasks.find((t) => t.due_at)?.due_at).toBe("2030-05-01T09:30:00.000Z");
      expect(s.activity.list(5).some((e) => e.type === "task_plan.confirmed")).toBe(true);
    });
    // Visible through the ordinary Tasks API.
    const listed = await c.json<{ tasks: { id: string }[] }>(`/api/tasks?project_id=${body.plan.result!.project_id}`);
    expect(listed.tasks.map((t) => t.id).sort()).toEqual([...body.plan.result!.task_ids].sort());
    // A cancel after confirmation is refused.
    expect((await c.call(url(draft, "/cancel"), { method: "POST", body: {} })).status).toBe(409);
  });

  it("applies the owner's edits: renamed, re-prioritised, re-dated and removed tasks", async () => {
    const draft = await proposeViaAgent({
      title: "Move flat",
      tasks: [{ title: uniq("Book movers") }, { title: uniq("Pack"), due: "2030-01-10" }, { title: uniq("Clean") }],
    });
    const c = await loggedIn();
    const edited: TaskPlanContent = {
      ...draft.plan,
      title: "Moving day",
      tasks: [
        { ...draft.plan.tasks[0]!, title: "Book movers for Saturday", description: "Get 3 quotes", priority: "urgent", due: "2030-01-05" },
        { ...draft.plan.tasks[1]!, due: null },
      ],
    };
    // Saving edits bumps the revision; confirming the old revision is then refused.
    const saved = (await c.json<{ plan: TaskPlanDraft }>(url(draft), { method: "PATCH", body: { revision: 1, plan: edited } })).plan;
    expect(saved).toMatchObject({ revision: 2, status: "pending", plan: { title: "Moving day" } });
    expect(saved.plan.tasks).toHaveLength(2);
    const stale = await confirm(c, draft, edited, 1);
    expect(stale.status).toBe(409);

    const done = (await (await confirm(c, saved)).json()) as { plan: TaskPlanDraft };
    await inAgent((a) => {
      const tasks = done.plan.result!.task_ids.map((id) => a.services.tasks.get(id)!);
      expect(tasks.map((t) => [t.title, t.description, t.priority, t.due_at])).toEqual([
        ["Book movers for Saturday", "Get 3 quotes", "urgent", "2030-01-05T23:59:00.000Z"],
        [draft.plan.tasks[1]!.title, "", "medium", null],
      ]);
      expect(tasks.every((t) => t.project_id === null)).toBe(true);
    });
  });

  it("refuses invalid final payloads on the server", async () => {
    const draft = await proposeViaAgent({ title: "Edits", tasks: [{ title: uniq("One") }, { title: uniq("Two") }] });
    const c = await loggedIn();
    const t = draft.plan.tasks;
    const cases: [unknown, RegExp | null][] = [
      [{ ...draft.plan, tasks: [] }, null],
      [{ ...draft.plan, tasks: [{ ...t[0]!, priority: "critical" }] }, null],
      [{ ...draft.plan, tasks: [{ ...t[0]!, due: "2030-02-31" }] }, null],
      [{ ...draft.plan, tasks: [{ ...t[0]!, client_id: "injected" }] }, /not added/],
      [{ ...draft.plan, tasks: [t[0]!, { ...t[1]!, title: t[0]!.title }] }, /twice/],
      [{ ...draft.plan, project: { mode: "existing", id: "00000000-0000-0000-0000-000000000000" } }, /no longer exists/],
    ];
    for (const [plan, message] of cases) {
      const res = await confirm(c, draft, plan as TaskPlanContent);
      expect(res.status).toBe(400);
      if (message) expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(message);
    }
    // Still pending and untouched after the rejected attempts.
    expect((await c.json<{ plan: TaskPlanDraft }>(url(draft))).plan).toMatchObject({ status: "pending", revision: 1 });
  });

  it("cancellation creates nothing and blocks a later confirmation", async () => {
    const draft = await proposeViaAgent({ title: "Cancel me", tasks: [{ title: uniq("A") }, { title: uniq("B") }] });
    const c = await loggedIn();
    const before = await inAgent((a) => taskCount(a.services));
    expect((await c.json<{ plan: TaskPlanDraft }>(url(draft, "/cancel"), { method: "POST", body: {} })).plan.status).toBe("cancelled");
    expect((await confirm(c, draft)).status).toBe(409);
    expect(await inAgent((a) => taskCount(a.services))).toBe(before);
  });

  it("an expired draft can't be confirmed or edited", async () => {
    const draft = await proposeViaAgent({ title: "Old", tasks: [{ title: uniq("A") }, { title: uniq("B") }] });
    await inAgent((a) => a.services.db.run(`UPDATE tal_task_plan_drafts SET expires_at = ? WHERE id = ?`, new Date(Date.now() - 1000).toISOString(), draft.id));
    const c = await loggedIn();
    expect((await c.json<{ plan: TaskPlanDraft }>(url(draft))).plan.status).toBe("expired");
    const res = await confirm(c, draft);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/expired/);
    expect((await c.call(url(draft), { method: "PATCH", body: { revision: 1, plan: draft.plan } })).status).toBe(409);
  });

  it("concurrent confirmations create the tasks exactly once", async () => {
    const draft = await proposeViaAgent({ title: "Race", tasks: [{ title: uniq("A") }, { title: uniq("B") }, { title: uniq("C") }] });
    const c = await loggedIn();
    const before = await inAgent((a) => taskCount(a.services));
    const results = await Promise.all(Array.from({ length: 5 }, () => confirm(c, draft).then(async (r) => ({ status: r.status, body: (await r.json()) as { plan: TaskPlanDraft; replayed: boolean } }))));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => !r.body.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => JSON.stringify(r.body.plan.result))).size).toBe(1);
    expect(await inAgent((a) => taskCount(a.services))).toBe(before + 3);
  });

  it("a failure mid-confirmation rolls back every task and project", async () => {
    await inAgent(async (a) => {
      const s = a.services;
      const draft = await propose(s, { title: "Fragile", new_project: uniq("Fragile project"), tasks: [{ title: uniq("A") }, { title: uniq("B") }, { title: uniq("C") }] });
      const before = { tasks: taskCount(s), projects: projectCount(s) };
      const original = s.tasks.create.bind(s.tasks);
      let calls = 0;
      const spy = vi.spyOn(s.tasks, "create").mockImplementation((input) => {
        if (++calls === 3) throw new Error("disk full");
        return original(input);
      });
      try {
        expect(() => s.taskPlans.confirm(draft.conversation_id, draft.id, 1, draft.plan, "UTC")).toThrow("disk full");
      } finally {
        spy.mockRestore();
      }
      expect({ tasks: taskCount(s), projects: projectCount(s) }).toEqual(before);
      // The claim was rolled back too, so the owner can try again.
      expect(s.taskPlans.get(draft.id)).toMatchObject({ status: "pending", result: null });
      expect(s.taskPlans.confirm(draft.conversation_id, draft.id, 1, draft.plan, "UTC").draft.result?.task_ids).toHaveLength(3);
    });
  });

  it("drafts are bound to their conversation and need a session", async () => {
    const draft = await proposeViaAgent({ title: "Bound", tasks: [{ title: uniq("A") }, { title: uniq("B") }] });
    const c = await loggedIn();
    const other = await inAgent((a) => a.services.conversations.create().id);
    expect((await c.call(`/api/conversations/${other}/task-plans/${draft.id}/confirm`, { method: "POST", body: { revision: 1, plan: draft.plan } })).status).toBe(404);
    const anonymous = await (await import("./helpers")).client().call(url(draft, "/confirm"), { method: "POST", body: { revision: 1, plan: draft.plan } });
    expect(anonymous.status).toBe(401);
    expect((await c.json<{ plan: TaskPlanDraft }>(url(draft))).plan.status).toBe("pending");
    // Remote access tokens can't reach plan routes at all.
    for (const [method, action] of [["GET", ""], ["PATCH", ""], ["POST", "/confirm"], ["POST", "/cancel"]] as const) {
      expect(isRemoteAllowed(method, url(draft, action))).toBe(false);
    }
  });
});

/** Calls propose_task_plan, then stops the turn as the owner would with the Stop button. */
class AbortAfterPlanProvider implements AIProvider {
  readonly id = "scripted";
  readonly model = "mock";
  readonly billable = false;
  constructor(private readonly controller: AbortController, private readonly title: string) {}
  async generate(_req: GenerateRequest): Promise<never> {
    throw new Error("unused");
  }
  async *stream(): AsyncIterable<AgentEvent> {}
  async *generateWithTools(req: ToolRequest): AsyncIterable<AgentEvent> {
    const input = { title: this.title, tasks: [{ title: uniq("x") }, { title: uniq("y") }] };
    yield { type: "tool-start", id: "p1", name: "propose_task_plan", input };
    const output = await req.tools.find((t) => t.name === "propose_task_plan")!.execute(input, "p1");
    yield { type: "tool-end", id: "p1", name: "propose_task_plan", output };
    yield { type: "text", delta: "Here is a plan" };
    this.controller.abort();
  }
}

describe("chat integration", () => {
  it("a plan proposed in chat renders on the message, survives reload and reports its outcome to the model", async () => {
    const c = await loggedIn();
    const title = uniq("Japan trip");
    const before = await inAgent((a) => taskCount(a.services));
    const events = await readSse(await c.call("/api/chat", { method: "POST", body: { message: `plan ${title}: renew passport!; book flights!; buy rail pass` } }));
    const done = events.at(-1);
    expect(done.type).toBe("done");
    const tool = done.message.tools.find((t: { name: string }) => t.name === "propose_task_plan");
    expect(tool.plan).toMatchObject({ status: "pending", plan: { title, tasks: [{ priority: "high" }, { priority: "high" }, { priority: "medium" }] } });
    expect(done.message.content).toMatch(/proposed a plan/);
    expect(done.message.content).not.toMatch(/created/i);
    const convId = done.message.conversation_id;
    const draft = tool.plan as TaskPlanDraft;
    expect(await inAgent((a) => taskCount(a.services))).toBe(before);

    // Reload: the card comes back from the server with its current state.
    const reloaded = await c.json(`/api/conversations/${convId}`);
    const card = reloaded.messages.flatMap((m: { tools: { plan?: TaskPlanDraft }[] }) => m.tools).find((t: { plan?: TaskPlanDraft }) => t.plan);
    expect(card.plan.id).toBe(draft.id);
    expect(card.plan.status).toBe("pending");

    await confirm(c, draft);
    const after = await c.json(`/api/conversations/${convId}`);
    const confirmed = after.messages.flatMap((m: { tools: { plan?: TaskPlanDraft }[] }) => m.tools).find((t: { plan?: TaskPlanDraft }) => t.plan);
    expect(confirmed.plan).toMatchObject({ status: "confirmed", result: { task_ids: expect.any(Array) } });

    // The next turn's history tells the model the plan was confirmed.
    let seenHistory = "";
    await inAgent(async (a) => {
      const provider: AIProvider = {
        id: "spy", model: "mock", billable: false,
        generate: async () => { throw new Error("unused"); },
        async *stream() {},
        async *generateWithTools(req) {
          seenHistory = req.messages.map((m) => m.content).join("\n");
          yield { type: "text", delta: "ok" };
        },
      };
      for await (const _ of new AgentRunner(a.services, provider).chat({ conversationId: convId, message: "thanks", signal: new AbortController().signal })) { /* drain */ }
    });
    expect(seenHistory).toMatch(/confirmed by the owner; 3 task\(s\) were created/);
  });

  it("plan cards keep their outcome after the draft is pruned", async () => {
    const c = await loggedIn();
    const proposeInChat = async () => {
      const events = await readSse(await c.call("/api/chat", { method: "POST", body: { message: `plan ${uniq("Pruned")}: ${uniq("a")}; ${uniq("b")}` } }));
      return events.at(-1).message.tools.find((t: { plan?: TaskPlanDraft }) => t.plan).plan as TaskPlanDraft;
    };
    const cardOf = async (d: TaskPlanDraft) => {
      const conv = await c.json(`/api/conversations/${d.conversation_id}`);
      return conv.messages.flatMap((m: { tools: { plan?: TaskPlanDraft }[] }) => m.tools).find((t: { plan?: TaskPlanDraft }) => t.plan?.id === d.id).plan as TaskPlanDraft;
    };
    const prune = (d: TaskPlanDraft) => inAgent((a) => a.services.db.run(`DELETE FROM tal_task_plan_drafts WHERE id = ?`, d.id));

    const confirmed = await proposeInChat();
    await confirm(c, confirmed);
    await prune(confirmed);
    expect(await cardOf(confirmed)).toMatchObject({ status: "confirmed", result: { task_ids: expect.any(Array) } });

    const cancelled = await proposeInChat();
    await c.call(url(cancelled, "/cancel"), { method: "POST" });
    await prune(cancelled);
    expect((await cardOf(cancelled)).status).toBe("cancelled");

    // A draft pruned while still pending was never confirmed.
    const abandoned = await proposeInChat();
    await prune(abandoned);
    expect((await cardOf(abandoned)).status).toBe("expired");
  });

  it("ordinary chat and single-task creation still work", async () => {
    const c = await loggedIn();
    const title = uniq("single task");
    const events = await readSse(await c.call("/api/chat", { method: "POST", body: { message: `add task ${title}` } }));
    expect(events.at(-1).message.tools.map((t: { name: string }) => t.name)).toEqual(["create_task"]);
    expect(await inAgent((a) => a.services.tasks.resolve(title)?.title)).toBe(title);
    const chat = await readSse(await c.call("/api/chat", { method: "POST", body: { message: "hello there" } }));
    expect(chat.at(-1).message).toMatchObject({ status: "complete", tools: [] });
  });

  it("a stopped turn withdraws its plan and creates nothing", async () => {
    const controller = new AbortController();
    const title = uniq("Stopped plan");
    const { done, before, after } = await inAgent(async (a) => {
      const s = a.services;
      const before = taskCount(s);
      const events = [];
      for await (const e of new AgentRunner(s, new AbortAfterPlanProvider(controller, title)).chat({ message: "plan my move", signal: controller.signal })) events.push(e);
      return { done: events.at(-1) as any, before, after: taskCount(s) };
    });
    expect(done.message.status).toBe("cancelled");
    expect(done.message.tools[0].plan).toMatchObject({ status: "cancelled" });
    expect(after).toBe(before);
    const c = await loggedIn();
    expect((await confirm(c, done.message.tools[0].plan)).status).toBe(409);
  });
});

describe("persistence", () => {
  it("the migration upgrades an existing database without touching its tasks", async () => {
    await inAgent((a) => {
      const db = a.services.db;
      const task = a.services.tasks.create({ title: uniq("pre-existing") });
      // Re-running every migration is a no-op on an up-to-date database.
      expect(migrate(db)).toBe(MIGRATIONS.at(-1)!.version);
      expect(MIGRATIONS.at(-1)).toMatchObject({ version: 11, name: "task plan drafts" });
      expect(a.services.tasks.get(task.id)?.title).toBe(task.title);
      expect(db.one(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tal_task_plan_drafts'`)).not.toBeNull();
    });
  });

  it("backups keep their format: drafts aren't exported and imported plan cards are dropped", async () => {
    await inAgent(async (a) => {
      const s = a.services;
      await propose(s, { title: "Backup", tasks: [{ title: uniq("A") }, { title: uniq("B") }] });
      const backup = exportData(s);
      expect(Object.keys(backup.data).sort()).toEqual(["automations", "conversations", "memories", "messages", "notes", "projects", "settings", "tasks"]);
      expect(JSON.stringify(backup.data)).not.toContain("tal_task_plan_drafts");
    });
    const c = await loggedIn();
    const conv = crypto.randomUUID();
    const plan = {
      id: crypto.randomUUID(), conversation_id: conv, revision: 1, status: "pending", expires_at: new Date(Date.now() + 1e6).toISOString(), confirmed_at: null, result: null,
      plan: taskPlanContentSchema.parse({ title: "Imported", tasks: [{ client_id: "t1", title: "x", priority: "low" }] }),
    };
    const msg = crypto.randomUUID();
    await c.json("/api/import", {
      method: "POST",
      body: {
        format: "talorys-backup", version: 1, exported_at: new Date().toISOString(),
        data: {
          conversations: [{ id: conv, title: "Imported", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }],
          messages: [{ id: msg, conversation_id: conv, role: "assistant", content: "plan", created_at: "2026-01-01T00:00:01Z", tools: [{ id: "1", name: "propose_task_plan", label: "Proposing", status: "success", plan }] }],
        },
      },
    });
    const stored = await inAgent((a) => a.services.conversations.messages(conv));
    expect(stored[0]!.tools[0]).toEqual({ id: "1", name: "propose_task_plan", label: "Proposing", status: "success" });
  });
});
