import { describe, expect, it, vi } from "vitest";
import { inAgent } from "./helpers";
import { FixtureEmbedder, fixtureConfig } from "./fixture-embedder";
import { invalidateSemanticCache, semanticItemSelector, semanticMemorySelector } from "../src/semantic";
import { deleteSemanticConfig, type SemanticConfig } from "../src/semantic/config";
import { embeddingsToday } from "../src/semantic/embeddings";
import { itemUsageToday, runItemPass } from "../src/semantic/itemIndex";
import { ITEM_SECTION_HEADING } from "../src/semantic/itemRecall";
import { dropSemanticData, ensureSemanticSchema } from "../src/semantic/migrations";
import type { SemanticContext } from "../src/semantic/recall";
import { UsageService } from "../src/services/usage";
import type { Services } from "../src/services/container";
import type { TalorysAgent } from "../src/agent/talorys-agent";

const QUESTION = "any tasks about botany?";

function reset(s: Services) {
  dropSemanticData(s.db);
  deleteSemanticConfig(s.settings);
  invalidateSemanticCache(s);
  s.memories.clear();
  for (const table of ["tal_tasks", "tal_notes", "tal_automations"]) s.db.run(`DELETE FROM ${table}`);
}

/**
 * Seeds and indexes the botany items under the fixture defaults, then clears today's usage and
 * returns a fresh turn context with the given caps and a spy on its embedder.
 */
async function setup(a: TalorysAgent, caps: Pick<SemanticConfig, "maxEmbeddingsPerDay" | "maxItemEmbeddingsPerDay">) {
  const s = a.services;
  reset(s);
  ensureSemanticSchema(s.db);
  const water = s.tasks.create({ title: "Water the plants" });
  s.notes.create({ title: "Orchid care", content: "Bright shade, soak weekly" });
  s.tasks.create({ title: "Buy milk and eggs" });
  const indexing: SemanticContext = { db: s.db, services: s, embedder: new FixtureEmbedder(), config: fixtureConfig(), queryVectors: new Map() };
  await runItemPass(indexing, { maxEmbed: 500 });
  s.db.run(`DELETE FROM tal_semantic_item_usage`);
  s.db.run(`DELETE FROM tal_semantic_usage`);
  const embedder = new FixtureEmbedder();
  const embed = vi.spyOn(embedder, "embed");
  const ctx: SemanticContext = { db: s.db, services: s, embedder, config: { ...fixtureConfig(), ...caps }, queryVectors: new Map() };
  return { s, ctx, embed, water };
}

const itemRequests = (s: Services) => itemUsageToday(s.db, UsageService.day()).requests;

describe("the items section embeds under its own cap", () => {
  it("IC1 (a): memory cap 0 with item cap 5 still gives the items section, charged to the item cap", async () => {
    await inAgent(async (a) => {
      const { s, ctx, water } = await setup(a, { maxEmbeddingsPerDay: 0, maxItemEmbeddingsPerDay: 5 });
      await semanticMemorySelector(ctx)(QUESTION);
      const before = itemRequests(s);
      const section = await semanticItemSelector(ctx)(QUESTION);
      expect(section).toBeDefined();
      expect(section!.startsWith(ITEM_SECTION_HEADING)).toBe(true);
      expect(section).toContain(`(id ${water.id})`);
      expect(itemRequests(s)).toBe(before + 1);
      expect(embeddingsToday(s.db, UsageService.day())).toBe(0);
      reset(s);
    });
  });

  it("IC1 (b): when memory recall already embedded the message, the items section embeds nothing more", async () => {
    await inAgent(async (a) => {
      const { s, ctx, embed } = await setup(a, { maxEmbeddingsPerDay: 500, maxItemEmbeddingsPerDay: 5 });
      await semanticMemorySelector(ctx)(QUESTION);
      const calls = embed.mock.calls.length;
      const before = itemRequests(s);
      const section = await semanticItemSelector(ctx)(QUESTION);
      expect(section).toBeDefined();
      expect(embed.mock.calls.length).toBe(calls);
      expect(itemRequests(s)).toBe(before);
      reset(s);
    });
  });

  it("IC1 (c): with both caps 0 there is no items section and no embed", async () => {
    await inAgent(async (a) => {
      const { s, ctx, embed } = await setup(a, { maxEmbeddingsPerDay: 0, maxItemEmbeddingsPerDay: 0 });
      await semanticMemorySelector(ctx)(QUESTION);
      expect(await semanticItemSelector(ctx)(QUESTION)).toBeUndefined();
      expect(embed).not.toHaveBeenCalled();
      reset(s);
    });
  });
});
