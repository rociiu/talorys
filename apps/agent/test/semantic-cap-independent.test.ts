import { describe, expect, it, vi } from "vitest";
import { inAgent } from "./helpers";
import { invalidateSemanticCache } from "../src/semantic";
import { deleteSemanticConfig, writeSemanticConfig, type SemanticConfigPatch } from "../src/semantic/config";
import { MockEmbedder, embeddingsToday } from "../src/semantic/embeddings";
import { runIndexer, type IndexerContext } from "../src/semantic/indexer";
import { itemUsageToday, runItemPass } from "../src/semantic/itemIndex";
import { dropSemanticData } from "../src/semantic/migrations";
import { queryVector, type SemanticContext } from "../src/semantic/recall";
import { UsageService } from "../src/services/usage";
import type { Services } from "../src/services/container";

function reset(s: Services) {
  dropSemanticData(s.db);
  deleteSemanticConfig(s.settings);
  invalidateSemanticCache(s);
  for (const table of ["tal_tasks", "tal_notes", "tal_automations", "tal_memories"]) s.db.run(`DELETE FROM ${table}`);
}

function context(s: Services, patch: SemanticConfigPatch): { ctx: SemanticContext; embed: ReturnType<typeof vi.spyOn> } {
  const config = writeSemanticConfig(s.settings, { enabled: true, ...patch }, s.db);
  invalidateSemanticCache(s);
  const embedder = new MockEmbedder();
  const embed = vi.spyOn(embedder, "embed");
  return { ctx: { db: s.db, services: s, embedder, config, queryVectors: new Map() }, embed };
}

function itemVectorCount(s: Services): number {
  return s.db.one<{ n: number }>(`SELECT COUNT(*) AS n FROM tal_semantic_item_vectors`)?.n ?? 0;
}

describe("each daily cap controls only its own kind", () => {
  it("CI1 (a): memory cap 0 with item cap 5 still embeds changed tasks and item queries", async () => {
    await inAgent(async (a) => {
      const s = a.services;
      reset(s);
      const { ctx } = context(s, { maxEmbeddingsPerDay: 0, maxItemEmbeddingsPerDay: 5 });
      s.tasks.create({ title: "Water the plants" });
      s.tasks.create({ title: "Call the bank" });
      const report = await runItemPass(ctx as IndexerContext);
      expect(report.capped).toBeUndefined();
      expect(report.embedded).toBe(2);
      expect(itemUsageToday(s.db, UsageService.day()).requests).toBeGreaterThan(0);
      expect(itemVectorCount(s)).toBe(2);
      expect(await queryVector(ctx, "garden chores", "item")).not.toBeNull();
      expect(embeddingsToday(s.db, UsageService.day())).toBe(0);
      reset(s);
    });
  });

  it("CI1 (b): item cap 0 with memory cap 500 embeds no task and reports capped", async () => {
    await inAgent(async (a) => {
      const s = a.services;
      reset(s);
      const { ctx, embed } = context(s, { maxEmbeddingsPerDay: 500, maxItemEmbeddingsPerDay: 0 });
      s.tasks.create({ title: "Renew passport" });
      const report = await runItemPass(ctx as IndexerContext);
      expect(report).toMatchObject({ embedded: 0, capped: true });
      expect(await queryVector(ctx, "travel documents", "item")).toBeNull();
      expect(embed).not.toHaveBeenCalled();
      expect(itemVectorCount(s)).toBe(0);
      reset(s);
    });
  });

  it("CI1 (c): memory cap 0 still keeps memory embedding off", async () => {
    await inAgent(async (a) => {
      const s = a.services;
      reset(s);
      const { ctx, embed } = context(s, { maxEmbeddingsPerDay: 0, maxItemEmbeddingsPerDay: 5 });
      s.memories.create({ content: "Allergic to peanuts", category: "fact" });
      expect(await runIndexer(ctx)).toMatchObject({ embedded: 0, capped: true });
      expect(await queryVector(ctx, "peanuts", "memory")).toBeNull();
      expect(embed).not.toHaveBeenCalled();
      expect(embeddingsToday(s.db, UsageService.day())).toBe(0);
      reset(s);
    });
  });
});
