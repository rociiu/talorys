import type { Memory, MemoryCategory } from "@talorys/shared";
import { describe, expect, it, vi } from "vitest";
import { inAgent } from "./helpers";
import { invalidateSemanticCache, semanticExtensions } from "../src/semantic";
import {
  DEFAULT_SEMANTIC_CONFIG,
  LEGACY_DEFAULT_MODEL,
  type SemanticConfig,
  deleteSemanticConfig,
  readSemanticConfig,
  writeSemanticConfig,
} from "../src/semantic/config";
import {
  EMBEDDING_DIMS,
  type Embedder,
  MockEmbedder,
  contentHash,
  embeddingText,
  embeddingsToday,
  encodeVector,
} from "../src/semantic/embeddings";
import { pendingMemories, runIndexer } from "../src/semantic/indexer";
import { dropSemanticData, ensureSemanticSchema } from "../src/semantic/migrations";
import {
  estimateTokens,
  type AgentEvent,
  type AIProvider,
  type GenerateRequest,
  type ToolRequest,
} from "../src/ai/provider";
import {
  MAX_NEWER_PER_HIT,
  MAX_RELEVANT_MEMORIES,
  NEWER_DUPLICATE_COSINE,
  FALLBACK_K,
  NEWER_WINS_NOTE,
  newerDuplicateCosine,
  type SemanticContext,
  applyM1,
  hybridSearch,
  pullInNewer,
  rrf,
  savedAt,
  selectSemanticMemories,
  createSemanticContext,
} from "../src/semantic/recall";
import { UsageService } from "../src/services/usage";
import { semanticTools } from "../src/semantic/tools";
import { type ToolContext, ALL_TOOLS } from "../src/tools";
import type { ImmediateTool } from "../src/tools/registry";
import type { TalorysAgent } from "../src/agent/talorys-agent";
import { env } from "cloudflare:workers";
import golden from "./fixtures/recall-golden.json";
import { AgentRunner } from "../src/agent/runner";
import { selectRelevantMemories } from "../src/agent/memory";
import { semanticNeighbors } from "../src/semantic/neighbors";
import { buildSystemPrompt } from "../src/agent/prompt";
import type { Services } from "../src/services/container";
import type { Env } from "../src/env";

type ContextPatch = Partial<Omit<SemanticConfig, "vectorFloor">> & { vectorFloor?: Partial<SemanticConfig["vectorFloor"]> };

/**
 * Clears memories and semantic state and returns an enabled context with a spied mock embedder.
 * A patched floor without `backstop` sets it to `absolute`, so cases about other behavior get no top-k fallback.
 */
function context(a: TalorysAgent, patch: ContextPatch = {}, embedder: Embedder | null = new MockEmbedder()) {
  const s = a.services;
  dropSemanticData(s.db);
  deleteSemanticConfig(s.settings);
  invalidateSemanticCache(s);
  s.memories.clear();
  const embed = embedder ? vi.spyOn(embedder, "embed") : null;
  const ctx: SemanticContext = {
    db: s.db,
    services: s,
    embedder,
    config: {
      ...DEFAULT_SEMANTIC_CONFIG,
      enabled: true,
      maxEmbeddingsPerDay: 10_000,
      ...patch,
      vectorFloor: patch.vectorFloor
        ? { ...DEFAULT_SEMANTIC_CONFIG.vectorFloor, backstop: patch.vectorFloor.absolute ?? DEFAULT_SEMANTIC_CONFIG.vectorFloor.absolute, ...patch.vectorFloor }
        : { ...DEFAULT_SEMANTIC_CONFIG.vectorFloor },
    },
  };
  return { ctx, embed, s };
}

function memory(id: string, updated_at: string, created_at = updated_at, content = `memory ${id}`): Memory {
  return { id, content, category: "fact", source: "manual", status: "active", superseded_by: null, valid_from: null, valid_until: null, created_at, updated_at };
}

const setUpdated = (a: TalorysAgent, id: string, iso: string) =>
  a.services.db.run(`UPDATE tal_memories SET updated_at = ?, created_at = ? WHERE id = ?`, iso, iso, id);

/** Pads a short coordinate list to a full embedding. */
function vec(coords: number[], dims = EMBEDDING_DIMS): Float32Array {
  const v = new Float32Array(dims);
  v.set(coords);
  return v;
}

/** Unit vector at `cos` to the first axis, off along axis `k`: two such vectors meet at cos1 * cos2. */
const near = (cos: number, k: number, dims = EMBEDDING_DIMS) => {
  const coords = new Array<number>(k + 1).fill(0);
  coords[0] = cos;
  coords[k] = Math.sqrt(1 - cos * cos);
  return vec(coords, dims);
};

/** Unit vectors whose pairwise cosines are `gram` (Cholesky of the Gram matrix). */
function fromGram(gram: number[][]): Float32Array[] {
  const n = gram.length;
  const l = gram.map(() => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = gram[i]![j]!;
      for (let k = 0; k < j; k++) sum -= l[i]![k]! * l[j]![k]!;
      l[i]![j] = i === j ? Math.sqrt(sum) : sum / l[j]![j]!;
    }
  }
  return l.map((row) => vec(row));
}

/** Returns `query` for every text; spied so a test can count calls. */
function stubEmbedder(model: string, query: Float32Array): Embedder {
  return { model, dims: query.length, embed: async (texts) => texts.map(() => query) };
}

/** Creates a memory saved at `iso` with a current stored vector, so the indexer leaves it alone. */
async function place(a: TalorysAgent, model: string, content: string, iso: string, vector: Float32Array): Promise<Memory> {
  const s = a.services;
  const m = s.memories.create({ content, category: "fact" });
  setUpdated(a, m.id, iso);
  ensureSemanticSchema(s.db);
  s.db.run(
    `INSERT INTO tal_semantic_vectors (memory_id, model, dims, content_hash, vector, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    m.id, model, vector.length, await contentHash(embeddingText(m)), encodeVector(vector), iso,
  );
  return s.memories.get(m.id)!;
}

describe("rrf", () => {
  it("sums 1/(k + rank) over the lists an id appears in", () => {
    const scores = rrf([
      ["a", "b"],
      ["b", "c"],
    ]);
    expect(scores.get("a")).toBeCloseTo(1 / 61);
    expect(scores.get("b")).toBeCloseTo(1 / 62 + 1 / 61);
    expect(scores.get("c")).toBeCloseTo(1 / 62);
    expect(rrf([["x"]], 10).get("x")).toBeCloseTo(1 / 11);
    expect(rrf([[], []]).size).toBe(0);
  });
});

describe("savedAt", () => {
  it("formats date, 24-hour time and short zone in the owner's timezone", () => {
    expect(savedAt("2026-10-11T03:31:34Z", "UTC")).toBe("2026-10-11 03:31 UTC");
    expect(savedAt("2026-10-11T03:31:34Z", "America/Los_Angeles")).toBe("2026-10-10 20:31 PDT");
    expect(savedAt("2026-01-16T05:30:00Z", "America/Los_Angeles")).toBe("2026-01-15 21:30 PST");
    expect(savedAt("2026-10-10T23:30:00Z", "Asia/Tokyo")).toBe("2026-10-11 08:30 GMT+9");
  });

  it("renders midnight as 00, not 24", () => {
    expect(savedAt("2026-10-11T00:05:00Z", "UTC")).toBe("2026-10-11 00:05 UTC");
    expect(savedAt("2026-10-10T15:05:00Z", "Asia/Tokyo")).toBe("2026-10-11 00:05 GMT+9");
  });

  it("falls back to UTC for an invalid timezone", () => {
    expect(savedAt("2026-10-10T23:30:00Z", "Not/AZone")).toBe("2026-10-10 23:30 UTC");
  });
});

describe("applyM1", () => {
  it("orders newest update first, then newest creation, then id, and prefixes copies", () => {
    const input = [
      memory("b", "2026-01-01T00:00:00Z"),
      memory("c", "2026-03-01T00:00:00Z", "2026-01-01T00:00:00Z"),
      memory("a", "2026-03-01T00:00:00Z", "2026-02-01T00:00:00Z"),
      memory("d", "2026-03-01T00:00:00Z", "2026-02-01T00:00:00Z"),
    ];
    const snapshot = structuredClone(input);
    const out = applyM1(input, "UTC");
    expect(out.map((m) => m.id)).toEqual(["a", "d", "c", "b"]);
    expect(out[0]!.content).toBe("(saved 2026-03-01 00:00 UTC) memory a");
    expect(out[3]!.content).toBe("(saved 2026-01-01 00:00 UTC) memory b");
    expect(input).toEqual(snapshot);
  });

  it("dates the prefix in the owner's timezone", () => {
    const [m] = applyM1([memory("x", "2026-10-11T06:30:00Z", undefined, "Owns a kayak")], "America/Los_Angeles");
    expect(m!.content).toBe("(saved 2026-10-10 23:30 PDT) Owns a kayak");
  });

  it("orders two same-day memories a minute apart newest first with different times", () => {
    const bug = memory("bug", "2026-10-11T03:30:17Z", undefined, "My car is a Volkswagen bug from the 1960s.");
    const tesla = memory("tesla", "2026-10-11T03:31:34Z", undefined, "I just traded my VW bug away and got a 2025 Tesla.");
    expect(applyM1([bug, tesla], "America/Los_Angeles").map((m) => m.content)).toEqual([
      "(saved 2026-10-10 20:31 PDT) I just traded my VW bug away and got a 2025 Tesla.",
      "(saved 2026-10-10 20:30 PDT) My car is a Volkswagen bug from the 1960s.",
    ]);
  });
});

describe("hybridSearch", () => {
  it("fuses vector and keyword hits, finding paraphrases keyword search misses", async () => {
    await inAgent(async (a) => {
      const { ctx, s } = context(a);
      const tesla = s.memories.create({ content: "Drives a Tesla Model 3", category: "fact" });
      const france = s.memories.create({ content: "Capital of France is Paris", category: "fact" });
      await runIndexer(ctx);
      expect(s.memories.search("my vehicle", 50)).toEqual([]);
      const hits = await hybridSearch(ctx, "my vehicle", { limit: 10 });
      expect(hits.map((h) => h.memory.id)).toEqual([tesla.id]);
      expect(hits[0]!.cosine).toBeGreaterThanOrEqual(0.5);
      expect(hits[0]!.fused).toBeCloseTo(1 / 61);
      expect(hits.some((h) => h.memory.id === france.id)).toBe(false);
    });
  });

  it("ranks a memory in both lists above one in a single list", async () => {
    await inAgent(async (a) => {
      const { ctx, s } = context(a);
      const both = s.memories.create({ content: "My car is a Tesla", category: "fact" });
      const vectorOnly = s.memories.create({ content: "Changed the oil last week", category: "fact" });
      // Older than the Tesla, so it is not pulled in as a newer near-duplicate at the Tesla's score.
      setUpdated(a, vectorOnly.id, "2026-01-01T00:00:00Z");
      await runIndexer(ctx);
      const hits = await hybridSearch(ctx, "tesla", { limit: 10 });
      expect(hits[0]!.memory.id).toBe(both.id);
      expect(hits[0]!.cosine).not.toBeNull();
      expect(hits[0]!.fused).toBeGreaterThan(1 / 61);
      const other = hits.find((h) => h.memory.id === vectorOnly.id);
      if (other) expect(other.fused).toBeLessThan(hits[0]!.fused);
    });
  });

  it("applies the absolute and relative cosine floors", async () => {
    await inAgent(async (a) => {
      const { ctx, s } = context(a, { vectorFloor: { absolute: 0.99, relative: 0.1 } });
      s.memories.create({ content: "Drives a Tesla Model 3", category: "fact" });
      await runIndexer(ctx);
      expect(await hybridSearch(ctx, "my vehicle", { limit: 10 })).toEqual([]);

      ctx.config = { ...ctx.config, vectorFloor: { absolute: 0, relative: 0, backstop: 0 } };
      const hits = await hybridSearch(ctx, "my vehicle", { limit: 10 });
      // Only the best cosine survives a zero relative window.
      expect(hits).toHaveLength(1);
    });
  });

  it("breaks equal fused scores by cosine", async () => {
    await inAgent(async (a) => {
      const { ctx, s } = context(a);
      const keyword = s.memories.create({ content: "Owns a red kayak", category: "fact" });
      const vector = s.memories.create({ content: "Drives a Tesla Model 3", category: "fact" });
      await runIndexer(ctx);
      const hits = await hybridSearch(ctx, "kayak vehicle", { limit: 10 });
      expect(hits.map((h) => h.memory.id)).toEqual([vector.id, keyword.id]);
      expect(hits[0]!.fused).toBeCloseTo(hits[1]!.fused);
      expect(hits[1]!.cosine).toBeNull();
    });
  });

  it("degrades to keyword-only without an embedder, at the cap and on AI error", async () => {
    await inAgent(async (a) => {
      const { ctx, s } = context(a, {}, null);
      const m = s.memories.create({ content: "Allergic to peanuts", category: "fact" });
      const keywordOnly = await hybridSearch(ctx, "peanuts", { limit: 10 });
      expect(keywordOnly.map((h) => [h.memory.id, h.cosine])).toEqual([[m.id, null]]);
    });

    await inAgent(async (a) => {
      const { ctx, s, embed } = context(a, { maxEmbeddingsPerDay: 0 });
      const m = s.memories.create({ content: "Allergic to peanuts", category: "fact" });
      const hits = await hybridSearch(ctx, "peanuts", { limit: 10 });
      expect(embed).not.toHaveBeenCalled();
      expect(hits.map((h) => [h.memory.id, h.cosine])).toEqual([[m.id, null]]);
      expect(embeddingsToday(s.db, UsageService.day())).toBe(0);
    });

    await inAgent(async (a) => {
      const { ctx, s, embed } = context(a);
      const m = s.memories.create({ content: "Allergic to peanuts", category: "fact" });
      embed!.mockRejectedValue(new Error("AI quota exhausted"));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const hits = await hybridSearch(ctx, "peanuts", { limit: 10 });
        expect(hits.map((h) => [h.memory.id, h.cosine])).toEqual([[m.id, null]]);
        expect(embeddingsToday(s.db, UsageService.day())).toBe(1);
      } finally {
        warn.mockRestore();
      }
    });
  });

  it("counts the query embedding against the daily cap", async () => {
    await inAgent(async (a) => {
      const { ctx, s, embed } = context(a);
      s.memories.create({ content: "Lives in Portland", category: "fact" });
      await runIndexer(ctx);
      const before = embeddingsToday(s.db, UsageService.day());
      embed!.mockClear();
      await hybridSearch(ctx, "where do I live", { limit: 10 });
      expect(embed).toHaveBeenCalledTimes(1);
      expect(embeddingsToday(s.db, UsageService.day())).toBe(before + 1);
    });
  });

  it("skips vector rows whose memory was deleted and handles an empty store", async () => {
    await inAgent(async (a) => {
      const { ctx, s } = context(a);
      expect(await hybridSearch(ctx, "anything at all", { limit: 10 })).toEqual([]);
      const m = s.memories.create({ content: "Drives a Tesla Model 3", category: "fact" });
      await runIndexer(ctx);
      s.memories.delete(m.id);
      expect(await hybridSearch(ctx, "my vehicle", { limit: 10 })).toEqual([]);
    });
  });
});

describe("newer near-duplicate pull-in", () => {
  // These measurements were taken on bge-small, so the cases run as that model with its 0.50 floor.
  const MODEL = LEGACY_DEFAULT_MODEL;
  const M3 = "@cf/baai/bge-m3";
  const OIL = "How often should I change the oil in my car?";
  // Measured cosines: query~Bug 0.515, query~Porsche 0.519, query~Tesla 0.488 (under the
  // 0.50 floor); Bug~Tesla 0.772 (pulls), Bug~Porsche 0.523 and Tesla~Porsche 0.589 (do not).
  const [query, bug, tesla, porsche] = fromGram([
    [1, 0.515, 0.488, 0.519],
    [0.515, 1, 0.772, 0.523],
    [0.488, 0.772, 1, 0.589],
    [0.519, 0.523, 0.589, 1],
  ]);

  it("pulls the newer Tesla in beside the Bug for the oil question, on the prompt path and in search_memories", async () => {
    await inAgent(async (a) => {
      const { ctx, s } = context(a, { model: MODEL, vectorFloor: { absolute: 0.5, relative: 0.1 } }, stubEmbedder(MODEL, query!));
      const b = await place(a, MODEL, "My car is a Volkswagen bug from the 1960s.", "2026-10-11T03:30:17Z", bug!);
      const t = await place(a, MODEL, "I just traded my VW bug away and got a 2025 Tesla.", "2026-10-11T03:31:34Z", tesla!);
      const p = await place(a, MODEL, "I would like to buy a Porsche one day.", "2026-10-11T03:31:42Z", porsche!);
      expect(s.memories.search(OIL, 50).map((m) => m.id)).not.toContain(t.id);

      const hits = await hybridSearch(ctx, OIL, { limit: 8 });
      const ids = hits.map((h) => h.memory.id);
      expect(ids).toContain(p.id);
      expect(ids.indexOf(t.id)).toBe(ids.indexOf(b.id) + 1);
      const pulled = hits[ids.indexOf(t.id)]!;
      expect(pulled.cosine).toBeNull();
      expect(pulled.fused).toBe(hits[ids.indexOf(b.id)]!.fused);
      expect(hits[ids.indexOf(p.id)]!.cosine).toBeCloseTo(0.519, 3);

      const selected = await selectSemanticMemories(ctx, OIL);
      expect(selected.map((m) => m.id)).toEqual(expect.arrayContaining([b.id, t.id, p.id]));
      expect(selected).toHaveLength(4);

      const toolCtx: ToolContext = { services: s, timezone: "UTC", mode: "chat" };
      const tool = semanticTools(ctx).find((x) => x.name === "search_memories")! as ImmediateTool;
      const result = (await tool.execute({ query: OIL }, toolCtx)) as { memories: { id: string }[] };
      expect(result.memories.map((m) => m.id)).toContain(t.id);
    });
  });

  it("pulls a newer duplicate in, never an older one, and not one under the threshold", async () => {
    const floor = { vectorFloor: { absolute: 0.95, relative: 0.1 } };
    await inAgent(async (a) => {
      const { ctx } = context(a, { model: MODEL, ...floor }, stubEmbedder(MODEL, near(1, 1)));
      const portland = await place(a, MODEL, "I live in Portland", "2026-03-02T12:00:00Z", near(1, 1));
      const denver = await place(a, MODEL, "I live in Denver", "2026-09-14T12:00:00Z", near(0.748, 2));
      expect((await hybridSearch(ctx, "residence", { limit: 8 })).map((h) => h.memory.id)).toEqual([portland.id, denver.id]);
    });
    await inAgent(async (a) => {
      const { ctx } = context(a, { model: MODEL, ...floor }, stubEmbedder(MODEL, near(1, 1)));
      await place(a, MODEL, "I live in Portland", "2026-03-02T12:00:00Z", near(0.748, 2));
      const denver = await place(a, MODEL, "I live in Denver", "2026-09-14T12:00:00Z", near(1, 1));
      expect((await hybridSearch(ctx, "residence", { limit: 8 })).map((h) => h.memory.id)).toEqual([denver.id]);
    });
    await inAgent(async (a) => {
      const { ctx } = context(a, { model: MODEL, ...floor }, stubEmbedder(MODEL, near(1, 1)));
      const older = await place(a, MODEL, "I like jazz", "2026-03-02T12:00:00Z", near(1, 1));
      await place(a, MODEL, "I'm vegetarian", "2026-09-14T12:00:00Z", near(NEWER_DUPLICATE_COSINE - 0.01, 2));
      await place(a, MODEL, "I collect stamps", "2026-03-02T12:00:00Z", near(0.9, 3));
      expect((await hybridSearch(ctx, "hobby", { limit: 8 })).map((h) => h.memory.id)).toEqual([older.id]);
    });
  });

  it("pulls at most two per hit, highest cosine first, without embedding anything", async () => {
    await inAgent(async (a) => {
      const embedder = stubEmbedder(MODEL, near(1, 1));
      const { ctx, embed } = context(a, { model: MODEL, vectorFloor: { absolute: 0.95, relative: 0.1 } }, embedder);
      const base = await place(a, MODEL, "Base fact", "2026-01-01T00:00:00Z", near(1, 1));
      await place(a, MODEL, "Third update", "2026-01-04T00:00:00Z", near(0.75, 2));
      const best = await place(a, MODEL, "First update", "2026-01-02T00:00:00Z", near(0.9, 3));
      const next = await place(a, MODEL, "Second update", "2026-01-03T00:00:00Z", near(0.8, 4));
      const hits = await hybridSearch(ctx, "zzz", { limit: 8 });
      expect(MAX_NEWER_PER_HIT).toBe(2);
      expect(hits.map((h) => h.memory.id)).toEqual([base.id, best.id, next.id]);
      expect(embed).toHaveBeenCalledTimes(1);
    });
    await inAgent(async (a) => {
      const { ctx } = context(a, { model: MODEL, vectorFloor: { absolute: 0.5, relative: 0.1 } }, null);
      const portland = await place(a, MODEL, "I live in Portland", "2026-03-02T12:00:00Z", near(1, 1));
      const denver = await place(a, MODEL, "I moved to Denver", "2026-09-14T12:00:00Z", near(0.748, 2));
      expect((await hybridSearch(ctx, "Portland", { limit: 8 })).map((h) => h.memory.id)).toEqual([portland.id, denver.id]);
    });
  });

  it("drops the weakest regular hit from a full list, and skips the pull when nothing can go", async () => {
    await inAgent(async (a) => {
      const { ctx } = context(a, { model: MODEL, vectorFloor: { absolute: 0.95, relative: 0.1 } }, stubEmbedder(MODEL, near(1, 1)));
      const portland = await place(a, MODEL, "I live in Portland", "2026-03-02T12:00:00Z", near(1, 1));
      const denver = await place(a, MODEL, "I live in Denver", "2026-09-14T12:00:00Z", near(0.748, 2));
      const kayak = await place(a, MODEL, "Owns a red kayak", "2026-01-01T12:00:00Z", near(0, 3));
      const full = await hybridSearch(ctx, "kayak", { limit: 2 });
      expect(full.map((h) => h.memory.id)).toEqual([portland.id, denver.id]);
      expect(full.map((h) => h.memory.id)).not.toContain(kayak.id);
      expect((await hybridSearch(ctx, "kayak", { limit: 1 })).map((h) => h.memory.id)).toEqual([portland.id]);
    });
  });

  it("never pulls on identical timestamps or from a memory without a stored vector", async () => {
    await inAgent(async (a) => {
      const { ctx, s } = context(a, { model: MODEL, vectorFloor: { absolute: 0.95, relative: 0.1 } }, stubEmbedder(MODEL, near(1, 1)));
      const one = await place(a, MODEL, "Fact one", "2026-03-02T12:00:00Z", near(1, 1));
      await place(a, MODEL, "Fact two", "2026-03-02T12:00:00Z", near(0.9, 2));
      expect((await hybridSearch(ctx, "zzz", { limit: 8 })).map((h) => h.memory.id)).toEqual([one.id]);

      const pending = s.memories.create({ content: "Kayak pending", category: "fact" });
      setUpdated(a, pending.id, "2026-01-01T00:00:00Z");
      expect((await hybridSearch(ctx, "Kayak", { limit: 8 })).map((h) => h.memory.id)).toEqual([one.id, pending.id]);
    });
  });
  it("uses 0.57 for bge-m3 and 0.70 for every other model", async () => {
    expect(newerDuplicateCosine(M3)).toBe(0.57);
    expect(newerDuplicateCosine(MODEL)).toBe(NEWER_DUPLICATE_COSINE);
    expect(newerDuplicateCosine(new MockEmbedder().model)).toBe(0.7);
    const cases: [string, number, number, boolean][] = [
      [M3, 1024, 0.58, true],
      [M3, 1024, 0.55, false],
      [MODEL, EMBEDDING_DIMS, 0.58, false],
      [MODEL, EMBEDDING_DIMS, 0.71, true],
    ];
    for (const [model, dims, cos, pulls] of cases) {
      await inAgent(async (a) => {
        const { ctx } = context(a, { model, vectorFloor: { absolute: 0.95, relative: 0.1 } }, stubEmbedder(model, near(1, 1, dims)));
        const old = await place(a, model, "Old fact", "2026-03-02T12:00:00Z", near(1, 1, dims));
        const newer = await place(a, model, "New fact", "2026-09-14T12:00:00Z", near(cos, 2, dims));
        const ids = (await hybridSearch(ctx, "zzz", { limit: 8 })).map((h) => h.memory.id);
        expect(ids, `${model} at ${cos}`).toEqual(pulls ? [old.id, newer.id] : [old.id]);
      });
    }
  });

  it("never scores or pulls in rows of another model or size, and re-embeds them for the configured model", async () => {
    await inAgent(async (a) => {
      const patch = { model: M3, vectorFloor: { absolute: 0.5, relative: 0.5 } };
      const { ctx, s } = context(a, patch, stubEmbedder(M3, near(1, 1, 1024)));
      const current = await place(a, M3, "Current fact", "2026-03-02T12:00:00Z", near(1, 1, 1024));
      const oldModel = await place(a, MODEL, "Old model fact", "2026-09-14T12:00:00Z", near(1, 1, 1024));
      const oldSize = await place(a, M3, "Wrong size fact", "2026-09-15T12:00:00Z", near(1, 1, 768));
      const hits = await hybridSearch(ctx, "zzz", { limit: 8 });
      expect(hits.map((h) => h.memory.id)).toEqual([current.id]);

      expect(pullInNewer({ ...ctx, embedder: null }, hits, 8).map((h) => h.memory.id)).toEqual([current.id]);

      const report = await runIndexer(ctx);
      expect(report.embedded).toBe(2);
      const rows = s.db.all<{ memory_id: string; model: string; dims: number }>(
        `SELECT memory_id, model, dims FROM tal_semantic_vectors ORDER BY memory_id`,
      );
      expect(rows).toEqual(
        [current.id, oldModel.id, oldSize.id].sort().map((memory_id) => ({ memory_id, model: M3, dims: 1024 })),
      );
      const after = (await hybridSearch(ctx, "zzz", { limit: 8 })).map((h) => h.memory.id);
      expect(after).toEqual(expect.arrayContaining([current.id, oldModel.id, oldSize.id]));
    });
  });

});

describe("top-k vector fallback", () => {
  const M3 = "@cf/baai/bge-m3";
  const TENNIS = "Can I play tennis like a regular person?";
  const toolCtx = (a: TalorysAgent): ToolContext => ({ services: a.services, timezone: "UTC", mode: "chat" });
  const vectorIds = (hits: { memory: Memory; cosine: number | null }[]) => hits.filter((h) => h.cosine !== null).map((h) => h.memory.id);

  it("defaults to a 0.40 backstop and fills to four", () => {
    expect(FALLBACK_K).toBe(4);
    expect(DEFAULT_SEMANTIC_CONFIG.vectorFloor.backstop).toBe(0.4);
  });

  it("recalls a lone memory under the floor but above the backstop, on the prompt path and in search_memories", async () => {
    await inAgent(async (a) => {
      const { ctx } = context(a, { model: M3 }, stubEmbedder(M3, near(1, 1, 1024)));
      const arm = await place(a, M3, "I only have one arm", "2026-10-01T12:00:00Z", near(0.427, 2, 1024));
      const hits = await hybridSearch(ctx, TENNIS, { limit: 8 });
      expect(hits.map((h) => h.memory.id)).toEqual([arm.id]);
      expect(hits[0]!.cosine).toBeCloseTo(0.427, 3);
      expect((await selectSemanticMemories(ctx, TENNIS)).map((m) => m.id)).toEqual([arm.id]);
      const tool = semanticTools(ctx).find((x) => x.name === "search_memories")! as ImmediateTool;
      const result = (await tool.execute({ query: TENNIS }, toolCtx(a))) as { memories: { id: string }[] };
      expect(result.memories.map((m) => m.id)).toEqual([arm.id]);
    });
  });

  it("leaves a memory under the backstop out", async () => {
    await inAgent(async (a) => {
      const { ctx } = context(a, { model: M3 }, stubEmbedder(M3, near(1, 1, 1024)));
      await place(a, M3, "Paris trip notes", "2026-10-01T12:00:00Z", near(0.384, 2, 1024));
      const query = "what's the capital of France?";
      expect(await hybridSearch(ctx, query, { limit: 8 })).toEqual([]);
      expect(await selectSemanticMemories(ctx, query)).toEqual([]);
      const tool = semanticTools(ctx).find((x) => x.name === "search_memories")! as ImmediateTool;
      const result = (await tool.execute({ query }, toolCtx(a))) as { memories: { id: string }[] };
      expect(result.memories).toEqual([]);
    });
  });

  it("fills the mountain question to four vector hits best first, so heights is in and knee is not", async () => {
    await inAgent(async (a) => {
      const { ctx } = context(a, { model: M3 }, stubEmbedder(M3, near(1, 1, 1024)));
      const iso = "2026-10-01T12:00:00Z";
      const boss = await place(a, M3, "My boss is coming over Saturday", iso, near(0.66, 2, 1024));
      const heights = await place(a, M3, "I'm afraid of heights", iso, near(0.512, 3, 1024));
      const knee = await place(a, M3, "My knee surgery was in August", iso, near(0.409, 4, 1024));
      const d1 = await place(a, M3, "I collect vinyl records", iso, near(0.53, 5, 1024));
      const d2 = await place(a, M3, "My sister lives in Ohio", iso, near(0.52, 6, 1024));
      const hits = await hybridSearch(ctx, "zzz", { limit: 8 });
      expect(vectorIds(hits)).toEqual([boss.id, d1.id, d2.id, heights.id]);
      expect(hits.map((h) => h.memory.id)).not.toContain(knee.id);
    });
  });

  it("adds no fallback when four or more hits clear the floors", async () => {
    await inAgent(async (a) => {
      const { ctx } = context(a, { model: M3 }, stubEmbedder(M3, near(1, 1, 1024)));
      const iso = "2026-10-01T12:00:00Z";
      const floor = [];
      for (const [i, c] of [0.9, 0.88, 0.86, 0.85].entries()) floor.push(await place(a, M3, `Floor fact ${i}`, iso, near(c, i + 2, 1024)));
      const below = await place(a, M3, "Below the floor", iso, near(0.5, 9, 1024));
      const hits = await hybridSearch(ctx, "zzz", { limit: 8 });
      expect(vectorIds(hits)).toEqual(floor.map((m) => m.id));
      expect(hits.map((h) => h.memory.id)).not.toContain(below.id);
    });
  });

  it("breaks cosine ties by the newer update, then the lower id", async () => {
    await inAgent(async (a) => {
      const { ctx } = context(a, { model: M3 }, stubEmbedder(M3, near(1, 1, 1024)));
      const older = await place(a, M3, "Older tie", "2026-01-01T00:00:00Z", near(0.45, 2, 1024));
      const newer = await place(a, M3, "Newer tie", "2026-06-01T00:00:00Z", near(0.45, 3, 1024));
      expect(vectorIds(await hybridSearch(ctx, "zzz", { limit: 8 }))).toEqual([newer.id, older.id]);
    });
  });

  it("never lets the prompt list exceed eight memories", async () => {
    await inAgent(async (a) => {
      const { ctx, s } = context(a, { model: M3 }, stubEmbedder(M3, near(1, 1, 1024)));
      const iso = "2026-10-01T12:00:00Z";
      for (let i = 0; i < 2; i++) await place(a, M3, `Floor fact ${i}`, iso, near(0.6 + i * 0.01, i + 2, 1024));
      for (let i = 0; i < 6; i++) await place(a, M3, `Fallback fact ${i}`, iso, near(0.45 + i * 0.01, i + 4, 1024));
      for (let i = 0; i < 6; i++) s.memories.create({ content: `Preference ${i}`, category: "preference" });
      const query = near(1, 1, 1024);
      ctx.embedder = { model: M3, dims: 1024, embed: async (texts) => texts.map((t) => (t === "zzz" ? query : near(0, 20, 1024))) };
      const selected = (await selectSemanticMemories(ctx, "zzz")).filter((m) => m.content !== NEWER_WINS_NOTE);
      expect(selected.filter((m) => m.content.includes("fact"))).toHaveLength(FALLBACK_K);
      expect(selected).toHaveLength(MAX_RELEVANT_MEMORIES);
    });
  });
});

describe("selectSemanticMemories", () => {
  it("indexes lazily, pads with preferences and applies M1", async () => {
    await inAgent(async (a) => {
      const { ctx, s } = context(a);
      s.settings.update({ timezone: "America/Los_Angeles" });
      try {
        const tesla = s.memories.create({ content: "Drives a Tesla Model 3", category: "fact" });
        const pref = s.memories.create({ content: "Prefers window seats", category: "preference" });
        s.memories.create({ content: "Capital of France is Paris", category: "fact" });
        setUpdated(a, tesla.id, "2026-10-01T12:00:00Z");
        setUpdated(a, pref.id, "2026-10-11T06:30:00Z");

        const selected = await selectSemanticMemories(ctx, "my vehicle");
        expect(s.db.one<{ n: number }>(`SELECT count(*) AS n FROM tal_semantic_vectors`)!.n).toBe(3);
        expect(selected.map((m) => m.content)).toEqual([
          "(saved 2026-10-10 23:30 PDT) Prefers window seats",
          "(saved 2026-10-01 05:00 PDT) Drives a Tesla Model 3",
          NEWER_WINS_NOTE,
        ]);
        expect(s.memories.get(tesla.id)!.content).toBe("Drives a Tesla Model 3");
      } finally {
        s.settings.update({ timezone: "UTC" });
      }
    });
  });

  it("keeps the newer-wins note last and undated after timed prefixes", async () => {
    await inAgent(async (a) => {
      const { ctx, s } = context(a, {}, null);
      const bug = s.memories.create({ content: "My car is a Volkswagen bug from the 1960s.", category: "fact" });
      const tesla = s.memories.create({ content: "I just traded my VW bug away and got a 2025 Tesla.", category: "fact" });
      setUpdated(a, bug.id, "2026-10-11T03:30:17Z");
      setUpdated(a, tesla.id, "2026-10-11T03:31:34Z");

      const selected = await selectSemanticMemories(ctx, "VW bug");
      expect(selected.map((m) => m.content)).toEqual([
        "(saved 2026-10-11 03:31 UTC) I just traded my VW bug away and got a 2025 Tesla.",
        "(saved 2026-10-11 03:30 UTC) My car is a Volkswagen bug from the 1960s.",
        NEWER_WINS_NOTE,
      ]);
      expect(selected.at(-1)!.content).not.toContain("(saved ");
    });
  });

  it("selects at most eight memories and does not duplicate a padded preference", async () => {
    await inAgent(async (a) => {
      const { ctx, s } = context(a, {}, null);
      for (let i = 0; i < 10; i++) s.memories.create({ content: `Hiking spot number ${i}`, category: "fact" });
      s.memories.create({ content: "Prefers hiking at dawn", category: "preference" });
      const selected = await selectSemanticMemories(ctx, "hiking");
      expect(selected).toHaveLength(MAX_RELEVANT_MEMORIES + 1);
      expect(new Set(selected.slice(0, -1).map((m) => m.id)).size).toBe(MAX_RELEVANT_MEMORIES);
      expect(selected.at(-1)!.content).toBe(NEWER_WINS_NOTE);

      s.memories.clear();
      s.memories.create({ content: "Hiking spot number 1", category: "fact" });
      const p = s.memories.create({ content: "Prefers hiking at dawn", category: "preference" });
      const few = await selectSemanticMemories(ctx, "hiking");
      expect(few.filter((m) => m.id === p.id)).toHaveLength(1);
      expect(few).toHaveLength(3);
    });
  });

  it("appends the undated newer-wins note last only after two or more memories", async () => {
    await inAgent(async (a) => {
      const { ctx, s } = context(a, {}, null);
      expect(await selectSemanticMemories(ctx, "hiking")).toEqual([]);

      s.memories.create({ content: "Hiking spot number 1", category: "fact" });
      const one = await selectSemanticMemories(ctx, "hiking");
      expect(one).toHaveLength(1);
      expect(one.map((m) => m.content)).not.toContain(NEWER_WINS_NOTE);

      s.memories.create({ content: "Hiking spot number 2", category: "fact" });
      const two = await selectSemanticMemories(ctx, "hiking");
      expect(two).toHaveLength(3);
      expect(two.at(-1)).toMatchObject({ content: NEWER_WINS_NOTE, category: "other" });
      expect(two.filter((m) => m.content === NEWER_WINS_NOTE)).toHaveLength(1);
      expect(s.memories.count()).toBe(2);
    });
  });

  it("keeps the note within twenty tokens", () => {
    expect(estimateTokens(NEWER_WINS_NOTE)).toBeLessThanOrEqual(20);
  });
});

// The test pool runs with TALORYS_ENV=development and TALORYS_MOCK_AI=1, so recall embeds with the mock.
const workerEnv = env as unknown as Env;

interface GoldenCase {
  id: string;
  gate: boolean;
  enabled: boolean;
  categoryVariants?: MemoryCategory[];
  memories: Pick<Memory, "content" | "category" | "source" | "created_at" | "updated_at">[];
  query: string;
  expect: { present: string[]; order?: string[]; datePrefix?: boolean; noVectorHits?: boolean };
}

const cases = golden.cases as GoldenCase[];

/** Clears memories and semantic state, pins the owner timezone to UTC and seeds `memories` with their timestamps. */
function seed(s: Services, memories: GoldenCase["memories"], enabled: boolean) {
  dropSemanticData(s.db);
  deleteSemanticConfig(s.settings);
  s.memories.clear();
  s.settings.update({ timezone: "UTC" });
  memories.forEach((m, i) => {
    s.db.run(
      `INSERT INTO tal_memories (id, content, category, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      `golden-${i}`, m.content, m.category, m.source, m.created_at, m.updated_at,
    );
  });
  if (enabled) writeSemanticConfig(s.settings, { enabled: true }, s.db);
  invalidateSemanticCache(s);
}

/** The memory lines `buildSystemPrompt` renders for `memories`, as `- [category] content`. */
function memoryBlock(memories: Memory[]): string[] {
  const prompt = buildSystemPrompt({ agentName: "Talorys", timezone: "UTC", now: new Date(0), autoMemory: false, memories });
  return prompt.split("\n").filter((l) => l.startsWith("- ["));
}

const lineFor = (lines: string[], needle: string) => lines.findIndex((l) => l.includes(needle));

const NOTE_LINE = `- [other] ${NEWER_WINS_NOTE}`;

/** Enabled blocks end with the newer-wins note once two or more memories are listed, and never carry it otherwise. */
function assertNote(c: GoldenCase, lines: string[]) {
  const memoryLines = lines.filter((l) => l !== NOTE_LINE);
  if (memoryLines.length >= 2) {
    expect(lines.at(-1), `${c.id}: newer-wins note is not the last line`).toBe(NOTE_LINE);
    expect(lines.length).toBe(memoryLines.length + 1);
  } else {
    expect(lines).not.toContain(NOTE_LINE);
  }
}

/** Replays one enabled case and returns the rendered memory block plus the vector hits of the query. */
async function replay(c: GoldenCase, memories: GoldenCase["memories"]) {
  return inAgent(async (a) => {
    const s = a.services;
    seed(s, memories, true);
    const ext = semanticExtensions(s, workerEnv);
    expect(ext).toBeDefined();
    const lines = memoryBlock(await ext!.selectMemories(c.query));
    const ctx = createSemanticContext(s, workerEnv, readSemanticConfig(s.settings, s.db)!);
    const vectorHits = (await hybridSearch(ctx, c.query, { limit: 50 })).filter((h) => h.cosine !== null);
    return { lines, vectorHits };
  });
}

function assertBlock(c: GoldenCase, memories: GoldenCase["memories"], lines: string[]) {
  for (const needle of c.expect.present) {
    expect(lineFor(lines, needle), `${c.id}: "${needle}" missing from\n${lines.join("\n")}`).toBeGreaterThanOrEqual(0);
  }
  const order = c.expect.order ?? [];
  for (let i = 1; i < order.length; i++) {
    expect(lineFor(lines, order[i - 1]!), `${c.id}: "${order[i - 1]}" not before "${order[i]}"`).toBeLessThan(lineFor(lines, order[i]!));
  }
  if (!c.expect.datePrefix) return;
  for (const needle of c.expect.present) {
    // The prefix is the updated_at minute in the owner's timezone (UTC here), never created_at.
    const seeded = memories.find((m) => m.content.includes(needle))!;
    const line = lines[lineFor(lines, needle)]!;
    const saved = `${seeded.updated_at.slice(0, 10)} ${seeded.updated_at.slice(11, 16)} UTC`;
    expect(line).toBe(`- [${seeded.category}] (saved ${saved}) ${seeded.content}`);
    expect(line).toMatch(/^- \[\w+\] \(saved \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\) /);
  }
}

/** A provider that records each request and replies with fixed text. */
class RecordingProvider implements AIProvider {
  readonly id = "recording";
  calls: ToolRequest[] = [];
  async generate(_req: GenerateRequest) {
    return { text: "summary", usage: { inputTokens: 1, outputTokens: 1 } };
  }
  async *stream(req: GenerateRequest): AsyncIterable<AgentEvent> {
    yield* this.generateWithTools({ ...req, tools: [], maxIterations: 1, toolBudgetExhausted: () => true });
  }
  async *generateWithTools(req: ToolRequest): AsyncIterable<AgentEvent> {
    this.calls.push(req);
    yield { type: "text", delta: "Hello." };
    yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
  }
}

async function chatOnce(runner: AgentRunner, message: string) {
  for await (const _ of runner.chat({ message, signal: new AbortController().signal })) {
    // drain
  }
}

describe("golden recall replay", () => {
  it("holds eight cases with S-mountain informational only", () => {
    expect(cases).toHaveLength(8);
    expect(cases.find((c) => c.id === "S-mountain")?.gate).toBe(false);
  });

  for (const c of cases.filter((c) => c.gate && c.enabled)) {
    const variants = c.categoryVariants ?? [null];
    for (const category of variants) {
      const label = category ? `${c.id} (${category})` : c.id;
      it(`${label}: memory block matches the golden expectation`, async () => {
        // A category variant recategorises the case's first memory, the one under test.
        const memories = category ? c.memories.map((m, i) => (i === 0 ? { ...m, category } : m)) : c.memories;
        const { lines, vectorHits } = await replay(c, memories);
        assertBlock(c, memories, lines);
        assertNote(c, lines);
        if (c.expect.noVectorHits) expect(vectorHits, `${c.id}: vector hits passed the floor`).toEqual([]);
      });
    }
  }

  it("S-off: memories, tools and system prompt are upstream's", async () => {
    const c = cases.find((x) => x.id === "S-off")!;
    await inAgent(async (a) => {
      const s = a.services;
      seed(s, c.memories, false);
      const ext = semanticExtensions(s, workerEnv);
      expect(ext).toBeUndefined();

      const expected = memoryBlock(selectRelevantMemories(s.memories, c.query));
      assertBlock(c, c.memories, expected);
      for (const line of expected) expect(line).not.toContain("(saved ");
      expect(expected).not.toContain(NOTE_LINE);

      const upstream = new RecordingProvider();
      const hooked = new RecordingProvider();
      await chatOnce(new AgentRunner(s, upstream), c.query);
      await chatOnce(new AgentRunner(s, hooked, ext), c.query);
      expect(hooked.calls[0]!.system).toBe(upstream.calls[0]!.system);
      expect(hooked.calls[0]!.system).toContain(expected.join("\n"));
      expect(hooked.calls[0]!.tools.map((t) => t.name)).toEqual(ALL_TOOLS.map((t) => t.name));
    });
  });

  it("S-mountain: logs the selection without asserting it", async () => {
    const c = cases.find((x) => x.id === "S-mountain")!;
    const { lines, vectorHits } = await replay(c, c.memories);
    console.info(`[golden] S-mountain (gate: false) selected:\n${lines.join("\n") || "(none)"}\nvector hits: ${vectorHits.length}`);
  });
});

describe("semanticNeighbors", () => {
  it("returns nothing while semantic recall was never enabled", async () => {
    await inAgent(async (a) => {
      const s = a.services;
      dropSemanticData(s.db);
      deleteSemanticConfig(s.settings);
      invalidateSemanticCache(s);
      s.memories.clear();
      const m = s.memories.create({ content: "I live in Lisbon", category: "fact" });
      s.memories.create({ content: "I live in Porto", category: "fact" });
      expect(await semanticNeighbors(s, workerEnv, m, { minCosine: -1, limit: 10, exclude: new Set() })).toEqual([]);
    });
  });

  it("ranks other memories by cosine, best first, without the memory itself", async () => {
    await inAgent(async (a) => {
      const s = a.services;
      dropSemanticData(s.db);
      deleteSemanticConfig(s.settings);
      s.memories.clear();
      writeSemanticConfig(s.settings, { enabled: true }, s.db);
      invalidateSemanticCache(s);
      const others = [
        s.memories.create({ content: "I live in Porto", category: "fact" }),
        s.memories.create({ content: "My favourite colour is green", category: "preference" }),
        s.memories.create({ content: "The dog is called Rex", category: "fact" }),
      ];
      // Neighbors are older memories, so the target is created last.
      const m = s.memories.create({ content: "I live in Lisbon", category: "fact" });
      await runIndexer(createSemanticContext(s, workerEnv, readSemanticConfig(s.settings, s.db)!));
      const out = await semanticNeighbors(s, workerEnv, m, { minCosine: -1, limit: 10, exclude: new Set() });
      expect(out.map((n) => n.id).sort()).toEqual(others.map((o) => o.id).sort());
      expect(out.some((n) => n.id === m.id)).toBe(false);
      for (let i = 1; i < out.length; i++) expect(out[i]!.cosine).toBeLessThanOrEqual(out[i - 1]!.cosine);
    });
  });
});

describe("PR #22 review", () => {
  const options = () => ({ minCosine: -1, limit: 100, exclude: new Set<string>() });

  function enabled(a: TalorysAgent) {
    const s = a.services;
    dropSemanticData(s.db);
    deleteSemanticConfig(s.settings);
    s.memories.clear();
    writeSemanticConfig(s.settings, { enabled: true, maxEmbeddingsPerDay: 10_000 }, s.db);
    invalidateSemanticCache(s);
    return { s, ctx: createSemanticContext(s, workerEnv, readSemanticConfig(s.settings, s.db)!) };
  }

  it("#1 neighbors of an edited memory use its current text, not a stale vector", async () => {
    await inAgent(async (a) => {
      const { s, ctx } = enabled(a);
      const x = s.memories.create({ content: "I drive a Tesla", category: "fact" });
      const y = s.memories.create({ content: "My car is a VW", category: "fact" });
      const p = s.memories.create({ content: "I live in Portland", category: "fact" });
      for (let i = 0; i < 5 && (await pendingMemories(s.db, ctx.embedder!.model)).length; i++) await runIndexer(ctx);
      expect(await pendingMemories(s.db, ctx.embedder!.model)).toHaveLength(0);
      for (let i = 0; i < 55; i++) s.memories.create({ content: `Unrelated note ${i} about topic ${i * 7}`, category: "fact" });
      const edited = s.memories.update(x.id, { content: "I live in Denver" });
      s.memories.update(y.id, { content: "The dog is called Rex" });

      const ids = (await semanticNeighbors(s, workerEnv, edited, options())).map((n) => n.id);
      expect(ids).toContain(p.id);
      expect(ids).not.toContain(y.id);
      for (const id of ids) expect(id).not.toBe(x.id);
    });
  });

  it("#7 finding neighbors embeds only the saved memory, not the whole backlog", async () => {
    await inAgent(async (a) => {
      const { s, ctx } = enabled(a);
      for (let i = 0; i < 60; i++) s.memories.create({ content: `Backlog memory ${i} about subject ${i * 3}`, category: "fact" });
      const saved = s.memories.create({ content: "I live in Lisbon", category: "fact" });
      const day = UsageService.day();
      const before = embeddingsToday(s.db, day);
      const digest = vi.spyOn(crypto.subtle, "digest");
      try {
        await semanticNeighbors(s, workerEnv, saved, options());
        expect(digest.mock.calls.length).toBeLessThan(10);
      } finally {
        digest.mockRestore();
      }
      expect(embeddingsToday(s.db, day)).toBe(before + 1);
      expect((await pendingMemories(s.db, ctx.embedder!.model)).length).toBeGreaterThanOrEqual(60);
    });
  });

  it("parallel saves cannot pass the daily embedding cap when finding neighbors", async () => {
    await inAgent(async (a) => {
      const { s, ctx } = enabled(a);
      const day = UsageService.day();
      const cap = embeddingsToday(s.db, day) + 1;
      writeSemanticConfig(s.settings, { enabled: true, maxEmbeddingsPerDay: cap }, s.db);
      invalidateSemanticCache(s);
      const saved = Array.from({ length: 6 }, (_, i) => s.memories.create({ content: `I live in town number ${i}`, category: "fact" }));
      let release!: () => void;
      const opened = new Promise<void>((resolve) => (release = resolve));
      // Spy on the class of the embedder the code actually uses (mock or Workers AI), not on the mock.
      const proto = Object.getPrototypeOf(ctx.embedder!) as Embedder;
      const original = proto.embed;
      let calls = 0;
      const embed = vi.spyOn(proto, "embed").mockImplementation(async function (this: Embedder, texts: string[]) {
        calls++;
        await opened;
        return original.call(this, texts);
      });
      try {
        const runs = saved.map((m) => semanticNeighbors(s, workerEnv, m, options()));
        await new Promise((resolve) => setTimeout(resolve, 20));
        release();
        await Promise.all(runs);
      } finally {
        embed.mockRestore();
      }
      expect(calls).toBe(1);
      expect(embeddingsToday(s.db, day)).toBe(cap);
    });
  });
});
