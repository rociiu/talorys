import { describe, expect, it } from "vitest";
import { inAgent } from "./helpers";
import { invalidateSemanticCache } from "../src/semantic";
import { DEFAULT_SEMANTIC_CONFIG, deleteSemanticConfig } from "../src/semantic/config";
import { MockEmbedder, conservativeEmbeddingTokens } from "../src/semantic/embeddings";
import type { IndexerContext } from "../src/semantic/indexer";
import { dropSemanticData } from "../src/semantic/migrations";
import { itemUsageToday, runItemPass } from "../src/semantic/surfaces";
import { UsageService } from "../src/services/usage";
import type { TalorysAgent } from "../src/agent/talorys-agent";

/** Clears items and semantic state and returns an enabled context with a mock embedder. */
function context(a: TalorysAgent): IndexerContext {
  const s = a.services;
  dropSemanticData(s.db);
  deleteSemanticConfig(s.settings);
  invalidateSemanticCache(s);
  for (const table of ["tal_tasks", "tal_notes", "tal_automations"]) s.db.run(`DELETE FROM ${table}`);
  return { db: s.db, embedder: new MockEmbedder(), config: { ...DEFAULT_SEMANTIC_CONFIG, enabled: true, maxEmbeddingsPerDay: 10_000 } };
}

const chinese = (n: number) => "门禁密码是四位数".repeat(Math.ceil(n / 8)).slice(0, n);

describe("conservative item token estimate", () => {
  it("counts a quarter token per ASCII character and one per other code point", () => {
    expect(conservativeEmbeddingTokens("")).toBe(0);
    expect(conservativeEmbeddingTokens("door code")).toBe(3);
    expect(conservativeEmbeddingTokens(chinese(1000))).toBe(1000);
    expect(conservativeEmbeddingTokens("Note: 门禁密码")).toBe(2 + 4);
    // An emoji outside the BMP is one code point, not two UTF-16 units.
    expect(conservativeEmbeddingTokens("🔑🔑")).toBe(2);
  });

  it("FU4-a: a 1,000-character Chinese note reserves at least 1,000 tokens", async () => {
    await inAgent(async (a) => {
      const ctx = context(a);
      a.services.notes.create({ title: "门禁", content: chinese(1000) });
      expect(await runItemPass(ctx)).toMatchObject({ embedded: 2, pending: 0 });
      expect(itemUsageToday(ctx.db, UsageService.day()).tokens).toBeGreaterThanOrEqual(1000);
      dropSemanticData(ctx.db);
    });
  });

  it("FU4-d: a CJK batch that fits by chars/4 is cut to the run the conservative estimate allows", async () => {
    await inAgent(async (a) => {
      const ctx = context(a);
      const titles = [chinese(400), chinese(400), chinese(400)];
      for (const title of titles) a.services.notes.create({ title });
      const texts = titles.map((t) => `Note: ${t}`);
      const tokens = 1000;
      // All three fit by chars/4, only two by the conservative estimate.
      expect(texts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0)).toBeLessThanOrEqual(tokens);
      expect(conservativeEmbeddingTokens(texts[0]!) * 2).toBeLessThanOrEqual(tokens);
      expect(conservativeEmbeddingTokens(texts[0]!) * 3).toBeGreaterThan(tokens);

      expect(await runItemPass(ctx, { caps: { requests: 50, tokens } })).toEqual({ embedded: 2, pending: 1, purged: 0, capped: true });
      expect(itemUsageToday(ctx.db, UsageService.day())).toEqual({ requests: 1, tokens: conservativeEmbeddingTokens(texts[0]!) * 2 });
      dropSemanticData(ctx.db);
    });
  });
});
