import { describe, expect, it } from "vitest";
import { inAgent } from "./helpers";
import { FixtureEmbedder, fixtureConfig } from "./fixture-embedder";
import { invalidateSemanticCache } from "../src/semantic";
import { deleteSemanticConfig } from "../src/semantic/config";
import { dropSemanticData } from "../src/semantic/migrations";
import { type SemanticContext, selectSemanticMemories } from "../src/semantic/recall";
import { runItemPass } from "../src/semantic/itemIndex";
import { semanticTools } from "../src/semantic/tools";
import { ALL_TOOLS, type ToolContext, type ToolDefinition } from "../src/tools";
import type { ImmediateTool } from "../src/tools/registry";
import { searchTools } from "../src/tools/search";
import { presentTask } from "../src/tools/tasks";
import type { Services } from "../src/services/container";
import type { TalorysAgent } from "../src/agent/talorys-agent";

type Entry = { id: string; title?: string; name?: string; enabled?: boolean; match?: string };
type SearchResult = { tasks: Entry[]; notes: Entry[]; memories: unknown[]; conversations: unknown[]; automations?: Entry[] };

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
  // Everything seeded is indexed first: a search embeds only a few pending parts itself.
  const run = async <T = SearchResult>(name: string, input: unknown, from: ToolDefinition[] = tools) => {
    await runItemPass(sem, { maxEmbed: 500 });
    return (from.find((t) => t.name === name) as ImmediateTool).execute(input, toolCtx) as Promise<T>;
  };
  return { s, sem, run };
}

function setup(a: TalorysAgent) {
  reset(a.services);
  return context(a);
}

const reminder = (s: Services, name: string) =>
  s.automationsRepo.create({ name, kind: "reminder", message: name, schedule: { type: "daily", time: "08:00" }, enabled: true });

/** Tasks, notes and reminders of the surface fixture, with "rent" as a keyword hit on every surface. */
function seed(s: Services) {
  const water = s.tasks.create({ title: "Water the plants" });
  const rentTask = s.tasks.create({ title: "Pay rent" });
  for (const title of ["Renew Tesla registration", "Call the dentist", "Buy milk and eggs"]) s.tasks.create({ title });
  s.notes.create({ title: "Lisbon itinerary", content: "Day 1: Alfama walk, Day 2: Belem and Sintra" });
  s.notes.create({ title: "Lease", content: "Rent is due on the 1st" });
  const lipitor = reminder(s, "Take Lipitor");
  const bins = reminder(s, "Put the bins out");
  const rent = reminder(s, "Pay rent");
  reminder(s, "Time to stretch");
  return { water, rentTask, lipitor, bins, rent };
}

const names = (entries: Entry[] | undefined) => (entries ?? []).map((e) => [e.name ?? e.title, e.match]);

describe("semantic search tool", () => {
  it("ST-botany-search: search adds a task found by meaning", async () => {
    await inAgent(async (a) => {
      const { s, run } = setup(a);
      const { water } = seed(s);

      const result = await run("search", { query: "tasks about botany" });
      expect(result.tasks).toContainEqual({ ...presentTask(s.tasks.get(water.id)!, "UTC"), match: "meaning" });
      expect((await run("search", { query: "tasks about botany" }, ALL_TOOLS)).tasks).toEqual([]);
    });
  });

  it("SA-med: search finds the Lipitor reminder for a medication reminder", async () => {
    await inAgent(async (a) => {
      const { s, run } = setup(a);
      const { lipitor } = seed(s);

      const result = await run("search", { query: "medication reminder" });
      expect(result.automations).toContainEqual({ id: lipitor.id, name: "Take Lipitor", kind: "reminder", schedule: lipitor.schedule_description, enabled: true, match: "meaning" });
    });
  });

  it("SA-garbage: search finds the bins reminder for garbage day", async () => {
    await inAgent(async (a) => {
      const { s, run } = setup(a);
      seed(s);

      const result = await run("search", { query: "garbage day" });
      expect(names(result.automations)).toContainEqual(["Put the bins out", "meaning"]);
    });
  });

  it("AK-on: with the feature on, search returns an automations key", async () => {
    await inAgent(async (a) => {
      const { s, run } = setup(a);
      seed(s);

      const result = await run("search", { query: "medication reminder" });
      expect(Object.keys(result)).toEqual(["tasks", "notes", "memories", "conversations", "automations"]);
      expect(names(result.automations)).toEqual([["Take Lipitor", "meaning"]]);
    });
  });

  it("AK-off: upstream search keeps its four keys and output", async () => {
    await inAgent(async (a) => {
      const { s, run } = setup(a);
      seed(s);

      for (const query of ["medication reminder", "rent", "tasks about botany"]) {
        const result = await run("search", { query }, ALL_TOOLS);
        expect(Object.keys(result)).toEqual(["tasks", "notes", "memories", "conversations"]);
        expect(result).toEqual(await run("search", { query }, searchTools));
      }
    });
  });

  it("AK-kw: with no embedder the automations key holds keyword hits only", async () => {
    await inAgent(async (a) => {
      reset(a.services);
      const { s, run } = context(a, null);
      const { rent } = seed(s);

      const result = await run("search", { query: "rent" });
      expect(result.automations).toEqual([{ id: rent.id, name: "Pay rent", kind: "reminder", schedule: rent.schedule_description, enabled: true }]);
      const upstream = await run("search", { query: "rent" }, ALL_TOOLS);
      expect(result.tasks).toEqual(upstream.tasks);
      expect(result.notes).toEqual(upstream.notes);
    });
  });

  it("SR-kw-auto: keyword tasks and notes come first, in upstream order", async () => {
    await inAgent(async (a) => {
      const { s, run } = setup(a);
      seed(s);

      const upstream = await run("search", { query: "rent" }, ALL_TOOLS);
      expect(upstream.tasks.length).toBeGreaterThan(0);
      expect(upstream.notes.length).toBeGreaterThan(0);
      const result = await run("search", { query: "rent" });
      expect(result.tasks.slice(0, upstream.tasks.length)).toEqual(upstream.tasks);
      expect(result.notes.slice(0, upstream.notes.length)).toEqual(upstream.notes);
      expect(names(result.automations)[0]).toEqual(["Pay rent", undefined]);
    });
  });

  it("SR-list-auto: list_automations is the same with the feature on and off", async () => {
    await inAgent(async (a) => {
      const { s, run } = setup(a);
      seed(s);

      expect(await run("list_automations", {})).toEqual(await run("list_automations", {}, ALL_TOOLS));
    });
  });

  it("NEG-fired: a fired one-shot is left out, a paused copy stays", async () => {
    await inAgent(async (a) => {
      const { s, run } = setup(a);
      const fired = reminder(s, "Put the bins out");
      s.automationsRepo.update(fired.id, { status: "completed", enabled: false, next_run: null, schedule_id: null });
      const paused = reminder(s, "Put the bins out");
      s.automationsRepo.update(paused.id, { status: "paused", enabled: false, next_run: null, schedule_id: null });

      const result = await run("search", { query: "garbage day" });
      const ids = (result.automations ?? []).map((e) => e.id);
      expect(ids).not.toContain(fired.id);
      expect(result.automations).toContainEqual(expect.objectContaining({ id: paused.id, enabled: false, match: "meaning" }));
    });
  });

  it("NEG-done-search: search adds no done task", async () => {
    await inAgent(async (a) => {
      const { s, run } = setup(a);
      seed(s);
      const physical = s.tasks.create({ title: "Book a physical" });
      s.tasks.complete(physical.id);

      const result = await run("search", { query: "doc appt soon?" });
      expect(result.tasks.filter((t) => t.match === "meaning").map((t) => t.id)).not.toContain(physical.id);
    });
  });

  it("Q-once: recall and three tools share one query embedding", async () => {
    await inAgent(async (a) => {
      const { s, sem, run } = setup(a);
      seed(s);
      await runItemPass(sem);
      const embedder = sem.embedder as FixtureEmbedder;
      embedder.calls.length = 0;

      await selectSemanticMemories(sem, "doc appt soon?");
      await run("search", { query: "doc appt soon?" });
      await run("list_tasks", { query: "doc appt soon?" });
      await run("search_notes", { query: "doc appt soon?" });
      expect(embedder.calls).toEqual([["doc appt soon?"]]);
    });
  });

  it("Q-distinct: each distinct query is embedded once per turn", async () => {
    await inAgent(async (a) => {
      const { s, sem, run } = setup(a);
      seed(s);
      await runItemPass(sem);
      const embedder = sem.embedder as FixtureEmbedder;
      embedder.calls.length = 0;

      await selectSemanticMemories(sem, "hello");
      const afterMessage = embedder.calls.length;
      await run("search", { query: "botany" });
      await run("list_tasks", { query: "vacation" });
      expect(embedder.calls.slice(afterMessage)).toEqual([["botany"], ["vacation"]]);

      await run("search", { query: "botany" });
      await run("list_tasks", { query: "vacation" });
      expect(embedder.calls.length).toBe(afterMessage + 2);
    });
  });

  it("Q-fail: a failed query embedding is tried once per cap and tools fall back to keywords", async () => {
    await inAgent(async (a) => {
      const { s, sem, run } = setup(a);
      seed(s);
      await runItemPass(sem);
      const embedder = sem.embedder as FixtureEmbedder;
      embedder.calls.length = 0;
      // The memory cap and the item cap each try the query once; both attempts fail.
      embedder.failNext = 2;

      const search = await run("search", { query: "medication reminder" });
      const tasks = await run("list_tasks", { query: "medication reminder" });
      const notes = await run("search_notes", { query: "medication reminder" });
      // Repeat item-cap calls reuse the failed item-cap entry instead of embedding again.
      expect(await run("list_tasks", { query: "medication reminder" })).toEqual(tasks);
      expect(await run("search_notes", { query: "medication reminder" })).toEqual(notes);
      // A repeat search finds both caps' failures kept and embeds under neither.
      expect(await run("search", { query: "medication reminder" })).toEqual(search);
      expect(embedder.calls).toEqual([["medication reminder"], ["medication reminder"]]);

      const upstream = await run("search", { query: "medication reminder" }, ALL_TOOLS);
      expect(search.tasks).toEqual(upstream.tasks);
      expect(search.notes).toEqual(upstream.notes);
      expect(search.automations).toEqual([]);
      expect(tasks).toEqual(await run("list_tasks", { query: "medication reminder" }, ALL_TOOLS));
      expect(notes).toEqual(await run("search_notes", { query: "medication reminder" }, ALL_TOOLS));
    });
  });
});
