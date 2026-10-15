import { describe, expect, it } from "vitest";
import { inAgent } from "./helpers";
import { FixtureEmbedder, fixtureConfig } from "./fixture-embedder";
import { invalidateSemanticCache, semanticMemorySelector } from "../src/semantic";
import { deleteSemanticConfig } from "../src/semantic/config";
import { dropSemanticData } from "../src/semantic/migrations";
import type { SemanticContext } from "../src/semantic/recall";
import { runItemPass } from "../src/semantic/itemIndex";
import { semanticTools } from "../src/semantic/tools";
import type { ToolContext } from "../src/tools";
import type { ImmediateTool } from "../src/tools/registry";
import type { Services } from "../src/services/container";
import type { TalorysAgent } from "../src/agent/talorys-agent";

type Entry = { id: string; title?: string; name?: string; match?: string };
type SearchResult = { tasks: Entry[]; notes: Entry[]; automations: Entry[] };

function reset(s: Services) {
  dropSemanticData(s.db);
  deleteSemanticConfig(s.settings);
  invalidateSemanticCache(s);
  s.memories.clear();
  for (const table of ["tal_tasks", "tal_notes", "tal_automations"]) s.db.run(`DELETE FROM ${table}`);
}

const reminder = (s: Services, name: string) =>
  s.automationsRepo.create({ name, kind: "reminder", message: name, schedule: { type: "daily", time: "08:00" }, enabled: true });

/** A fresh turn's context over the indexed items, with its memory hook and tools. */
function turn(s: Services, embedder: FixtureEmbedder) {
  const sem: SemanticContext = { db: s.db, services: s, embedder, config: fixtureConfig(), queryVectors: new Map() };
  const tools = semanticTools(sem);
  const toolCtx: ToolContext = { services: s, timezone: "UTC", mode: "chat" };
  const run = <T = SearchResult>(name: string, input: unknown) => (tools.find((t) => t.name === name) as ImmediateTool).execute(input, toolCtx) as Promise<T>;
  return { sem, recall: semanticMemorySelector(sem), run };
}

async function setup(a: TalorysAgent) {
  const s = a.services;
  reset(s);
  const embedder = new FixtureEmbedder();
  const bins = reminder(s, "Put the bins out");
  const orchid = s.notes.create({ title: "Orchid care", content: "Bright shade, soak weekly" });
  s.tasks.create({ title: "Buy milk and eggs" });
  await runItemPass(turn(s, embedder).sem, { maxEmbed: 500 });
  embedder.calls.length = 0;
  return { s, embedder, bins, orchid };
}

const names = (entries: Entry[]) => entries.map((e) => [e.name ?? e.title, e.match]);

describe("tool meaning additions scored with the turn message", () => {
  it("HUB-g: a shortened tool query finds the reminder the owner message asked about", async () => {
    await inAgent(async (a) => {
      const { s, embedder, bins } = await setup(a);

      // Without the owner message, the shortened query alone finds nothing by meaning.
      expect((await turn(s, embedder).run("search", { query: "trash" })).automations).toEqual([]);

      embedder.calls.length = 0;
      const { recall, run } = turn(s, embedder);
      await recall("do i have a reminder about trash");
      const result = await run("search", { query: "trash" });
      expect(result.automations).toContainEqual(expect.objectContaining({ id: bins.id, name: "Put the bins out", match: "meaning" }));
      expect(names(result.automations)).toEqual([["Put the bins out", "meaning"]]);
      // One embedding per distinct text: the message for recall, the tool query for the search.
      expect(embedder.calls).toEqual([["do i have a reminder about trash"], ["trash"]]);
    });
  });

  it("search_notes and list_tasks also score with the turn message", async () => {
    await inAgent(async (a) => {
      const { s, embedder, orchid } = await setup(a);
      const water = s.tasks.create({ title: "Water the plants" });
      await runItemPass(turn(s, embedder).sem, { maxEmbed: 500 });

      const { recall, run } = turn(s, embedder);
      await recall("any tasks about botany?");
      const notes = await run<{ results: Entry[] }>("search_notes", { query: "zzz" });
      expect(notes.results).toContainEqual(expect.objectContaining({ id: orchid.id, match: "meaning" }));
      const tasks = await run<{ tasks: Entry[] }>("list_tasks", { query: "zzz" });
      expect(tasks.tasks).toContainEqual(expect.objectContaining({ id: water.id, match: "meaning" }));
    });
  });

  it("a tool query equal to the message embeds once and a negative stays empty", async () => {
    await inAgent(async (a) => {
      const { s, embedder } = await setup(a);
      const { recall, run } = turn(s, embedder);
      await recall("weather tmrw");
      const result = await run("search", { query: "weather tmrw" });
      expect([...result.tasks, ...result.notes, ...result.automations]).toEqual([]);
      expect(embedder.calls).toEqual([["weather tmrw"]]);
    });
  });
});
