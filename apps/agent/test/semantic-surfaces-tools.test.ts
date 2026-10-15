import { describe, expect, it } from "vitest";
import { inAgent, loggedIn, proposeAction } from "./helpers";
import { FixtureEmbedder, fixtureConfig } from "./fixture-embedder";
import { invalidateSemanticCache } from "../src/semantic";
import { deleteSemanticConfig } from "../src/semantic/config";
import { dropSemanticData } from "../src/semantic/migrations";
import type { SemanticContext } from "../src/semantic/recall";
import { runItemPass } from "../src/semantic/itemIndex";
import { semanticTools } from "../src/semantic/tools";
import { ALL_TOOLS, type ToolContext, type ToolDefinition } from "../src/tools";
import type { ImmediateTool } from "../src/tools/registry";
import { presentTask } from "../src/tools/tasks";
import type { Services } from "../src/services/container";
import type { TalorysAgent } from "../src/agent/talorys-agent";

type TaskList = { count: number; tasks: { id: string; title: string; match?: string }[] };
type NoteResults = { results: { id: string; title: string; excerpt: string; match?: string }[] };

/** Clears items and semantic state; the agent's own config stays off, so routes start no pass. */
function reset(s: Services) {
  dropSemanticData(s.db);
  deleteSemanticConfig(s.settings);
  invalidateSemanticCache(s);
  for (const table of ["tal_tasks", "tal_notes", "tal_automations"]) s.db.run(`DELETE FROM ${table}`);
}

/** An enabled context over the agent's database, searched with the fixture embedder. */
function context(a: TalorysAgent, embedder: FixtureEmbedder | null = new FixtureEmbedder()) {
  const s = a.services;
  const sem: SemanticContext = { db: s.db, services: s, embedder, config: fixtureConfig(), queryVectors: new Map() };
  const toolCtx: ToolContext = { services: s, timezone: "UTC", mode: "chat" };
  const tools = semanticTools(sem);
  const run = <T>(name: string, input: unknown, from: ToolDefinition[] = tools) =>
    (from.find((t) => t.name === name) as ImmediateTool).execute(input, toolCtx) as Promise<T>;
  return { s, sem, run };
}

function setup(a: TalorysAgent) {
  reset(a.services);
  return context(a);
}

const reminder = (s: Services, name: string) =>
  s.automationsRepo.create({ name, kind: "reminder", message: name, schedule: { type: "daily", time: "08:00" }, enabled: true });

const rowsFor = (s: Services, id: string) =>
  s.db.one<{ n: number }>(`SELECT count(*) AS n FROM tal_semantic_item_vectors WHERE item_id = ?`, id)?.n ?? 0;

const seedTasks = (s: Services) => {
  const water = s.tasks.create({ title: "Water the plants" });
  for (const title of ["Renew Tesla registration", "Call the dentist", "Buy milk and eggs", "Clean the gutters"]) s.tasks.create({ title });
  return water;
};

const seedNotes = (s: Services) => {
  const lisbon = s.notes.create({ title: "Lisbon itinerary", content: "Day 1: Alfama walk, Day 2: Belem and Sintra" });
  const lake = s.notes.create({ title: "Lake house", content: "Wifi network Loon5G, password maple-4417" });
  s.notes.create({ title: "Reading list", content: "Piranesi, The Overstory" });
  s.notes.create({ title: "Weeknight recipes", content: "Chili, lentil soup, sheet-pan salmon" });
  return { lisbon, lake };
};

const daysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

/** A paragraph of about 1,100 characters that only `phrase` gives a fixture key. */
const paragraph = (phrase: string) => `${phrase}. ${"lorem ipsum dolor sit amet ".repeat(45)}`.slice(0, 1100).trim();

describe("semantic surface tools", () => {
  it("ST-botany: list_tasks adds a task found by meaning; upstream finds none", async () => {
    await inAgent(async (a) => {
      const { s, run } = setup(a);
      const water = seedTasks(s);

      for (const query of ["botany", "any tasks about botany?"]) {
        const result = await run<TaskList>("list_tasks", { query });
        const added = result.tasks.filter((t) => t.match === "meaning");
        expect(added.length).toBeLessThanOrEqual(3);
        expect(added).toEqual([{ ...presentTask(s.tasks.get(water.id)!, "UTC"), match: "meaning" }]);
        expect(result.count).toBe(result.tasks.length);
        expect(await run<TaskList>("list_tasks", { query }, ALL_TOOLS)).toEqual({ count: 0, tasks: [] });
      }

      // Feature on but no embedder: exactly upstream.
      const plain = context(a, null);
      expect(await plain.run("list_tasks", { query: "botany" })).toEqual(await run("list_tasks", { query: "botany" }, ALL_TOOLS));
    });
  });

  it("ST-view: a done task is not added to the open view", async () => {
    await inAgent(async (a) => {
      const { s, run } = setup(a);
      const water = seedTasks(s);
      s.tasks.complete(water.id);

      const result = await run<TaskList>("list_tasks", { view: "open", query: "botany" });
      expect(result.tasks.map((t) => t.id)).not.toContain(water.id);
      expect(result).toEqual({ count: 0, tasks: [] });
    });
  });

  it("NEG-done-list: a done task is added only in the completed view", async () => {
    await inAgent(async (a) => {
      const { s, run } = setup(a);
      seedTasks(s);
      const physical = s.tasks.create({ title: "Book a physical" });
      s.tasks.complete(physical.id);

      const open = await run<TaskList>("list_tasks", { query: "doc appt soon?" });
      expect(open.tasks.map((t) => t.id)).not.toContain(physical.id);

      const completed = await run<TaskList>("list_tasks", { view: "completed", query: "doc appt soon?" });
      expect(completed.tasks).toEqual([{ ...presentTask(s.tasks.get(physical.id)!, "UTC"), match: "meaning" }]);
      expect(completed.count).toBe(1);
    });
  });

  it("FU3-a: a task due next month is added in the upcoming view, not today", async () => {
    await inAgent(async (a) => {
      const { s, run } = setup(a);
      const cleaning = s.tasks.create({ title: "Teeth cleaning with Dr. Ruiz", due_at: daysFromNow(30) });

      expect(await run<TaskList>("list_tasks", { view: "today", query: "dentist?" })).toEqual({ count: 0, tasks: [] });
      const upcoming = await run<TaskList>("list_tasks", { view: "upcoming", query: "dentist?" });
      expect(upcoming).toEqual({ count: 1, tasks: [{ ...presentTask(s.tasks.get(cleaning.id)!, "UTC"), match: "meaning" }] });
    });
  });

  it("FU3-b: overdue adds no future task, completed only done ones, open no done one", async () => {
    await inAgent(async (a) => {
      const { s, run } = setup(a);
      const water = s.tasks.create({ title: "Water the plants", due_at: daysFromNow(3) });
      const fern = s.tasks.create({ title: "Repot the fern", due_at: daysFromNow(-3) });
      const ids = (r: TaskList) => r.tasks.map((t) => t.id);

      expect(ids(await run<TaskList>("list_tasks", { view: "overdue", query: "botany" }))).toEqual([fern.id]);
      s.tasks.complete(water.id);
      expect(ids(await run<TaskList>("list_tasks", { view: "completed", query: "botany" }))).toEqual([water.id]);
      expect(ids(await run<TaskList>("list_tasks", { view: "open", query: "botany" }))).toEqual([fern.id]);
    });
  });

  it("FU3-c: additions only fill the slots keyword hits leave under limit", async () => {
    await inAgent(async (a) => {
      const { s, sem, run } = setup(a);
      const hits = ["Botany101 reading", "Botany101 quiz"].map((title) => s.tasks.create({ title }).id);
      const water = s.tasks.create({ title: "Water the plants" });
      s.tasks.create({ title: "Repot the fern" });
      const embedder = sem.embedder as FixtureEmbedder;

      const full = await run<TaskList>("list_tasks", { query: "botany", limit: 2 });
      expect(full).toEqual(await run<TaskList>("list_tasks", { query: "botany", limit: 2 }, ALL_TOOLS));
      expect(full.tasks.map((t) => t.id)).toEqual(hits);
      expect(embedder.calls).toEqual([]);

      const one = await run<TaskList>("list_tasks", { query: "botany", limit: 3 });
      expect(one.tasks.map((t) => t.id)).toEqual([...hits, water.id]);
      expect(one.tasks[2]!.match).toBe("meaning");
      expect(one.count).toBe(3);

      expect((await run<TaskList>("list_tasks", { query: "botany" })).count).toBe(4);
    });
  });

  it("SN-vacation: search_notes adds the itinerary for vacation plans", async () => {
    await inAgent(async (a) => {
      const { s, run } = setup(a);
      const { lisbon } = seedNotes(s);

      expect(await run("search_notes", { query: "vacation plans" }, ALL_TOOLS)).toEqual({ results: [] });
      const result = await run<NoteResults>("search_notes", { query: "vacation plans" });
      expect(result.results).toEqual([{ id: lisbon.id, title: "Lisbon itinerary", excerpt: lisbon.content, match: "meaning" }]);
    });
  });

  it("SN-cottage: search_notes finds the lake house with its wifi password", async () => {
    await inAgent(async (a) => {
      const { s, run } = setup(a);
      const { lake } = seedNotes(s);

      const result = await run<NoteResults>("search_notes", { query: "get online at the cottage" });
      const hit = result.results.find((n) => n.id === lake.id);
      expect(hit).toMatchObject({ title: "Lake house", match: "meaning" });
      expect(hit!.excerpt).toContain("maple-4417");
    });
  });

  it("SN-chunk: a long note is returned once with its gate-code chunk as the excerpt", async () => {
    await inAgent(async (a) => {
      const { s, sem, run } = setup(a);
      seedNotes(s);
      const phrases = ["kitchen", "laundry", "heating", "garden", "parking", "the gate code 2290 opens the side entrance", "recycling", "alarm", "keys"];
      const content = phrases.map(paragraph).join("\n\n").padEnd(10_000, ".");
      expect(content.length).toBe(10_000);
      const manual = s.notes.create({ title: "House manual", content });
      // Short gate and code notes fill upstream's eight keyword results, so only meaning finds the manual.
      for (let i = 1; i <= 8; i++) s.notes.create({ title: `Gate code ${i}`, content: `Side gate ${i} code is ${1000 + i}` });
      const upstream = await run<NoteResults>("search_notes", { query: "code for the gate" }, ALL_TOOLS);
      expect(upstream.results.map((n) => n.id)).not.toContain(manual.id);
      // More parts are pending than a search embeds itself, so index them first.
      await runItemPass(sem);

      const result = await run<NoteResults>("search_notes", { query: "code for the gate" });
      const hits = result.results.filter((n) => n.id === manual.id);
      expect(hits).toHaveLength(1);
      expect(hits[0]!.match).toBe("meaning");
      expect(hits[0]!.excerpt).toContain("gate code 2290");
      expect(hits[0]!.excerpt.startsWith(paragraph(phrases[5]!).slice(0, 400))).toBe(true);
    });
  });

  it("SR-kw: keyword hits come first and stay identical to upstream", async () => {
    await inAgent(async (a) => {
      const { s, run } = setup(a);
      seedTasks(s);
      seedNotes(s);

      const tasks = await run<TaskList>("list_tasks", { query: "plants" });
      expect(tasks).toEqual(await run("list_tasks", { query: "plants" }, ALL_TOOLS));
      expect(tasks.tasks.map((t) => t.title)).toEqual(["Water the plants"]);
      expect(tasks.tasks[0]).not.toHaveProperty("match");

      const notes = await run<NoteResults>("search_notes", { query: "Lisbon" });
      expect(notes).toEqual(await run("search_notes", { query: "Lisbon" }, ALL_TOOLS));
      expect(notes.results.map((n) => n.title)).toEqual(["Lisbon itinerary"]);
      expect(notes.results[0]).not.toHaveProperty("match");
    });
  });

  it("EDIT-page: a task renamed on its page is found by its new title", async () => {
    const id = await inAgent(async (a) => {
      const { s, run } = setup(a);
      const water = seedTasks(s);
      expect((await run<TaskList>("list_tasks", { query: "botany" })).tasks.map((t) => t.id)).toEqual([water.id]);
      return water.id;
    });
    const c = await loggedIn();
    expect((await c.call(`/api/tasks/${id}`, { method: "PATCH", body: { title: "Repot the fern" } })).status).toBe(200);
    await inAgent(async (a) => {
      const { run } = context(a);
      const result = await run<TaskList>("list_tasks", { query: "botany" });
      expect(result.tasks.map((t) => [t.id, t.title, t.match])).toEqual([[id, "Repot the fern", "meaning"]]);
      reset(a.services);
    });
  });

  it("DEL-page: items deleted on their pages lose their vectors and are never returned", async () => {
    const ids = await inAgent(async (a) => {
      const { s, sem } = setup(a);
      const task = seedTasks(s);
      const { lisbon } = seedNotes(s);
      const bins = reminder(s, "Put the bins out");
      await runItemPass(sem);
      for (const id of [task.id, lisbon.id, bins.id]) expect(rowsFor(s, id)).toBeGreaterThan(0);
      return { task: task.id, note: lisbon.id, automation: bins.id };
    });
    const c = await loggedIn();
    for (const [path, id] of [["tasks", ids.task], ["notes", ids.note], ["automations", ids.automation]] as const) {
      expect((await c.call(`/api/${path}/${id}`, { method: "DELETE" })).status).toBeLessThan(300);
    }
    await inAgent(async (a) => {
      const { s, run } = context(a);
      expect((await run<TaskList>("list_tasks", { query: "botany" })).tasks).toEqual([]);
      expect((await run<NoteResults>("search_notes", { query: "vacation plans" })).results).toEqual([]);
      for (const id of Object.values(ids)) expect(rowsFor(s, id)).toBe(0);
      reset(s);
    });
  });

  it("DEL-action: approved delete_task and delete_note leave no vectors", async () => {
    const { ids, actions } = await inAgent(async (a) => {
      const { s, sem } = setup(a);
      const task = seedTasks(s);
      const { lisbon } = seedNotes(s);
      await runItemPass(sem);
      expect(rowsFor(s, task.id)).toBeGreaterThan(0);
      expect(rowsFor(s, lisbon.id)).toBeGreaterThan(0);
      const actions = [await proposeAction(s, "delete_task", { task: task.id }), await proposeAction(s, "delete_note", { id: lisbon.id })];
      return { ids: [task.id, lisbon.id], actions };
    });
    const c = await loggedIn();
    for (const id of actions) expect((await c.json(`/api/actions/${id}/approve`, { method: "POST", body: {} })).action.status).toBe("approved");
    await inAgent(async (a) => {
      const { s, run } = context(a);
      expect((await run<TaskList>("list_tasks", { query: "botany" })).tasks).toEqual([]);
      expect((await run<NoteResults>("search_notes", { query: "vacation plans" })).results).toEqual([]);
      for (const id of ids) expect(rowsFor(s, id)).toBe(0);
      reset(s);
    });
  });

  it("WR-bg: create_task returns the upstream result and indexes in the background", async () => {
    await inAgent(async (a) => {
      const { s, sem, run } = setup(a);
      const result = await run<{ created: { id: string } }>("create_task", { title: "Water the plants" });
      expect(result).toEqual({ created: presentTask(s.tasks.get(result.created.id)!, "UTC") });

      const report = await runItemPass(sem);
      expect(report.pending).toBe(0);
      expect(rowsFor(s, result.created.id)).toBe(1);
    });
  });
});
