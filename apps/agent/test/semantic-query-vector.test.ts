import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { inAgent } from "./helpers";
import { invalidateSemanticCache } from "../src/semantic";
import { DEFAULT_SEMANTIC_CONFIG, deleteSemanticConfig, readSemanticConfig, writeSemanticConfig } from "../src/semantic/config";
import { MockEmbedder, embeddingsToday } from "../src/semantic/embeddings";
import { dropSemanticData, ensureSemanticSchema } from "../src/semantic/migrations";
import {
  MAX_QUERY_VECTORS,
  type SemanticContext,
  createSemanticContext,
  hybridSearch,
  queryKey,
  selectSemanticMemories,
} from "../src/semantic/recall";
import { UsageService } from "../src/services/usage";
import type { TalorysAgent } from "../src/agent/talorys-agent";
import type { Env } from "../src/env";

const workerEnv = env as unknown as Env;

/** Records every text it embeds; `failNext` makes the next call throw. */
class CountingEmbedder extends MockEmbedder {
  texts: string[] = [];
  failNext = false;
  override async embed(texts: string[]): Promise<Float32Array[]> {
    this.texts.push(...texts);
    if (this.failNext) {
      this.failNext = false;
      throw new Error("AI quota exhausted");
    }
    return super.embed(texts);
  }
  /** Embeds of `query`, matched by its cache key. */
  embedsOf(query: string): number {
    return this.texts.filter((t) => queryKey(t) === queryKey(query)).length;
  }
}

/** Clears memories and semantic state and returns an enabled literal context, as tests elsewhere build it. */
function context(a: TalorysAgent) {
  const s = a.services;
  dropSemanticData(s.db);
  deleteSemanticConfig(s.settings);
  invalidateSemanticCache(s);
  s.memories.clear();
  ensureSemanticSchema(s.db);
  const embedder = new CountingEmbedder();
  const ctx: SemanticContext = {
    db: s.db,
    services: s,
    embedder,
    config: { ...DEFAULT_SEMANTIC_CONFIG, enabled: true, maxEmbeddingsPerDay: 10_000 },
  };
  return { s, ctx, embedder };
}

describe("queryVector embeds each query once per turn", () => {
  it("QV-reuse: recall then search of the same question embeds once", async () => {
    await inAgent(async (a) => {
      const { ctx, embedder } = context(a);
      await selectSemanticMemories(ctx, "Doc appt soon?");
      await hybridSearch(ctx, "  doc appt   soon? ", { limit: 5 });
      expect(embedder.texts).toEqual(["Doc appt soon?"]);
    });
  });

  it("QV-distinct: different queries embed separately and repeats add none", async () => {
    await inAgent(async (a) => {
      const { ctx, embedder } = context(a);
      await hybridSearch(ctx, "kayak trip", { limit: 5 });
      await hybridSearch(ctx, "dentist", { limit: 5 });
      expect(embedder.texts).toHaveLength(2);
      await hybridSearch(ctx, "Kayak  trip", { limit: 5 });
      await hybridSearch(ctx, "DENTIST ", { limit: 5 });
      expect(embedder.texts).toHaveLength(2);
      expect(embedder.embedsOf("kayak trip")).toBe(1);
      expect(embedder.embedsOf("dentist")).toBe(1);
    });
  });

  it("Q-new-turn: a new context embeds the same query again", async () => {
    await inAgent(async (a) => {
      const s = a.services;
      dropSemanticData(s.db);
      deleteSemanticConfig(s.settings);
      s.memories.clear();
      writeSemanticConfig(s.settings, { enabled: true, maxEmbeddingsPerDay: 10_000 }, s.db);
      invalidateSemanticCache(s);
      const config = readSemanticConfig(s.settings, s.db)!;
      const day = UsageService.day();
      const before = embeddingsToday(s.db, day);

      const first = createSemanticContext(s, workerEnv, config);
      expect(first.queryVectors?.size).toBe(0);
      await hybridSearch(first, "where is my passport", { limit: 5 });
      await hybridSearch(first, "where is my passport", { limit: 5 });
      expect(embeddingsToday(s.db, day)).toBe(before + 1);

      const second = createSemanticContext(s, workerEnv, config);
      await hybridSearch(second, "where is my passport", { limit: 5 });
      expect(embeddingsToday(s.db, day)).toBe(before + 2);
    });
  });

  it("Q-fail-memory: a failed embed is not retried and every search returns keyword hits", async () => {
    await inAgent(async (a) => {
      const { s, ctx, embedder } = context(a);
      const m = s.memories.create({ content: "Allergic to peanuts", category: "fact" });
      embedder.failNext = true;
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        for (let i = 0; i < 3; i++) {
          const hits = await hybridSearch(ctx, "peanuts", { limit: 10 });
          expect(hits.map((h) => [h.memory.id, h.cosine])).toEqual([[m.id, null]]);
        }
      } finally {
        warn.mockRestore();
      }
      expect(embedder.embedsOf("peanuts")).toBe(1);
      expect(ctx.queryVectors?.get("peanuts")).toEqual({ vector: null, failed: ["memory"] });
    });
  });

  it("QV-bound: nine distinct queries leave eight cached, the oldest evicted", async () => {
    await inAgent(async (a) => {
      const { ctx, embedder } = context(a);
      for (let i = 0; i < 9; i++) await hybridSearch(ctx, `query number ${i}`, { limit: 5 });
      expect(ctx.queryVectors?.size).toBe(MAX_QUERY_VECTORS);
      expect(MAX_QUERY_VECTORS).toBe(8);
      expect(ctx.queryVectors?.has("query number 0")).toBe(false);
      expect(ctx.queryVectors?.has("query number 8")).toBe(true);
      // The evicted query embeds again; a kept one does not.
      await hybridSearch(ctx, "query number 8", { limit: 5 });
      await hybridSearch(ctx, "query number 0", { limit: 5 });
      expect(embedder.embedsOf("query number 8")).toBe(1);
      expect(embedder.embedsOf("query number 0")).toBe(2);
    });
  });
});
