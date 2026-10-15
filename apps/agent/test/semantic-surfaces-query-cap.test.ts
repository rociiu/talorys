import { describe, expect, it } from "vitest";
import { inAgent } from "./helpers";
import { FixtureEmbedder, fixtureConfig } from "./fixture-embedder";
import { invalidateSemanticCache } from "../src/semantic";
import { deleteSemanticConfig } from "../src/semantic/config";
import { embeddingsToday } from "../src/semantic/embeddings";
import { dropSemanticData, ensureSemanticSchema } from "../src/semantic/migrations";
import { type SemanticContext, peekQueryVector } from "../src/semantic/recall";
import { ITEM_EMBEDDINGS_PER_DAY, itemUsageToday, runItemPass } from "../src/semantic/itemIndex";
import { semanticTools } from "../src/semantic/tools";
import { ALL_TOOLS, type ToolContext, type ToolDefinition } from "../src/tools";
import type { ImmediateTool } from "../src/tools/registry";
import { UsageService } from "../src/services/usage";
import type { Services } from "../src/services/container";
import type { TalorysAgent } from "../src/agent/talorys-agent";

function reset(s: Services) {
  dropSemanticData(s.db);
  deleteSemanticConfig(s.settings);
  invalidateSemanticCache(s);
  s.memories.clear();
  for (const table of ["tal_tasks", "tal_notes", "tal_automations"]) s.db.run(`DELETE FROM ${table}`);
}

/** A fresh turn: seeded items are indexed first, so only query embeddings move the counters below. */
async function turn(a: TalorysAgent) {
  const s = a.services;
  reset(s);
  ensureSemanticSchema(s.db);
  s.notes.create({ title: "Front door", content: "The door code is 4721" });
  s.notes.create({ title: "Dad's birthday", content: "Dad turns 70 in March" });
  s.tasks.create({ title: "Water the plants" });
  s.tasks.create({ title: "Call dad" });
  const embedder = new FixtureEmbedder();
  const sem: SemanticContext = { db: s.db, services: s, embedder, config: fixtureConfig(), queryVectors: new Map() };
  await runItemPass(sem, { maxEmbed: 500 });
  embedder.calls.length = 0;
  const toolCtx: ToolContext = { services: s, timezone: "UTC", mode: "chat" };
  const tools = semanticTools(sem);
  const run = (name: string, input: unknown, from: ToolDefinition[] = tools) =>
    (from.find((t) => t.name === name) as ImmediateTool).execute(input, toolCtx);
  const day = UsageService.day();
  const counters = () => ({ memory: embeddingsToday(s.db, day), item: itemUsageToday(s.db, day).requests });
  return { s, sem, embedder, run, counters, day };
}

describe("item-tool query embeddings", () => {
  it("FU2-a: a note search in a fresh turn is charged to the item cap only", async () => {
    await inAgent(async (a) => {
      const { sem, embedder, run, counters } = await turn(a);
      const before = counters();
      await run("search_notes", { query: "door code?" });
      expect(counters()).toEqual({ memory: before.memory, item: before.item + 1 });
      expect(embedder.calls).toEqual([["door code?"]]);
      expect(peekQueryVector(sem, "Door code?")).not.toBeNull();
      reset(a.services);
    });
  });

  it("FU2-b: a query memory recall already embedded is reused by a note search for free", async () => {
    await inAgent(async (a) => {
      const { embedder, run, counters } = await turn(a);
      const before = counters();
      await run("search_memories", { query: "dad" });
      await run("search_notes", { query: "dad" });
      expect(embedder.calls).toEqual([["dad"]]);
      expect(counters()).toEqual({ memory: before.memory + 1, item: before.item });
      reset(a.services);
    });
  });

  it("FU2-c: with the item cap spent, list_tasks falls back to keywords and leaves the memory cap alone", async () => {
    await inAgent(async (a) => {
      const { s, sem, embedder, run, counters, day } = await turn(a);
      s.db.run(
        `INSERT INTO tal_semantic_item_usage (day, requests, tokens) VALUES (?, ?, 0)
         ON CONFLICT(day) DO UPDATE SET requests = excluded.requests`,
        day,
        ITEM_EMBEDDINGS_PER_DAY,
      );
      const before = counters();
      const keyword = await run("list_tasks", { query: "dad" }, ALL_TOOLS);
      expect(await run("list_tasks", { query: "dad" })).toEqual(keyword);
      expect(counters()).toEqual(before);
      expect(embedder.calls).toEqual([]);
      expect(peekQueryVector(sem, "dad")).toBeNull();
      reset(s);
    });
  });
});
