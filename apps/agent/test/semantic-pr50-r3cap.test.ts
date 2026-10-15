import { describe, expect, it } from "vitest";
import { inAgent, loggedIn } from "./helpers";
import { invalidateSemanticCache } from "../src/semantic";
import {
  DEFAULT_SEMANTIC_CONFIG,
  type SemanticConfigPatch,
  SEMANTIC_CONFIG_KEY,
  deleteSemanticConfig,
  readSemanticConfig,
  semanticConfigPatchSchema,
  writeSemanticConfig,
} from "../src/semantic/config";
import { MockEmbedder } from "../src/semantic/embeddings";
import type { IndexerContext } from "../src/semantic/indexer";
import { dropSemanticData } from "../src/semantic/migrations";
import { itemUsageToday, runItemPass } from "../src/semantic/itemIndex";
import { UsageService } from "../src/services/usage";
import type { Services } from "../src/services/container";

function reset(s: Services) {
  dropSemanticData(s.db);
  deleteSemanticConfig(s.settings);
  invalidateSemanticCache(s);
  for (const table of ["tal_tasks", "tal_notes", "tal_automations"]) s.db.run(`DELETE FROM ${table}`);
}

/** Turns the feature on without the PUT route, so no background backfill starts. */
async function enableQuietly(patch: SemanticConfigPatch) {
  await inAgent((agent) => {
    const s = agent.services;
    writeSemanticConfig(s.settings, { enabled: true, ...patch }, s.db);
    invalidateSemanticCache(s);
  });
}

describe("item embedding cap setting", () => {
  it("R3cap-config: a stored config without the field reads 50, and out-of-range values are rejected", async () => {
    await inAgent((a) => {
      const s = a.services;
      reset(s);
      s.settings.setJson(SEMANTIC_CONFIG_KEY, { enabled: true, model: DEFAULT_SEMANTIC_CONFIG.model, maxEmbeddingsPerDay: 500 });
      expect(readSemanticConfig(s.settings, s.db)?.maxItemEmbeddingsPerDay).toBe(50);
      expect(semanticConfigPatchSchema.safeParse({ maxItemEmbeddingsPerDay: 10_001 }).success).toBe(false);
      expect(semanticConfigPatchSchema.safeParse({ maxItemEmbeddingsPerDay: -1 }).success).toBe(false);
      expect(() => writeSemanticConfig(s.settings, { maxItemEmbeddingsPerDay: 10_001 }, s.db)).toThrow();
      expect(writeSemanticConfig(s.settings, { maxItemEmbeddingsPerDay: 0 }, s.db).maxItemEmbeddingsPerDay).toBe(0);
      reset(s);
    });
  });

  it("R3cap-status: the status route reports the saved item cap", async () => {
    await inAgent((a) => reset(a.services));
    await enableQuietly({ maxItemEmbeddingsPerDay: 2 });
    const c = await loggedIn();
    const status = (await c.json("/api/semantic/status")) as { items: { items_cap: number } };
    expect(status.items.items_cap).toBe(2);
    await inAgent((a) => reset(a.services));
  });

  it("R3cap-pass: item passes stop at the saved item cap", async () => {
    await inAgent(async (a) => {
      const s = a.services;
      reset(s);
      const config = writeSemanticConfig(s.settings, { enabled: true, maxEmbeddingsPerDay: 10_000, maxItemEmbeddingsPerDay: 1 }, s.db);
      invalidateSemanticCache(s);
      const ctx: IndexerContext = { db: s.db, embedder: new MockEmbedder(), config };
      for (const title of ["Water the plants", "Call the bank", "Renew passport"]) {
        s.tasks.create({ title });
        await runItemPass(ctx);
      }
      expect(itemUsageToday(s.db, UsageService.day()).requests).toBe(1);
      reset(s);
    });
  });
});
