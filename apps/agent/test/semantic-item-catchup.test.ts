import { describe, expect, it } from "vitest";
import { inAgent } from "./helpers";
import { FixtureEmbedder, fixtureConfig } from "./fixture-embedder";
import { catchUpItems, invalidateSemanticCache, semanticExtensions, semanticItemSelector } from "../src/semantic";
import { deleteSemanticConfig } from "../src/semantic/config";
import { dropSemanticData, ensureSemanticSchema } from "../src/semantic/migrations";
import { type SemanticContext, selectSemanticMemories } from "../src/semantic/recall";
import { ITEM_EMBEDDINGS_PER_DAY, itemUsageToday, pendingItems } from "../src/semantic/itemIndex";
import { SEARCH_REEMBED_MAX } from "../src/semantic/itemSearch";
import { UsageService } from "../src/services/usage";
import type { TalorysAgent } from "../src/agent/talorys-agent";

function setup(a: TalorysAgent) {
  const s = a.services;
  dropSemanticData(s.db);
  deleteSemanticConfig(s.settings);
  invalidateSemanticCache(s);
  s.memories.clear();
  for (const table of ["tal_tasks", "tal_notes", "tal_automations"]) s.db.run(`DELETE FROM ${table}`);
  ensureSemanticSchema(s.db);
  const embedder = new FixtureEmbedder();
  const sem: SemanticContext = { db: s.db, services: s, embedder, config: fixtureConfig(), queryVectors: new Map() };
  return { s, sem, embedder };
}

const itemRows = (sem: SemanticContext) => sem.db.one<{ n: number }>(`SELECT COUNT(*) AS n FROM tal_semantic_item_vectors`)!.n;
const pendingCount = async (sem: SemanticContext) => (await pendingItems(sem.db, sem.embedder!.model, sem.embedder!.dims)).pending.length;

describe("lazy item catch-up on a chat turn", () => {
  it("a reminder saved with no search stays pending, then the next turn embeds it and lists it", async () => {
    await inAgent(async (a) => {
      const { s, sem } = setup(a);
      const bins = s.automationsRepo.create({ name: "Put the bins out", kind: "reminder", message: "Put the bins out", schedule: { type: "daily", time: "19:00" }, enabled: true });
      expect(await pendingCount(sem)).toBe(1);
      expect(itemRows(sem)).toBe(0);

      await selectSemanticMemories(sem, "garbage day");
      const section = await semanticItemSelector(sem)("garbage day");

      expect(section).toContain(`Put the bins out (id ${bins.id})`);
      expect(await pendingCount(sem)).toBe(0);
      expect(itemUsageToday(s.db, UsageService.day()).requests).toBeGreaterThan(0);
    });
  });

  it(`embeds at most ${SEARCH_REEMBED_MAX} parts per turn and leaves the rest pending`, async () => {
    await inAgent(async (a) => {
      const { s, sem } = setup(a);
      for (let i = 0; i < SEARCH_REEMBED_MAX + 4; i++) s.tasks.create({ title: `Errand number ${i}` });
      await catchUpItems(sem);
      expect(itemRows(sem)).toBe(SEARCH_REEMBED_MAX);
      expect(await pendingCount(sem)).toBe(4);
      await catchUpItems(sem);
      expect(await pendingCount(sem)).toBe(0);
    });
  });

  it("at the daily item cap it embeds nothing and still scores what has vectors", async () => {
    await inAgent(async (a) => {
      const { s, sem, embedder } = setup(a);
      const water = s.tasks.create({ title: "Water the plants" });
      await catchUpItems(sem);
      s.tasks.create({ title: "Repot the fern" });
      await selectSemanticMemories(sem, "botany");
      embedder.calls.length = 0;
      const before = itemUsageToday(s.db, UsageService.day());

      const day = UsageService.day();
      s.db.run(
        `INSERT INTO tal_semantic_item_usage (day, requests, tokens) VALUES (?, ?, 0) ON CONFLICT(day) DO UPDATE SET requests = excluded.requests`,
        day,
        ITEM_EMBEDDINGS_PER_DAY,
      );
      const capped = itemUsageToday(s.db, day);
      const section = await semanticItemSelector(sem)("botany");

      expect(embedder.calls).toEqual([]);
      expect(itemUsageToday(s.db, day)).toEqual(capped);
      expect(capped.requests).toBeGreaterThan(before.requests);
      expect(await pendingCount(sem)).toBe(1);
      expect(section).toContain(`Water the plants (id ${water.id})`);
      expect(section).not.toContain("Repot the fern");
    });
  });

  it("with the feature off there is no item hook and nothing is embedded", async () => {
    await inAgent(async (a) => {
      const { s, sem } = setup(a);
      s.tasks.create({ title: "Water the plants" });
      deleteSemanticConfig(s.settings);
      invalidateSemanticCache(s);
      expect(semanticExtensions(s, {} as never)).toBeUndefined();
      expect(itemRows(sem)).toBe(0);
    });
  });
});
