/// <reference types="vite/client" />
import type { Memory } from "@talorys/shared";
import { describe, expect, it, vi } from "vitest";
import { inAgent, loggedIn } from "./helpers";
import golden from "./fixtures/recall-golden.json";
import { invalidateSemanticCache } from "../src/semantic";
import {
  DEFAULT_SEMANTIC_CONFIG,
  deleteSemanticConfig,
  writeSemanticConfig,
  SEMANTIC_CONFIG_KEY,
} from "../src/semantic/config";
import {
  type Embedder,
  MockEmbedder,
  contentHash,
  cosine,
  decodeVector,
  embeddingText,
  encodeVector,
} from "../src/semantic/embeddings";
import { pendingMemories, purgeOrphans, purgeVector, runIndexer } from "../src/semantic/indexer";
import {
  SEMANTIC_MIGRATIONS,
  dropSemanticData,
  ensureSemanticSchema,
  semanticSchema,
  semanticTableNames,
} from "../src/semantic/migrations";
import { type SemanticContext, hybridSearch } from "../src/semantic/recall";
import { cachedVectors, convertLegacyVectors, dot, normalize } from "../src/semantic/vectorStore";
import type { Services } from "../src/services/container";
import type { TalorysAgent } from "../src/agent/talorys-agent";
import { MIGRATIONS } from "../src/db/migrations";

const MOCK_MODEL = "mock-bge-384";
const MOCK_DIMS = 384;

/** Clears memories, semantic data and config. */
function reset(s: Services) {
  dropSemanticData(s.db);
  deleteSemanticConfig(s.settings);
  invalidateSemanticCache(s);
  s.memories.clear();
}

/** The mock embedder with each vector scaled by a per-text factor, so stored raw vectors are not unit-length. */
class ScaledEmbedder implements Embedder {
  readonly model = MOCK_MODEL;
  readonly dims = MOCK_DIMS;
  private readonly inner = new MockEmbedder();
  async embed(texts: string[]): Promise<Float32Array[]> {
    const vectors = await this.inner.embed(texts);
    return vectors.map((v, i) => v.map((x) => x * (0.25 + (texts[i]!.length % 11) * 0.5)));
  }
}

function context(s: Services, embedder: Embedder): SemanticContext {
  return { db: s.db, services: s, embedder, config: { ...DEFAULT_SEMANTIC_CONFIG, enabled: true, maxEmbeddingsPerDay: 100_000 } };
}

/** A raw (not unit-length) vector with a few non-zero coordinates. */
function raw(seed: number, dims = MOCK_DIMS): Float32Array {
  const v = new Float32Array(dims);
  for (let i = 0; i < 6; i++) v[(seed * 7 + i * 13) % dims] = (i + 1) * (seed + 2) * 0.37;
  return v;
}

/** Builds a slim v1 store: the v1 table holding base64 TEXT vectors for the given memories. */
async function v1Store(s: Services, memories: Memory[]) {
  ensureSemanticSchema(s.db, SEMANTIC_MIGRATIONS.slice(0, 1));
  expect(semanticSchema(s.db)).toEqual({ track: "slim", version: 1 });
  const rows = [];
  for (const [i, m] of memories.entries()) {
    const row = {
      memory_id: m.id,
      model: MOCK_MODEL,
      dims: MOCK_DIMS,
      content_hash: await contentHash(embeddingText(m)),
      vector: encodeVector(raw(i)),
      updated_at: `2026-10-0${i + 1}T12:00:00.000Z`,
    };
    s.db.run(
      `INSERT INTO tal_semantic_vectors (memory_id, model, dims, content_hash, vector, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      row.memory_id, row.model, row.dims, row.content_hash, row.vector, row.updated_at,
    );
    rows.push(row);
  }
  return rows;
}

const storedRows = (s: Services) =>
  s.db.all<{ memory_id: string; model: string; dims: number; content_hash: string; vector: ArrayBuffer | string; updated_at: string; kind: string }>(
    `SELECT memory_id, model, dims, content_hash, vector, updated_at, typeof(vector) AS kind FROM tal_semantic_vectors ORDER BY memory_id`,
  );

/** Little-endian Float32 values of a BLOB. */
function fromBlob(buffer: ArrayBuffer): Float32Array {
  const view = new DataView(buffer);
  return Float32Array.from({ length: buffer.byteLength / 4 }, (_, i) => view.getFloat32(i * 4, true));
}

const norm = (v: Float32Array) => Math.sqrt(dot(v, v));

function expectClose(a: Float32Array, b: Float32Array, tolerance = 1e-6) {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) expect(Math.abs(a[i]! - b[i]!)).toBeLessThan(tolerance);
}

describe("vector math", () => {
  it("normalize returns a unit copy and keeps a zero vector zero", () => {
    const v = raw(3);
    const u = normalize(v);
    expect(u).not.toBe(v);
    expect(norm(u)).toBeCloseTo(1, 6);
    expect(normalize(new Float32Array(8))).toEqual(new Float32Array(8));
    expect(normalize(new Float32Array([NaN, 1, 2]))).toEqual(new Float32Array(3));
    expect(normalize(new Float32Array([Infinity, 1, 2]))).toEqual(new Float32Array(3));
  });

  it("dot of unit vectors matches cosine of the raw ones, and is 0 for zero vectors or other lengths", () => {
    for (let i = 0; i < 10; i++) {
      const a = raw(i);
      const b = raw(i + 5);
      expect(Math.abs(dot(normalize(a), normalize(b)) - cosine(a, b))).toBeLessThan(1e-6);
    }
    expect(dot(normalize(new Float32Array(MOCK_DIMS)), normalize(raw(1)))).toBe(0);
    expect(dot(new Float32Array(3), new Float32Array(4))).toBe(0);
    expect(dot(new Float32Array([NaN, 1]), new Float32Array([1, 1]))).toBe(0);
  });
});

describe("slim migration v2", () => {
  it("converts base64 TEXT rows to unit little-endian Float32 BLOBs in place, idempotently, with nothing pending", async () => {
    await inAgent(async (a) => {
      const s = a.services;
      reset(s);
      const memories = ["I drive a Tesla", "I live in Denver", "Prefers window seats", "Allergic to cats"].map((content) =>
        s.memories.create({ content, category: "fact" }),
      );
      const before = await v1Store(s, memories);

      expect(ensureSemanticSchema(s.db)).toBe(3);
      expect(semanticSchema(s.db)).toEqual({ track: "slim", version: 3 });
      const after = storedRows(s);
      expect(after).toHaveLength(before.length);
      for (const row of after) {
        const was = before.find((b) => b.memory_id === row.memory_id)!;
        expect(row.kind).toBe("blob");
        expect({ ...row, vector: null, kind: null }).toEqual({ ...was, vector: null, kind: null });
        const vector = fromBlob(row.vector as ArrayBuffer);
        expect(norm(vector)).toBeCloseTo(1, 6);
        expectClose(vector, normalize(decodeVector(was.vector)));
      }
      expect(s.db.one<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE name = 'tal_semantic_vectors'`)!.sql).toContain("vector BLOB NOT NULL");
      expect(await pendingMemories(s.db, MOCK_MODEL, MOCK_DIMS)).toEqual([]);

      // Re-running changes nothing.
      const bytes = JSON.stringify(storedRows(s).map((r) => [...new Uint8Array(r.vector as ArrayBuffer)]));
      expect(ensureSemanticSchema(s.db)).toBe(3);
      expect(convertLegacyVectors(s.db)).toBe(0);
      expect(JSON.stringify(storedRows(s).map((r) => [...new Uint8Array(r.vector as ArrayBuffer)]))).toBe(bytes);
      reset(s);
    });
  });

  it("a converted store needs no embedding: recall reports nothing pending and the indexer embeds nothing", async () => {
    await inAgent(async (a) => {
      const s = a.services;
      reset(s);
      const memories = ["I drive a Tesla", "I live in Denver"].map((content) => s.memories.create({ content, category: "fact" }));
      await v1Store(s, memories);
      ensureSemanticSchema(s.db);
      const embedder = new MockEmbedder();
      const embed = vi.spyOn(embedder, "embed");
      const report = await runIndexer(context(s, embedder), { maxEmbed: 1000 });
      expect(report).toEqual({ embedded: 0, pending: 0, purged: 0 });
      expect(embed).not.toHaveBeenCalled();
      reset(s);
    });
  });

  it("migrates an empty v1 store", async () => {
    await inAgent((a) => {
      const s = a.services;
      reset(s);
      ensureSemanticSchema(s.db, SEMANTIC_MIGRATIONS.slice(0, 1));
      expect(ensureSemanticSchema(s.db)).toBe(3);
      expect(storedRows(s)).toEqual([]);
      reset(s);
    });
  });

  it("decodes and normalizes a legacy TEXT row inserted after the migration on load", async () => {
    await inAgent(async (a) => {
      const s = a.services;
      reset(s);
      const [m] = await v1Store(s, [s.memories.create({ content: "I drive a Tesla", category: "fact" })]);
      ensureSemanticSchema(s.db);
      const late = s.memories.create({ content: "Late legacy row", category: "fact" });
      s.db.run(
        `INSERT INTO tal_semantic_vectors (memory_id, model, dims, content_hash, vector, updated_at) VALUES (?, ?, ?, 'x', ?, 'now')`,
        late.id, MOCK_MODEL, MOCK_DIMS, encodeVector(raw(9)),
      );
      const vectors = cachedVectors(s.db, MOCK_MODEL, MOCK_DIMS);
      expectClose(vectors.get(late.id)!, normalize(raw(9)));
      expectClose(vectors.get(m!.memory_id)!, normalize(raw(0)));
      reset(s);
    });
  });
});

interface GoldenCase {
  id: string;
  enabled: boolean;
  memories: Pick<Memory, "content" | "category" | "source" | "created_at" | "updated_at">[];
  query: string;
}

/** Seeds a golden case, indexes it with `embedder` and runs hybrid recall. */
async function recall(a: TalorysAgent, c: GoldenCase, embedder: Embedder) {
  const s = a.services;
  reset(s);
  c.memories.forEach((m, i) => {
    s.db.run(
      `INSERT INTO tal_memories (id, content, category, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      `golden-${i}`, m.content, m.category, m.source, m.created_at, m.updated_at,
    );
  });
  writeSemanticConfig(s.settings, { enabled: true }, s.db);
  invalidateSemanticCache(s);
  const ctx = context(s, embedder);
  await runIndexer(ctx, { maxEmbed: 1000 });
  return hybridSearch(ctx, c.query, { limit: 50 });
}

describe("recall equivalence on the golden fixture", () => {
  for (const c of (golden.cases as GoldenCase[]).filter((x) => x.enabled)) {
    it(`${c.id}: same memories, same order, cosines within 1e-6 of the raw-vector cosine`, async () => {
      await inAgent(async (a) => {
        const reference = await recall(a, c, new MockEmbedder());
        const scaled = new ScaledEmbedder();
        const hits = await recall(a, c, scaled);
        expect(hits.map((h) => h.memory.id)).toEqual(reference.map((h) => h.memory.id));
        const [query] = await scaled.embed([c.query]);
        for (const [i, hit] of hits.entries()) {
          expect(hit.cosine === null).toBe(reference[i]!.cosine === null);
          if (hit.cosine === null) continue;
          const [stored] = await scaled.embed([embeddingText(hit.memory)]);
          expect(Math.abs(hit.cosine - cosine(query!, stored!))).toBeLessThan(1e-6);
          expect(Math.abs(hit.cosine - reference[i]!.cosine!)).toBeLessThan(1e-6);
        }
        reset(a.services);
      });
    });
  }

  it("a zero stored vector scores 0", async () => {
    await inAgent(async (a) => {
      const s = a.services;
      reset(s);
      const m = s.memories.create({ content: "zero", category: "fact" });
      const zero: Embedder = { model: MOCK_MODEL, dims: MOCK_DIMS, embed: async (t) => t.map(() => new Float32Array(MOCK_DIMS)) };
      const ctx = context(s, zero);
      await runIndexer(ctx, { maxEmbed: 1000 });
      expect(cachedVectors(s.db, MOCK_MODEL, MOCK_DIMS).get(m.id)).toEqual(new Float32Array(MOCK_DIMS));
      const q = normalize(raw(2));
      expect(dot(q, cachedVectors(s.db, MOCK_MODEL, MOCK_DIMS).get(m.id)!)).toBe(0);
      reset(s);
    });
  });
});

/** Vector-reading SQL issued through `db.all`. */
const vectorReads = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter(([sql]) => /SELECT memory_id, vector FROM tal_semantic_vectors/.test(String(sql))).length;

describe("vector cache", () => {
  /** Two indexed memories with an enabled config; returns their ids and the warm cache map. */
  async function warm(a: TalorysAgent) {
    const s = a.services;
    reset(s);
    writeSemanticConfig(s.settings, { enabled: true, maxEmbeddingsPerDay: 10_000 }, s.db);
    invalidateSemanticCache(s);
    const one = s.memories.create({ content: "I drive a Tesla", category: "fact" });
    const two = s.memories.create({ content: "I live in Denver", category: "fact" });
    const ctx = context(s, new MockEmbedder());
    await runIndexer(ctx, { maxEmbed: 1000 });
    const cache = cachedVectors(s.db, MOCK_MODEL, MOCK_DIMS);
    expect([...cache.keys()].sort()).toEqual([one.id, two.id].sort());
    return { s, ctx, one, two, cache };
  }

  it("recall and newer pull-in read vectors from the cache without vector SQL", async () => {
    await inAgent(async (a) => {
      const { s, ctx } = await warm(a);
      const all = vi.spyOn(s.db, "all");
      await hybridSearch(ctx, "what car do I drive", { limit: 8 });
      await hybridSearch(ctx, "where do I live", { limit: 8 });
      expect(vectorReads(all)).toBe(0);
      all.mockRestore();
      reset(s);
    });
  });

  it("an indexer upsert updates the cache in place", async () => {
    await inAgent(async (a) => {
      const { s, ctx, one, cache } = await warm(a);
      const three = s.memories.create({ content: "Allergic to cats", category: "fact" });
      s.memories.update(one.id, { content: "I drive a Porsche" });
      const all = vi.spyOn(s.db, "all");
      await runIndexer(ctx, { maxEmbed: 1000 });
      const after = cachedVectors(s.db, MOCK_MODEL, MOCK_DIMS);
      expect(after).toBe(cache);
      expect(vectorReads(all)).toBe(0);
      const [porsche, cats] = await new MockEmbedder().embed([embeddingText(s.memories.get(one.id)!), embeddingText(three)]);
      expectClose(after.get(one.id)!, normalize(porsche!));
      expectClose(after.get(three.id)!, normalize(cats!));
      all.mockRestore();
      reset(s);
    });
  });

  it("forgetting one memory and the orphan sweep remove its vector from the cache", async () => {
    await inAgent(async (a) => {
      const { s, one, two, cache } = await warm(a);
      purgeVector(s.db, one.id);
      expect(cache.has(one.id)).toBe(false);
      s.db.run(`DELETE FROM tal_memories WHERE id = ?`, two.id);
      expect(purgeOrphans(s.db)).toBe(1);
      expect(cache.size).toBe(0);
      expect(cachedVectors(s.db, MOCK_MODEL, MOCK_DIMS)).toBe(cache);
      reset(s);
    });
  });

  it("route writes keep the cache in step: delete one, Clear all, Reindex", async () => {
    const c = await loggedIn();
    const { one, cache } = await inAgent(async (a) => {
      const w = await warm(a);
      return { one: w.one, cache: w.cache };
    });
    expect((await c.call(`/api/memories/${one.id}`, { method: "DELETE" })).status).toBe(200);
    await inAgent((a) => {
      expect(cache.has(one.id)).toBe(false);
      expect(cachedVectors(a.services.db, MOCK_MODEL, MOCK_DIMS)).toBe(cache);
    });

    expect((await c.call("/api/semantic/reindex", { method: "POST" })).status).toBe(200);
    await inAgent((a) => {
      expect(cachedVectors(a.services.db, MOCK_MODEL, MOCK_DIMS)).toBe(cache);
      expect(cache.size).toBe(a.services.memories.count());
    });

    expect((await c.call("/api/memories", { method: "DELETE", body: { confirm: "DELETE" } })).status).toBe(200);
    await inAgent((a) => {
      expect(cache.size).toBe(0);
      expect(cachedVectors(a.services.db, MOCK_MODEL, MOCK_DIMS)).toBe(cache);
      reset(a.services);
    });
  });

  it("Delete semantic data and a model change drop the cache", async () => {
    const c = await loggedIn();
    const cache = await inAgent(async (a) => (await warm(a)).cache);
    expect((await c.call("/api/semantic/config", { method: "PUT", body: { model: "@cf/baai/bge-small-en-v1.5" } })).status).toBe(200);
    await inAgent(async (a) => {
      const fresh = cachedVectors(a.services.db, MOCK_MODEL, MOCK_DIMS);
      expect(fresh).not.toBe(cache);
    });

    const again = await inAgent(async (a) => (await warm(a)).cache);
    expect((await c.call("/api/semantic/data", { method: "DELETE", body: { confirm: "DELETE" } })).status).toBe(200);
    await inAgent((a) => {
      const s = a.services;
      const after = cachedVectors(s.db, MOCK_MODEL, MOCK_DIMS);
      expect(after).not.toBe(again);
      expect(after.size).toBe(0);
      reset(s);
    });
  });

  it("the row-count tripwire reloads after an out-of-band insert or delete", async () => {
    await inAgent(async (a) => {
      const { s, one, cache } = await warm(a);
      const extra = s.memories.create({ content: "Out of band", category: "fact" });
      s.db.run(
        `INSERT INTO tal_semantic_vectors (memory_id, model, dims, content_hash, vector, updated_at) VALUES (?, ?, ?, 'x', ?, 'now')`,
        extra.id, MOCK_MODEL, MOCK_DIMS, encodeVector(raw(4)),
      );
      const grown = cachedVectors(s.db, MOCK_MODEL, MOCK_DIMS);
      expect(grown).not.toBe(cache);
      expectClose(grown.get(extra.id)!, normalize(raw(4)));

      s.db.run(`DELETE FROM tal_semantic_vectors WHERE memory_id = ?`, one.id);
      const shrunk = cachedVectors(s.db, MOCK_MODEL, MOCK_DIMS);
      expect(shrunk).not.toBe(grown);
      expect(shrunk.has(one.id)).toBe(false);
      expect(cachedVectors(s.db, MOCK_MODEL, MOCK_DIMS)).toBe(shrunk);
      reset(s);
    });
  });
});

describe("single owner of tal_semantic_vectors", () => {
  const sources = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
  const V1_CREATE = "`CREATE TABLE IF NOT EXISTS tal_semantic_vectors (";

  it("no file but semantic/vectorStore.ts names the table outside comments (the v1 CREATE TABLE excepted)", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(20);
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(sources)) {
      if (path.endsWith("/semantic/vectorStore.ts")) continue;
      source.split("\n").forEach((line, i) => {
        if (!line.includes("tal_semantic_vectors")) return;
        const text = line.trim();
        if (/^(\/\/|\/\*|\*)/.test(text)) return;
        if (path.endsWith("/semantic/migrations.ts") && text.startsWith(V1_CREATE)) return;
        offenders.push(`${path}:${i + 1}: ${text}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

const SLIM_TABLES = ["tal_semantic_item_usage", "tal_semantic_item_vectors", "tal_semantic_schema", "tal_semantic_usage", "tal_semantic_vectors"];

/** Eight `tal_sem_*` tables this module does not own, with a v1 schema row. */
const OTHER_DDL = [
  `CREATE TABLE IF NOT EXISTS tal_sem_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, updated_at TEXT NOT NULL)`,
  `INSERT OR REPLACE INTO tal_sem_schema (id, version, updated_at) VALUES (1, 1, '2026-01-01T00:00:00Z')`,
  `CREATE TABLE IF NOT EXISTS tal_sem_vectors (memory_id TEXT PRIMARY KEY, model TEXT NOT NULL, dims INTEGER NOT NULL,
    content_hash TEXT NOT NULL, source_updated_at TEXT NOT NULL, vector BLOB NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS tal_sem_fts USING fts5(memory_id UNINDEXED, content, keywords)`,
  `INSERT INTO tal_sem_fts (memory_id, content, keywords) VALUES ('m1', 'Drives a Bug', '[]')`,
  `CREATE TABLE IF NOT EXISTS tal_sem_usage_daily (day TEXT PRIMARY KEY, embedding_requests INTEGER NOT NULL DEFAULT 0,
    embedded_tokens_estimate INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS tal_sem_slots (slot TEXT PRIMARY KEY, cardinality TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `INSERT OR IGNORE INTO tal_sem_slots (slot, cardinality, label, created_by, created_at) VALUES ('vehicle', 'multi', 'Vehicle', 'seed', '2026-01-01')`,
  `CREATE TABLE IF NOT EXISTS tal_sem_facts (memory_id TEXT PRIMARY KEY, slot TEXT, kind TEXT NOT NULL, status TEXT NOT NULL,
    valid_from TEXT NOT NULL, origin TEXT NOT NULL, recorded_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tal_sem_fact_events (id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, event TEXT NOT NULL,
    decided_by TEXT NOT NULL, origin TEXT NOT NULL, at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tal_sem_rebuild (id INTEGER PRIMARY KEY CHECK (id = 1), lexicon_version INTEGER NOT NULL,
    input_fingerprint TEXT NOT NULL, inferred_count INTEGER NOT NULL, rebuilt_at TEXT NOT NULL)`,
];

const OTHER_TABLES = [
  "tal_sem_fact_events",
  "tal_sem_facts",
  "tal_sem_fts",
  "tal_sem_rebuild",
  "tal_sem_schema",
  "tal_sem_slots",
  "tal_sem_usage_daily",
  "tal_sem_vectors",
];

function resetSemanticOnly(s: Services) {
  dropSemanticData(s.db);
  deleteSemanticConfig(s.settings);
  invalidateSemanticCache(s);
}

const allTables = (s: Services) =>
  s.db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).map((r) => r.name);

const memoryRows = (s: Services) => JSON.stringify(s.db.all(`SELECT * FROM tal_memories ORDER BY id`));

const otherSnapshot = (s: Services) => ({
  schema: s.db.all(`SELECT * FROM tal_sem_schema`),
  slots: s.db.all(`SELECT * FROM tal_sem_slots`),
  fts: s.db.all(`SELECT memory_id, content FROM tal_sem_fts`),
});

describe("semantic migrations", () => {
  it("no upstream table matches tal\\_sem%", async () => {
    const declared = MIGRATIONS.flatMap((m) =>
      m.statements.flatMap((sql) => [...sql.matchAll(/CREATE\s+(?:VIRTUAL\s+)?TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi)].map((x) => x[1]!)),
    );
    expect(declared).toContain("tal_sessions");
    expect(declared.filter((n) => n.startsWith("tal_sem"))).toEqual([]);
    await inAgent((agent) => {
      const s = agent.services;
      resetSemanticOnly(s);
      expect(semanticTableNames(s.db)).toEqual([]);
      for (const name of declared) expect(allTables(s)).toContain(name);
    });
  });

  it("migrates a fresh database to track slim v3", async () => {
    await inAgent((agent) => {
      const s = agent.services;
      resetSemanticOnly(s);
      expect(semanticSchema(s.db)).toBeNull();
      expect(ensureSemanticSchema(s.db)).toBe(SEMANTIC_MIGRATIONS.at(-1)!.version);
      expect(semanticSchema(s.db)).toEqual({ track: "slim", version: 3 });
      expect(semanticTableNames(s.db)).toEqual(SLIM_TABLES);
      // Idempotent.
      expect(ensureSemanticSchema(s.db)).toBe(3);
      expect(semanticTableNames(s.db)).toEqual(SLIM_TABLES);
      resetSemanticOnly(s);
    });
  });

  it("leaves other tal_sem_* tables untouched when migrating", async () => {
    await inAgent((agent) => {
      const s = agent.services;
      resetSemanticOnly(s);
      for (const sql of OTHER_DDL) s.db.run(sql);
      const before = otherSnapshot(s);
      expect(semanticTableNames(s.db)).toEqual(expect.arrayContaining(OTHER_TABLES));

      writeSemanticConfig(s.settings, { enabled: true }, s.db);
      invalidateSemanticCache(s);
      expect(semanticSchema(s.db)).toEqual({ track: "slim", version: 3 });
      expect(semanticTableNames(s.db)).toEqual(expect.arrayContaining([...OTHER_TABLES, ...SLIM_TABLES]));
      expect(otherSnapshot(s)).toEqual(before);
    });
  });

  it("Delete semantic data drops both sets, deletes the key and keeps memories byte-for-byte", async () => {
    const before = await inAgent((agent) => {
      const s = agent.services;
      s.memories.create({ content: "I drive a Tesla", category: "fact" });
      s.memories.create({ content: "Prefers window seats", category: "preference" });
      for (const sql of OTHER_DDL) s.db.run(sql);
      writeSemanticConfig(s.settings, { enabled: true }, s.db);
      invalidateSemanticCache(s);
      expect(semanticTableNames(s.db).length).toBeGreaterThanOrEqual(OTHER_TABLES.length + SLIM_TABLES.length);
      return { memories: memoryRows(s), upstream: allTables(s).filter((n) => !/^tal_sem/.test(n)) };
    });

    const c = await loggedIn();
    expect((await c.call("/api/semantic/data", { method: "DELETE", body: { confirm: "DELETE" } })).status).toBe(200);

    await inAgent((agent) => {
      const s = agent.services;
      expect(semanticTableNames(s.db)).toEqual([]);
      expect(s.db.one(`SELECT key FROM tal_settings WHERE key = ?`, SEMANTIC_CONFIG_KEY)).toBeNull();
      expect(memoryRows(s)).toBe(before.memories);
      expect(allTables(s)).toEqual(before.upstream);
    });
    expect(await c.json("/api/semantic/config")).toEqual({ config: null, ever_enabled: false });
  });
});
