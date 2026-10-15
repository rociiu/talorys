import { describe, expect, it } from "vitest";
import { inAgent } from "./helpers";
import { invalidateSemanticCache } from "../src/semantic";
import { DEFAULT_SEMANTIC_CONFIG, deleteSemanticConfig } from "../src/semantic/config";
import { type Usage, modelUsage, tokens } from "../src/ai/provider";
import { MeteredEmbedder, MockEmbedder, conservativeEmbeddingTokens } from "../src/semantic/embeddings";
import type { IndexerContext } from "../src/semantic/indexer";
import { dropSemanticData } from "../src/semantic/migrations";
import type { SemanticContext } from "../src/semantic/recall";
import { itemUsageToday, runItemPass } from "../src/semantic/itemIndex";
import { semanticTools } from "../src/semantic/tools";
import type { ToolContext } from "../src/tools";
import type { ImmediateTool } from "../src/tools/registry";
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

/** A mock embedder whose calls report `reported` input tokens, the way Workers AI returns prompt_tokens. */
class ReportingEmbedder extends MockEmbedder {
  constructor(private readonly reported: number) {
    super();
  }

  override async embed(texts: string[], onUsage?: (usage: Usage) => void): Promise<Float32Array[]> {
    const vectors = await super.embed(texts);
    onUsage?.(modelUsage(this.model, false, tokens(this.reported, 0)));
    return vectors;
  }
}

describe("reported item token correction", () => {
  it("FU4-b: the item counter takes the reported token count and keeps the estimate without one", async () => {
    await inAgent(async (a) => {
      const ctx = { ...context(a), embedder: new ReportingEmbedder(812) };
      a.services.notes.create({ title: "门禁", content: chinese(1000) });
      expect(await runItemPass(ctx)).toMatchObject({ embedded: 2, pending: 0 });
      expect(itemUsageToday(ctx.db, UsageService.day())).toEqual({ requests: 1, tokens: 812 });

      const estimated = context(a);
      a.services.notes.create({ title: "门禁", content: chinese(1000) });
      expect(await runItemPass(estimated)).toMatchObject({ embedded: 2, pending: 0 });
      const reserved = conservativeEmbeddingTokens("Note: 门禁") + conservativeEmbeddingTokens(`门禁: ${chinese(1000)}`);
      expect(itemUsageToday(estimated.db, UsageService.day())).toEqual({ requests: 1, tokens: reserved });
      dropSemanticData(ctx.db);
    });
  });

  it("FU4-b: a reported 0 tokens corrects the counter down without going below 0", async () => {
    await inAgent(async (a) => {
      const ctx = { ...context(a), embedder: new ReportingEmbedder(0) };
      a.services.notes.create({ title: "Lease" });
      expect(await runItemPass(ctx)).toMatchObject({ embedded: 1, pending: 0 });
      expect(itemUsageToday(ctx.db, UsageService.day())).toEqual({ requests: 1, tokens: 0 });
      dropSemanticData(ctx.db);
    });
  });

  it("FU4-c: an item pass and a search_notes query each add an embedding row to usage history", async () => {
    await inAgent(async (a) => {
      const s = a.services;
      const base = context(a);
      const embedder = new MeteredEmbedder(s.db, new ReportingEmbedder(812));
      const sem: SemanticContext = { ...base, services: s, embedder, queryVectors: new Map() };
      s.notes.create({ title: "Lisbon itinerary", content: "Day 1: Alfama walk" });
      const rows = () =>
        s.db.one<{ n: number }>(
          `SELECT COALESCE(SUM(embedding_requests), 0) AS n FROM tal_model_usage_daily WHERE day = ? AND model = ?`,
          UsageService.day(),
          embedder.model,
        )!.n;
      const before = rows();

      expect(await runItemPass(sem)).toMatchObject({ embedded: 2, pending: 0 });
      const toolCtx: ToolContext = { services: s, timezone: "UTC", mode: "chat" };
      const searchNotes = semanticTools(sem).find((t) => t.name === "search_notes") as ImmediateTool;
      await searchNotes.execute({ query: "travel plans" }, toolCtx);

      expect(rows() - before).toBe(2);
      // Both calls were item calls, each corrected to the reported count.
      expect(itemUsageToday(s.db, UsageService.day())).toEqual({ requests: 2, tokens: 2 * 812 });
      dropSemanticData(s.db);
    });
  });
});
