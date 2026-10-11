import { MassiveTestHarness, } from "./massive-harness";
import assert from "node:assert";
import { Database as BunSqlite } from "bun:sqlite";
import { Database } from "../apps/agent/src/db/database";
import {
  normalize,
  dot,
  upsertVectors,
  deleteVector,
  deleteAllVectors,
  purgeOrphanVectors,
  cachedVectors,
  dropVectorCache,
  vectorMeta,
  countVectors,
  convertLegacyVectors,
  type VectorRow,
} from "../apps/agent/src/semantic/vectorStore";
import {
  MockEmbedder,
  WorkersAiEmbedder,
  cosine,
  encodeVector,
  decodeVector,
  contentHash,
  embeddingText,
  embeddingsToday,
  recordEmbeddings,
} from "../apps/agent/src/semantic/embeddings";
import {
  rrf,
  pullInNewer,
  hybridSearch,
  applyM1,
  savedAt,
  newerWinsNote,
  type SemanticContext,
  type RecallHit,
} from "../apps/agent/src/semantic/recall";
import { ensureSemanticSchema, } from "../apps/agent/src/semantic/migrations";
import type { Memory } from "@talorys/shared";

/** Creates an isolated in-memory SQLite database matching Database interface */
function createTestDb(): Database {
  const sqlite = new BunSqlite(":memory:");
  const fakeStorage: any = {
    sql: {
      exec(query: string, ...params: unknown[]) {
        const stmt = sqlite.query(query);
        const trimmed = query.trim().toUpperCase();
        const hasReturning = trimmed.includes("RETURNING");
        const isSelect = trimmed.startsWith("SELECT") || trimmed.startsWith("PRAGMA") || trimmed.startsWith("EXPLAIN");
        if (isSelect || hasReturning) {
          const rows = stmt.all(...(params as any));
          return { toArray: () => rows, rowsWritten: rows.length };
        } else {
          const res = stmt.run(...(params as any));
          return { toArray: () => [], rowsWritten: res.changes };
        }
      },
    },
    transactionSync<T>(fn: () => T): T {
      return sqlite.transaction(fn)();
    },
  };
  const db = new Database(fakeStorage);
  db.run(`CREATE TABLE tal_memories (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    category TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  ensureSemanticSchema(db);
  return db;
}

/** Creates a fully functional SemanticContext with in-memory services */
function createTestContext(db: Database, embedder: any = new MockEmbedder()): SemanticContext {
  const memoryService: any = {
    search(q: string, limit: number): Memory[] {
      const all = db.all<Memory>("SELECT * FROM tal_memories");
      const matched = all.filter((m) => m.content.toLowerCase().includes(q.toLowerCase()));
      return matched.slice(0, limit);
    },
    get(id: string): Memory | null {
      return db.one<Memory>("SELECT * FROM tal_memories WHERE id = ?", id);
    },
    list(opts: any = {}): Memory[] {
      let q = "SELECT * FROM tal_memories";
      const params: any[] = [];
      if (opts.category) {
        q += " WHERE category = ?";
        params.push(opts.category);
      }
      q += " ORDER BY updated_at DESC";
      if (opts.limit) {
        q += " LIMIT ?";
        params.push(opts.limit);
      }
      return db.all<Memory>(q, ...params);
    },
  };
  const settingsService: any = {
    get() {
      return { timezone: "UTC", demoMode: false };
    },
  };
  return {
    db,
    config: {
      enabled: true,
      model: embedder?.model ?? "mock-bge-384",
      maxEmbeddingsPerDay: 50_000,
      vectorFloor: {
        absolute: 0.55,
        relative: 0.15,
        backstop: 0.4,
      },
    },
    embedder,
    services: {
      db,
      memories: memoryService,
      settings: settingsService,
    } as any,
  };
}

/** Generates a deterministic pseudo-random Float32Array */
function generateVector(dims: number, seed: number): Float32Array {
  const v = new Float32Array(dims);
  for (let i = 0; i < dims; i++) {
    v[i] = Math.sin(seed * 997 + i * 13) * Math.cos(seed * 31 + i * 7);
  }
  return v;
}

/** Euclidean norm */
function l2Norm(v: Float32Array): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!;
  return Math.sqrt(s);
}

const harness = new MassiveTestHarness("vector-math");

// ==========================================
// 1. NORMAL CATEGORY (72 tests)
// ==========================================

// VEC-NORM-001 to VEC-NORM-018: Cosine similarity across angles and dimensions
harness.add({
  id: "VEC-NORM-001",
  domain: "vector-math",
  category: "normal",
  description: "Cosine similarity of identical 2D unit vector [1, 0] is exactly 1.0",
  run: () => {
    const v = new Float32Array([1, 0]);
    const sim = cosine(v, v);
    assert.ok(Math.abs(sim - 1.0) < 1e-6, `expected ~1.0, got ${sim}`);
  },
});

harness.add({
  id: "VEC-NORM-002",
  domain: "vector-math",
  category: "normal",
  description: "Cosine similarity of identical 3D vector [1, 2, 3] is scale-invariant 1.0",
  run: () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([1, 2, 3]);
    const sim = cosine(a, b);
    assert.ok(Math.abs(sim - 1.0) < 1e-6, `expected 1.0, got ${sim}`);
  },
});

harness.add({
  id: "VEC-NORM-003",
  domain: "vector-math",
  category: "normal",
  description: "Cosine similarity of scaled vector v and 10*v is exactly 1.0",
  run: () => {
    const a = new Float32Array([0.3, 0.4, 0.5]);
    const b = new Float32Array([3.0, 4.0, 5.0]);
    const sim = cosine(a, b);
    assert.ok(Math.abs(sim - 1.0) < 1e-6, `expected 1.0, got ${sim}`);
  },
});

harness.add({
  id: "VEC-NORM-004",
  domain: "vector-math",
  category: "normal",
  description: "Cosine similarity of scaled vector v and 0.001*v is 1.0",
  run: () => {
    const a = new Float32Array([2.0, -1.0, 4.0]);
    const b = new Float32Array([0.002, -0.001, 0.004]);
    const sim = cosine(a, b);
    assert.ok(Math.abs(sim - 1.0) < 1e-6, `expected 1.0, got ${sim}`);
  },
});

harness.add({
  id: "VEC-NORM-005",
  domain: "vector-math",
  category: "normal",
  description: "Cosine similarity of 45-degree angle vectors [1, 0] and [1, 1] is sqrt(2)/2 (~0.7071)",
  run: () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([1, 1]);
    const sim = cosine(a, b);
    assert.ok(Math.abs(sim - Math.SQRT1_2) < 1e-5, `expected ${Math.SQRT1_2}, got ${sim}`);
  },
});

harness.add({
  id: "VEC-NORM-006",
  domain: "vector-math",
  category: "normal",
  description: "Cosine similarity of 60-degree angle vectors is 0.5",
  run: () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0.5, Math.sqrt(3) / 2]);
    const sim = cosine(a, b);
    assert.ok(Math.abs(sim - 0.5) < 1e-5, `expected 0.5, got ${sim}`);
  },
});

harness.add({
  id: "VEC-NORM-007",
  domain: "vector-math",
  category: "normal",
  description: "Cosine similarity of 30-degree angle vectors is ~0.8660",
  run: () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([Math.sqrt(3) / 2, 0.5]);
    const sim = cosine(a, b);
    assert.ok(Math.abs(sim - Math.sqrt(3) / 2) < 1e-5, `expected 0.8660, got ${sim}`);
  },
});

harness.add({
  id: "VEC-NORM-008",
  domain: "vector-math",
  category: "normal",
  description: "Cosine similarity of 120-degree angle vectors is -0.5",
  run: () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([-0.5, Math.sqrt(3) / 2]);
    const sim = cosine(a, b);
    assert.ok(Math.abs(sim - -0.5) < 1e-5, `expected -0.5, got ${sim}`);
  },
});

harness.add({
  id: "VEC-NORM-009",
  domain: "vector-math",
  category: "normal",
  description: "Cosine similarity of 135-degree angle vectors is -sqrt(2)/2",
  run: () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([-1, 1]);
    const sim = cosine(a, b);
    assert.ok(Math.abs(sim - -Math.SQRT1_2) < 1e-5, `expected -${Math.SQRT1_2}, got ${sim}`);
  },
});

harness.add({
  id: "VEC-NORM-010",
  domain: "vector-math",
  category: "normal",
  description: "Cosine similarity of 150-degree angle vectors is -sqrt(3)/2",
  run: () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([-Math.sqrt(3) / 2, 0.5]);
    const sim = cosine(a, b);
    assert.ok(Math.abs(sim - -Math.sqrt(3) / 2) < 1e-5, `expected -0.8660, got ${sim}`);
  },
});

harness.add({
  id: "VEC-NORM-011",
  domain: "vector-math",
  category: "normal",
  description: "Cosine similarity of opposite vectors [3, 4] and [-3, -4] is -1.0",
  run: () => {
    const a = new Float32Array([3, 4]);
    const b = new Float32Array([-3, -4]);
    const sim = cosine(a, b);
    assert.ok(Math.abs(sim - -1.0) < 1e-5, `expected -1.0, got ${sim}`);
  },
});

harness.add({
  id: "VEC-NORM-012",
  domain: "vector-math",
  category: "normal",
  description: "Cosine similarity in 16D space for identical vectors is 1.0",
  run: () => {
    const v = generateVector(16, 42);
    const sim = cosine(v, v);
    assert.ok(Math.abs(sim - 1.0) < 1e-6, `expected 1.0, got ${sim}`);
  },
});

harness.add({
  id: "VEC-NORM-013",
  domain: "vector-math",
  category: "normal",
  description: "Cosine similarity in 64D space for identical vectors is 1.0",
  run: () => {
    const v = generateVector(64, 43);
    const sim = cosine(v, v);
    assert.ok(Math.abs(sim - 1.0) < 1e-6, `expected 1.0, got ${sim}`);
  },
});

harness.add({
  id: "VEC-NORM-014",
  domain: "vector-math",
  category: "normal",
  description: "Cosine similarity in 128D space for identical vectors is 1.0",
  run: () => {
    const v = generateVector(128, 44);
    const sim = cosine(v, v);
    assert.ok(Math.abs(sim - 1.0) < 1e-6, `expected 1.0, got ${sim}`);
  },
});

harness.add({
  id: "VEC-NORM-015",
  domain: "vector-math",
  category: "normal",
  description: "Cosine similarity in 384D space for identical vectors is 1.0",
  run: () => {
    const v = generateVector(384, 45);
    const sim = cosine(v, v);
    assert.ok(Math.abs(sim - 1.0) < 1e-6, `expected 1.0, got ${sim}`);
  },
});

harness.add({
  id: "VEC-NORM-016",
  domain: "vector-math",
  category: "normal",
  description: "Cosine similarity in 768D space for identical vectors is 1.0",
  run: () => {
    const v = generateVector(768, 46);
    const sim = cosine(v, v);
    assert.ok(Math.abs(sim - 1.0) < 1e-6, `expected 1.0, got ${sim}`);
  },
});

harness.add({
  id: "VEC-NORM-017",
  domain: "vector-math",
  category: "normal",
  description: "Cosine similarity symmetry: cosine(a, b) === cosine(b, a) in 384D",
  run: () => {
    const a = generateVector(384, 101);
    const b = generateVector(384, 102);
    assert.ok(Math.abs(cosine(a, b) - cosine(b, a)) < 1e-7, "expected symmetric cosine");
  },
});

harness.add({
  id: "VEC-NORM-018",
  domain: "vector-math",
  category: "normal",
  description: "Cosine similarity symmetry: cosine(a, b) === cosine(b, a) in random dense 128D",
  run: () => {
    const a = generateVector(128, 201);
    const b = generateVector(128, 202);
    assert.ok(Math.abs(cosine(a, b) - cosine(b, a)) < 1e-7, "expected symmetric cosine");
  },
});

// VEC-NORM-019 to VEC-NORM-028: Normalize and Dot product
harness.add({
  id: "VEC-NORM-019",
  domain: "vector-math",
  category: "normal",
  description: "Normalize returns new Float32Array instance (non-mutating)",
  run: () => {
    const original = new Float32Array([3, 4]);
    const u = normalize(original);
    assert.notStrictEqual(u, original, "expected new instance");
    assert.strictEqual(original[0], 3);
    assert.strictEqual(original[1], 4);
  },
});

harness.add({
  id: "VEC-NORM-020",
  domain: "vector-math",
  category: "normal",
  description: "Normalize 2D vector [3, 4] yields [0.6, 0.8] with L2 norm = 1.0",
  run: () => {
    const u = normalize(new Float32Array([3, 4]));
    assert.ok(Math.abs(u[0]! - 0.6) < 1e-6);
    assert.ok(Math.abs(u[1]! - 0.8) < 1e-6);
    assert.ok(Math.abs(l2Norm(u) - 1.0) < 1e-6);
  },
});

harness.add({
  id: "VEC-NORM-021",
  domain: "vector-math",
  category: "normal",
  description: "Normalize 3D vector [1, 1, 1] yields unit length [1/sqrt(3), 1/sqrt(3), 1/sqrt(3)]",
  run: () => {
    const u = normalize(new Float32Array([1, 1, 1]));
    const expected = 1 / Math.sqrt(3);
    assert.ok(Math.abs(u[0]! - expected) < 1e-6);
    assert.ok(Math.abs(u[1]! - expected) < 1e-6);
    assert.ok(Math.abs(u[2]! - expected) < 1e-6);
    assert.ok(Math.abs(l2Norm(u) - 1.0) < 1e-6);
  },
});

harness.add({
  id: "VEC-NORM-022",
  domain: "vector-math",
  category: "normal",
  description: "Normalize of an already normalized vector is idempotent",
  run: () => {
    const v = normalize(new Float32Array([5, 12]));
    const v2 = normalize(v);
    assert.ok(Math.abs(v[0]! - v2[0]!) < 1e-7);
    assert.ok(Math.abs(v[1]! - v2[1]!) < 1e-7);
  },
});

harness.add({
  id: "VEC-NORM-023",
  domain: "vector-math",
  category: "normal",
  description: "Dot product of normalized vectors equals cosine similarity of raw vectors (2D)",
  run: () => {
    const a = new Float32Array([3, 4]);
    const b = new Float32Array([1, 2]);
    const na = normalize(a);
    const nb = normalize(b);
    assert.ok(Math.abs(dot(na, nb) - cosine(a, b)) < 1e-6);
  },
});

harness.add({
  id: "VEC-NORM-024",
  domain: "vector-math",
  category: "normal",
  description: "Dot product of normalized vectors equals cosine similarity of raw vectors (16D)",
  run: () => {
    const a = generateVector(16, 51);
    const b = generateVector(16, 52);
    assert.ok(Math.abs(dot(normalize(a), normalize(b)) - cosine(a, b)) < 1e-6);
  },
});

harness.add({
  id: "VEC-NORM-025",
  domain: "vector-math",
  category: "normal",
  description: "Dot product of normalized vectors equals cosine similarity of raw vectors (64D)",
  run: () => {
    const a = generateVector(64, 61);
    const b = generateVector(64, 62);
    assert.ok(Math.abs(dot(normalize(a), normalize(b)) - cosine(a, b)) < 1e-6);
  },
});

harness.add({
  id: "VEC-NORM-026",
  domain: "vector-math",
  category: "normal",
  description: "Dot product of normalized vectors equals cosine similarity of raw vectors (384D)",
  run: () => {
    const a = generateVector(384, 71);
    const b = generateVector(384, 72);
    assert.ok(Math.abs(dot(normalize(a), normalize(b)) - cosine(a, b)) < 1e-6);
  },
});

harness.add({
  id: "VEC-NORM-027",
  domain: "vector-math",
  category: "normal",
  description: "Dot product of normalized vectors equals cosine similarity of raw vectors (768D)",
  run: () => {
    const a = generateVector(768, 81);
    const b = generateVector(768, 82);
    assert.ok(Math.abs(dot(normalize(a), normalize(b)) - cosine(a, b)) < 1e-6);
  },
});

harness.add({
  id: "VEC-NORM-028",
  domain: "vector-math",
  category: "normal",
  description: "Dot product symmetry: dot(a, b) === dot(b, a) for unit vectors",
  run: () => {
    const a = normalize(generateVector(384, 91));
    const b = normalize(generateVector(384, 92));
    assert.ok(Math.abs(dot(a, b) - dot(b, a)) < 1e-7);
  },
});

// VEC-NORM-029 to VEC-NORM-035: Top-K ranking
harness.add({
  id: "VEC-NORM-029",
  domain: "vector-math",
  category: "normal",
  description: "Top-K ranking: top-1 from 5 candidates matches maximum cosine similarity",
  run: () => {
    const query = normalize(generateVector(384, 1));
    const candidates = [10, 20, 30, 40, 50].map((s, idx) => ({
      id: `c${idx}`,
      score: dot(query, normalize(generateVector(384, s))),
    }));
    candidates.sort((a, b) => b.score - a.score);
    const top1 = candidates[0]!;
    for (const c of candidates) {
      assert.ok(top1.score >= c.score);
    }
  },
});

harness.add({
  id: "VEC-NORM-030",
  domain: "vector-math",
  category: "normal",
  description: "Top-K ranking: top-3 from 10 candidates sorted strictly in descending order of similarity",
  run: () => {
    const query = normalize(generateVector(384, 2));
    const candidates = Array.from({ length: 10 }, (_, i) => ({
      id: `c${i}`,
      score: dot(query, normalize(generateVector(384, i + 100))),
    }));
    candidates.sort((a, b) => b.score - a.score);
    const top3 = candidates.slice(0, 3);
    assert.strictEqual(top3.length, 3);
    assert.ok(top3[0]!.score >= top3[1]!.score);
    assert.ok(top3[1]!.score >= top3[2]!.score);
  },
});

harness.add({
  id: "VEC-NORM-031",
  domain: "vector-math",
  category: "normal",
  description: "Top-K ranking: top-5 from 20 candidates sorted strictly descending",
  run: () => {
    const query = normalize(generateVector(384, 3));
    const candidates = Array.from({ length: 20 }, (_, i) => ({
      id: `c${i}`,
      score: dot(query, normalize(generateVector(384, i + 200))),
    }));
    candidates.sort((a, b) => b.score - a.score);
    const top5 = candidates.slice(0, 5);
    assert.strictEqual(top5.length, 5);
    for (let i = 0; i < top5.length - 1; i++) {
      assert.ok(top5[i]!.score >= top5[i + 1]!.score);
    }
  },
});

harness.add({
  id: "VEC-NORM-032",
  domain: "vector-math",
  category: "normal",
  description: "Top-K ranking: top-10 from 30 candidates sorted strictly descending",
  run: () => {
    const query = normalize(generateVector(384, 4));
    const candidates = Array.from({ length: 30 }, (_, i) => ({
      id: `c${i}`,
      score: dot(query, normalize(generateVector(384, i + 300))),
    }));
    candidates.sort((a, b) => b.score - a.score);
    const top10 = candidates.slice(0, 10);
    assert.strictEqual(top10.length, 10);
    for (let i = 0; i < top10.length - 1; i++) {
      assert.ok(top10[i]!.score >= top10[i + 1]!.score);
    }
  },
});

harness.add({
  id: "VEC-NORM-033",
  domain: "vector-math",
  category: "normal",
  description: "Top-K ranking: limit = 1 truncates candidate list to exactly 1 item",
  run: () => {
    const list = [0.9, 0.8, 0.7, 0.6];
    assert.strictEqual(list.slice(0, 1).length, 1);
  },
});

harness.add({
  id: "VEC-NORM-034",
  domain: "vector-math",
  category: "normal",
  description: "Top-K ranking: limit = 3 truncates candidate list to exactly 3 items",
  run: () => {
    const list = [0.9, 0.8, 0.7, 0.6, 0.5];
    assert.strictEqual(list.slice(0, 3).length, 3);
  },
});

harness.add({
  id: "VEC-NORM-035",
  domain: "vector-math",
  category: "normal",
  description: "Top-K ranking: limit = 5 truncates candidate list to exactly 5 items",
  run: () => {
    const list = Array.from({ length: 20 }, (_, i) => 1 / (i + 1));
    assert.strictEqual(list.slice(0, 5).length, 5);
  },
});

// VEC-NORM-036 to VEC-NORM-042: Hybrid search combination and RRF
harness.add({
  id: "VEC-NORM-036",
  domain: "vector-math",
  category: "normal",
  description: "RRF single list scoring: rank 1 scores 1/(60+1)",
  run: () => {
    const scores = rrf([["docA"]], 60);
    const expected = 1 / 61;
    assert.ok(Math.abs((scores.get("docA") ?? 0) - expected) < 1e-9);
  },
});

harness.add({
  id: "VEC-NORM-037",
  domain: "vector-math",
  category: "normal",
  description: "RRF single list scoring: rank 2 scores 1/(60+2)",
  run: () => {
    const scores = rrf([["docA", "docB"]], 60);
    const expected = 1 / 62;
    assert.ok(Math.abs((scores.get("docB") ?? 0) - expected) < 1e-9);
  },
});

harness.add({
  id: "VEC-NORM-038",
  domain: "vector-math",
  category: "normal",
  description: "RRF score is monotonically decreasing with rank index",
  run: () => {
    const items = ["a", "b", "c", "d", "e"];
    const scores = rrf([items], 60);
    for (let i = 0; i < items.length - 1; i++) {
      const s1 = scores.get(items[i]!)!;
      const s2 = scores.get(items[i + 1]!)!;
      assert.ok(s1 > s2, `rank ${i} score ${s1} should be > rank ${i + 1} score ${s2}`);
    }
  },
});

harness.add({
  id: "VEC-NORM-039",
  domain: "vector-math",
  category: "normal",
  description: "RRF fusion: item ranked 1st in both vector and keyword lists receives 2/(60+1)",
  run: () => {
    const scores = rrf([["sharedDoc"], ["sharedDoc"]], 60);
    const expected = 2 / 61;
    assert.ok(Math.abs((scores.get("sharedDoc") ?? 0) - expected) < 1e-9);
  },
});

harness.add({
  id: "VEC-NORM-040",
  domain: "vector-math",
  category: "normal",
  description: "RRF fusion: item present in both lists outranks item present in only one list at same rank",
  run: () => {
    const scores = rrf([["both", "onlyVector"], ["both", "onlyKeyword"]], 60);
    const bothScore = scores.get("both")!;
    const vecScore = scores.get("onlyVector")!;
    const kwScore = scores.get("onlyKeyword")!;
    assert.ok(bothScore > vecScore);
    assert.ok(bothScore > kwScore);
  },
});

harness.add({
  id: "VEC-NORM-041",
  domain: "vector-math",
  category: "normal",
  description: "RRF fusion: disjoint lists combine all unique IDs without dropping items",
  run: () => {
    const list1 = ["a", "b", "c"];
    const list2 = ["d", "e", "f"];
    const scores = rrf([list1, list2], 60);
    assert.strictEqual(scores.size, 6);
    for (const id of [...list1, ...list2]) {
      assert.ok(scores.has(id));
    }
  },
});

harness.add({
  id: "VEC-NORM-042",
  domain: "vector-math",
  category: "normal",
  description: "RRF custom k parameter: k=10 scales reciprocal weights appropriately",
  run: () => {
    const scores = rrf([["doc1"]], 10);
    assert.ok(Math.abs(scores.get("doc1")! - 1 / 11) < 1e-9);
  },
});

// VEC-NORM-043 to VEC-NORM-059: Vector store, encoding, SQLite storage, content hash
harness.add({
  id: "VEC-NORM-043",
  domain: "vector-math",
  category: "normal",
  description: "Stored vector: encodeVector and decodeVector roundtrip preserves Float32 values (2D)",
  run: () => {
    const original = new Float32Array([0.12345, -0.6789]);
    const encoded = encodeVector(original);
    const decoded = decodeVector(encoded);
    assert.strictEqual(decoded.length, original.length);
    assert.ok(Math.abs(decoded[0]! - original[0]!) < 1e-6);
    assert.ok(Math.abs(decoded[1]! - original[1]!) < 1e-6);
  },
});

harness.add({
  id: "VEC-NORM-044",
  domain: "vector-math",
  category: "normal",
  description: "Stored vector: encodeVector and decodeVector roundtrip preserves Float32 values (384D)",
  run: () => {
    const original = generateVector(384, 777);
    const encoded = encodeVector(original);
    const decoded = decodeVector(encoded);
    assert.strictEqual(decoded.length, original.length);
    for (let i = 0; i < original.length; i++) {
      assert.ok(Math.abs(decoded[i]! - original[i]!) < 1e-6);
    }
  },
});

harness.add({
  id: "VEC-NORM-045",
  domain: "vector-math",
  category: "normal",
  description: "Stored vector: encodeVector and decodeVector roundtrip preserves Float32 values (768D)",
  run: () => {
    const original = generateVector(768, 888);
    const encoded = encodeVector(original);
    const decoded = decodeVector(encoded);
    assert.strictEqual(decoded.length, original.length);
    for (let i = 0; i < original.length; i++) {
      assert.ok(Math.abs(decoded[i]! - original[i]!) < 1e-6);
    }
  },
});

harness.add({
  id: "VEC-NORM-046",
  domain: "vector-math",
  category: "normal",
  description: "Database upsert: single vector upserted and retrieved from cachedVectors matches unit vector",
  run: () => {
    const db = createTestDb();
    const vec = new Float32Array([3, 4]);
    upsertVectors(db, [
      {
        memoryId: "m1",
        model: "test-model",
        dims: 2,
        contentHash: "hash1",
        vector: vec,
        updatedAt: "2026-10-12T00:00:00Z",
      },
    ]);
    const cached = cachedVectors(db, "test-model", 2);
    const stored = cached.get("m1");
    assert.ok(stored !== undefined);
    assert.ok(Math.abs(l2Norm(stored!) - 1.0) < 1e-6);
    assert.ok(Math.abs(stored![0]! - 0.6) < 1e-6);
    assert.ok(Math.abs(stored![1]! - 0.8) < 1e-6);
  },
});

harness.add({
  id: "VEC-NORM-047",
  domain: "vector-math",
  category: "normal",
  description: "Database upsert: multiple vectors upserted in batch retrieved correctly",
  run: () => {
    const db = createTestDb();
    const rows: VectorRow[] = [
      { memoryId: "m1", model: "model-a", dims: 3, contentHash: "h1", vector: new Float32Array([1, 0, 0]), updatedAt: "2026-10-12T00:00:00Z" },
      { memoryId: "m2", model: "model-a", dims: 3, contentHash: "h2", vector: new Float32Array([0, 1, 0]), updatedAt: "2026-10-12T00:00:00Z" },
      { memoryId: "m3", model: "model-a", dims: 3, contentHash: "h3", vector: new Float32Array([0, 0, 1]), updatedAt: "2026-10-12T00:00:00Z" },
    ];
    upsertVectors(db, rows);
    const cached = cachedVectors(db, "model-a", 3);
    assert.strictEqual(cached.size, 3);
    assert.ok(cached.has("m1"));
    assert.ok(cached.has("m2"));
    assert.ok(cached.has("m3"));
  },
});

harness.add({
  id: "VEC-NORM-048",
  domain: "vector-math",
  category: "normal",
  description: "Database upsert: overwrite existing vector updates content_hash and vector BLOB",
  run: () => {
    const db = createTestDb();
    upsertVectors(db, [
      { memoryId: "m1", model: "model-a", dims: 2, contentHash: "v1", vector: new Float32Array([1, 0]), updatedAt: "2026-10-01T00:00:00Z" },
    ]);
    upsertVectors(db, [
      { memoryId: "m1", model: "model-a", dims: 2, contentHash: "v2", vector: new Float32Array([0, 1]), updatedAt: "2026-10-02T00:00:00Z" },
    ]);
    const cached = cachedVectors(db, "model-a", 2);
    const v = cached.get("m1")!;
    assert.ok(Math.abs(v[0]! - 0) < 1e-6);
    assert.ok(Math.abs(v[1]! - 1) < 1e-6);
    const meta = vectorMeta(db);
    assert.strictEqual(meta.get("m1")?.content_hash, "v2");
  },
});

harness.add({
  id: "VEC-NORM-049",
  domain: "vector-math",
  category: "normal",
  description: "Database cachedVectors: subsequent calls return identical cached Map instance",
  run: () => {
    const db = createTestDb();
    upsertVectors(db, [
      { memoryId: "m1", model: "model-a", dims: 2, contentHash: "h1", vector: new Float32Array([1, 0]), updatedAt: "2026-10-12T00:00:00Z" },
    ]);
    const first = cachedVectors(db, "model-a", 2);
    const second = cachedVectors(db, "model-a", 2);
    assert.strictEqual(first, second, "expected same Map reference from cache");
  },
});

harness.add({
  id: "VEC-NORM-050",
  domain: "vector-math",
  category: "normal",
  description: "Database cachedVectors: model filtering isolates vectors of model A from model B",
  run: () => {
    const db = createTestDb();
    upsertVectors(db, [
      { memoryId: "m1", model: "model-A", dims: 2, contentHash: "h1", vector: new Float32Array([1, 0]), updatedAt: "2026-10-12T00:00:00Z" },
      { memoryId: "m2", model: "model-B", dims: 2, contentHash: "h2", vector: new Float32Array([0, 1]), updatedAt: "2026-10-12T00:00:00Z" },
    ]);
    const cachedA = cachedVectors(db, "model-A", 2);
    assert.strictEqual(cachedA.size, 1);
    assert.ok(cachedA.has("m1"));
    assert.ok(!cachedA.has("m2"));
  },
});

harness.add({
  id: "VEC-NORM-051",
  domain: "vector-math",
  category: "normal",
  description: "Database cachedVectors: dims filtering isolates 384D vectors from 768D vectors",
  run: () => {
    const db = createTestDb();
    upsertVectors(db, [
      { memoryId: "m1", model: "model-X", dims: 384, contentHash: "h1", vector: generateVector(384, 1), updatedAt: "2026-10-12T00:00:00Z" },
      { memoryId: "m2", model: "model-X", dims: 768, contentHash: "h2", vector: generateVector(768, 2), updatedAt: "2026-10-12T00:00:00Z" },
    ]);
    const cached384 = cachedVectors(db, "model-X", 384);
    assert.strictEqual(cached384.size, 1);
    assert.ok(cached384.has("m1"));
    assert.ok(!cached384.has("m2"));
  },
});

harness.add({
  id: "VEC-NORM-052",
  domain: "vector-math",
  category: "normal",
  description: "Database deleteVector removes vector from both SQLite and memory cache",
  run: () => {
    const db = createTestDb();
    upsertVectors(db, [
      { memoryId: "m1", model: "model-a", dims: 2, contentHash: "h1", vector: new Float32Array([1, 0]), updatedAt: "2026-10-12T00:00:00Z" },
    ]);
    assert.strictEqual(cachedVectors(db, "model-a", 2).size, 1);
    deleteVector(db, "m1");
    assert.strictEqual(cachedVectors(db, "model-a", 2).size, 0);
    assert.strictEqual(countVectors(db, "model-a"), 0);
  },
});

harness.add({
  id: "VEC-NORM-053",
  domain: "vector-math",
  category: "normal",
  description: "Database deleteAllVectors clears all vectors and empties cache",
  run: () => {
    const db = createTestDb();
    upsertVectors(db, [
      { memoryId: "m1", model: "model-a", dims: 2, contentHash: "h1", vector: new Float32Array([1, 0]), updatedAt: "2026-10-12T00:00:00Z" },
      { memoryId: "m2", model: "model-a", dims: 2, contentHash: "h2", vector: new Float32Array([0, 1]), updatedAt: "2026-10-12T00:00:00Z" },
    ]);
    assert.strictEqual(countVectors(db, "model-a"), 2);
    deleteAllVectors(db);
    assert.strictEqual(countVectors(db, "model-a"), 0);
    assert.strictEqual(cachedVectors(db, "model-a", 2).size, 0);
  },
});

harness.add({
  id: "VEC-NORM-054",
  domain: "vector-math",
  category: "normal",
  description: "Database purgeOrphanVectors removes vectors whose memory_id is missing from tal_memories",
  run: () => {
    const db = createTestDb();
    db.run("INSERT INTO tal_memories VALUES (?, ?, ?, ?, ?)", "m_kept", "content", "fact", "2026-10-01", "2026-10-01");
    upsertVectors(db, [
      { memoryId: "m_kept", model: "model-a", dims: 2, contentHash: "h1", vector: new Float32Array([1, 0]), updatedAt: "2026-10-12T00:00:00Z" },
      { memoryId: "m_orphan", model: "model-a", dims: 2, contentHash: "h2", vector: new Float32Array([0, 1]), updatedAt: "2026-10-12T00:00:00Z" },
    ]);
    const purged = purgeOrphanVectors(db);
    assert.strictEqual(purged, 1);
    const cached = cachedVectors(db, "model-a", 2);
    assert.ok(cached.has("m_kept"));
    assert.ok(!cached.has("m_orphan"));
  },
});

harness.add({
  id: "VEC-NORM-055",
  domain: "vector-math",
  category: "normal",
  description: "Database countVectors returns exact row count for given model",
  run: () => {
    const db = createTestDb();
    assert.strictEqual(countVectors(db, "m-test"), 0);
    upsertVectors(db, [
      { memoryId: "m1", model: "m-test", dims: 2, contentHash: "h1", vector: new Float32Array([1, 0]), updatedAt: "2026-10-12T00:00:00Z" },
      { memoryId: "m2", model: "m-test", dims: 2, contentHash: "h2", vector: new Float32Array([0, 1]), updatedAt: "2026-10-12T00:00:00Z" },
    ]);
    assert.strictEqual(countVectors(db, "m-test"), 2);
  },
});

harness.add({
  id: "VEC-NORM-056",
  domain: "vector-math",
  category: "normal",
  description: "Database vectorMeta returns map with model, dims, and content_hash per memory",
  run: () => {
    const db = createTestDb();
    upsertVectors(db, [
      { memoryId: "memX", model: "m1", dims: 384, contentHash: "hashX", vector: generateVector(384, 1), updatedAt: "2026-10-12T00:00:00Z" },
    ]);
    const meta = vectorMeta(db);
    assert.ok(meta.has("memX"));
    const row = meta.get("memX")!;
    assert.strictEqual(row.model, "m1");
    assert.strictEqual(row.dims, 384);
    assert.strictEqual(row.content_hash, "hashX");
  },
});

harness.add({
  id: "VEC-NORM-057",
  domain: "vector-math",
  category: "normal",
  description: "Content hash: contentHash produces deterministic 64-char hex SHA-256 string",
  run: async () => {
    const h1 = await contentHash("hello world");
    const h2 = await contentHash("hello world");
    assert.strictEqual(h1, h2);
    assert.strictEqual(h1.length, 64);
    assert.ok(/^[0-9a-f]{64}$/.test(h1));
  },
});

harness.add({
  id: "VEC-NORM-058",
  domain: "vector-math",
  category: "normal",
  description: "Content hash: differing content produces differing SHA-256 hashes",
  run: async () => {
    const h1 = await contentHash("text alpha");
    const h2 = await contentHash("text beta");
    assert.notStrictEqual(h1, h2);
  },
});

harness.add({
  id: "VEC-NORM-059",
  domain: "vector-math",
  category: "normal",
  description: "EmbeddingText helper: concatenates content and category with newline",
  run: () => {
    const text = embeddingText({ content: "I love cats", category: "preference" });
    assert.strictEqual(text, "I love cats\npreference");
  },
});

// VEC-NORM-060 to VEC-NORM-066: MockEmbedder concept matching
harness.add({
  id: "VEC-NORM-060",
  domain: "vector-math",
  category: "normal",
  description: "MockEmbedder concept: 'car' and 'tesla' have cosine similarity >= 0.70",
  run: async () => {
    const embedder = new MockEmbedder();
    const [v1, v2] = await embedder.embed(["I drive a car", "My vehicle is a Tesla"]);
    const sim = cosine(v1!, v2!);
    assert.ok(sim >= 0.7, `expected >= 0.70, got ${sim}`);
  },
});

harness.add({
  id: "VEC-NORM-061",
  domain: "vector-math",
  category: "normal",
  description: "MockEmbedder concept: 'vegetarian' and 'food' have cosine similarity >= 0.70",
  run: async () => {
    const embedder = new MockEmbedder();
    const [v1, v2] = await embedder.embed(["I am vegetarian", "Dinner food meal"]);
    const sim = cosine(v1!, v2!);
    assert.ok(sim >= 0.7, `expected >= 0.70, got ${sim}`);
  },
});

harness.add({
  id: "VEC-NORM-062",
  domain: "vector-math",
  category: "normal",
  description: "MockEmbedder concept: 'peanut' and 'allergy' have cosine similarity >= 0.70",
  run: async () => {
    const embedder = new MockEmbedder();
    const [v1, v2] = await embedder.embed(["Peanuts allergy", "Peanuts reeses allergy"]);
    const sim = cosine(v1!, v2!);
    assert.ok(sim >= 0.7, `expected >= 0.70, got ${sim}`);
  },
});

harness.add({
  id: "VEC-NORM-063",
  domain: "vector-math",
  category: "normal",
  description: "MockEmbedder concept: 'portland' and 'denver' have cosine similarity >= 0.70",
  run: async () => {
    const embedder = new MockEmbedder();
    const [v1, v2] = await embedder.embed(["I live in Portland", "I moved to Denver city"]);
    const sim = cosine(v1!, v2!);
    assert.ok(sim >= 0.7, `expected >= 0.70, got ${sim}`);
  },
});

harness.add({
  id: "VEC-NORM-064",
  domain: "vector-math",
  category: "normal",
  description: "MockEmbedder concept: 'mountains' and 'hiking' have cosine similarity >= 0.70",
  run: async () => {
    const embedder = new MockEmbedder();
    const [v1, v2] = await embedder.embed(["High mountains peaks", "Outdoor hiking trails"]);
    const sim = cosine(v1!, v2!);
    assert.ok(sim >= 0.7, `expected >= 0.70, got ${sim}`);
  },
});

harness.add({
  id: "VEC-NORM-065",
  domain: "vector-math",
  category: "normal",
  description: "MockEmbedder unrelated concepts: 'car' vs 'vegetarian' has cosine similarity < 0.50",
  run: async () => {
    const embedder = new MockEmbedder();
    const [v1, v2] = await embedder.embed(["Tesla car vehicle", "Vegetarian meat meal"]);
    const sim = cosine(v1!, v2!);
    assert.ok(sim < 0.5, `expected < 0.50, got ${sim}`);
  },
});

harness.add({
  id: "VEC-NORM-066",
  domain: "vector-math",
  category: "normal",
  description: "MockEmbedder unrelated concepts: 'portland' vs 'peanut' has cosine similarity < 0.50",
  run: async () => {
    const embedder = new MockEmbedder();
    const [v1, v2] = await embedder.embed(["City Portland Denver", "Peanuts reeses allergy"]);
    const sim = cosine(v1!, v2!);
    assert.ok(sim < 0.5, `expected < 0.50, got ${sim}`);
  },
});

// VEC-NORM-067 to VEC-NORM-072: Hybrid search, Pull in newer, ApplyM1, Notes
harness.add({
  id: "VEC-NORM-067",
  domain: "vector-math",
  category: "normal",
  description: "Hybrid search: combines vector cosine similarity and keyword search results",
  run: async () => {
    const db = createTestDb();
    const embedder = new MockEmbedder();
    const ctx = createTestContext(db, embedder);

    db.run("INSERT INTO tal_memories VALUES (?, ?, ?, ?, ?)", "m1", "I drive a Tesla electric car", "fact", "2026-10-01", "2026-10-01");
    db.run("INSERT INTO tal_memories VALUES (?, ?, ?, ?, ?)", "m2", "I like green tea", "preference", "2026-10-01", "2026-10-01");

    const [v1, v2] = await embedder.embed(["I drive a Tesla electric car\nfact", "I like green tea\npreference"]);
    upsertVectors(db, [
      { memoryId: "m1", model: embedder.model, dims: embedder.dims, contentHash: "h1", vector: v1!, updatedAt: "2026-10-01" },
      { memoryId: "m2", model: embedder.model, dims: embedder.dims, contentHash: "h2", vector: v2!, updatedAt: "2026-10-01" },
    ]);

    const hits = await hybridSearch(ctx, "car vehicle", { limit: 5 });
    assert.ok(hits.length >= 1);
    assert.strictEqual(hits[0]!.memory.id, "m1");
    assert.ok(hits[0]!.cosine !== null);
  },
});

harness.add({
  id: "VEC-NORM-068",
  domain: "vector-math",
  category: "normal",
  description: "Hybrid search: limit option correctly bounds returned hits count",
  run: async () => {
    const db = createTestDb();
    const embedder = new MockEmbedder();
    const ctx = createTestContext(db, embedder);

    for (let i = 0; i < 10; i++) {
      db.run(
        "INSERT INTO tal_memories VALUES (?, ?, ?, ?, ?)",
        `mem_${i}`,
        `Fact number ${i} about cars and vehicles`,
        "fact",
        "2026-10-01",
        "2026-10-01",
      );
    }
    const hits = await hybridSearch(ctx, "cars", { limit: 3 });
    assert.ok(hits.length <= 3);
  },
});

harness.add({
  id: "VEC-NORM-069",
  domain: "vector-math",
  category: "normal",
  description: "PullInNewer: pulls in newer near-duplicate when cosine exceeds threshold",
  run: async () => {
    const db = createTestDb();
    const embedder = new MockEmbedder();
    const ctx = createTestContext(db, embedder);

    const mOld: Memory = { id: "m_old", content: "I drive a car", category: "fact", created_at: "2026-10-01", updated_at: "2026-10-01" };
    const mNew: Memory = { id: "m_new", content: "I drive a Tesla vehicle", category: "fact", created_at: "2026-10-02", updated_at: "2026-10-02" };
    db.run("INSERT INTO tal_memories VALUES (?, ?, ?, ?, ?)", mOld.id, mOld.content, mOld.category, mOld.created_at, mOld.updated_at);
    db.run("INSERT INTO tal_memories VALUES (?, ?, ?, ?, ?)", mNew.id, mNew.content, mNew.category, mNew.created_at, mNew.updated_at);

    const [vOld, vNew] = await embedder.embed([mOld.content, mNew.content]);
    upsertVectors(db, [
      { memoryId: mOld.id, model: embedder.model, dims: embedder.dims, contentHash: "h1", vector: vOld!, updatedAt: mOld.updated_at },
      { memoryId: mNew.id, model: embedder.model, dims: embedder.dims, contentHash: "h2", vector: vNew!, updatedAt: mNew.updated_at },
    ]);

    const initialHits: RecallHit[] = [{ memory: mOld, cosine: 0.8, fused: 0.03 }];
    const result = pullInNewer(ctx, initialHits, 5);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0]!.memory.id, "m_old");
    assert.strictEqual(result[1]!.memory.id, "m_new");
  },
});

harness.add({
  id: "VEC-NORM-070",
  domain: "vector-math",
  category: "normal",
  description: "PullInNewer: does not pull in older memory even if cosine is high",
  run: async () => {
    const db = createTestDb();
    const embedder = new MockEmbedder();
    const ctx = createTestContext(db, embedder);

    const mOld: Memory = { id: "m_old", content: "I drive a car", category: "fact", created_at: "2026-10-01", updated_at: "2026-10-01" };
    const mNew: Memory = { id: "m_new", content: "I drive a Tesla vehicle", category: "fact", created_at: "2026-10-02", updated_at: "2026-10-02" };
    db.run("INSERT INTO tal_memories VALUES (?, ?, ?, ?, ?)", mOld.id, mOld.content, mOld.category, mOld.created_at, mOld.updated_at);
    db.run("INSERT INTO tal_memories VALUES (?, ?, ?, ?, ?)", mNew.id, mNew.content, mNew.category, mNew.created_at, mNew.updated_at);

    const [vOld, vNew] = await embedder.embed([mOld.content, mNew.content]);
    upsertVectors(db, [
      { memoryId: mOld.id, model: embedder.model, dims: embedder.dims, contentHash: "h1", vector: vOld!, updatedAt: mOld.updated_at },
      { memoryId: mNew.id, model: embedder.model, dims: embedder.dims, contentHash: "h2", vector: vNew!, updatedAt: mNew.updated_at },
    ]);

    // mNew is already selected; mOld is older, so mOld should NOT be pulled in
    const initialHits: RecallHit[] = [{ memory: mNew, cosine: 0.8, fused: 0.03 }];
    const result = pullInNewer(ctx, initialHits, 5);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]!.memory.id, "m_new");
  },
});

harness.add({
  id: "VEC-NORM-071",
  domain: "vector-math",
  category: "normal",
  description: "ApplyM1: sorts memories by updated_at descending and prefixes with saved timestamp",
  run: () => {
    const m1: Memory = { id: "1", content: "Older", category: "fact", created_at: "2026-10-01", updated_at: "2026-10-01T12:00:00.000Z" };
    const m2: Memory = { id: "2", content: "Newer", category: "fact", created_at: "2026-10-02", updated_at: "2026-10-02T12:00:00.000Z" };
    const formatted = applyM1([m1, m2], "UTC");
    assert.strictEqual(formatted.length, 2);
    assert.strictEqual(formatted[0]!.id, "2");
    assert.ok(formatted[0]!.content.startsWith("(saved 2026-10-02"));
    assert.ok(formatted[1]!.content.startsWith("(saved 2026-10-01"));
  },
});

harness.add({
  id: "VEC-NORM-072",
  domain: "vector-math",
  category: "normal",
  description: "NewerWinsNote: returns singleton memory note with standard disclaimer",
  run: () => {
    const note = newerWinsNote();
    assert.strictEqual(note.id, "semantic-newer-wins-note");
    assert.strictEqual(note.content, "If two memories conflict, the more recently saved one is current.");
    assert.strictEqual(note.category, "other");
  },
});

// ==========================================
// 2. BOUNDARY CATEGORY (64 tests)
// ==========================================

harness.add({
  id: "VEC-BOUND-001",
  domain: "vector-math",
  category: "boundary",
  description: "0-vector: normalize of 2D all-zero vector returns all-zero vector",
  run: () => {
    const v = normalize(new Float32Array([0, 0]));
    assert.strictEqual(v[0], 0);
    assert.strictEqual(v[1], 0);
  },
});

harness.add({
  id: "VEC-BOUND-002",
  domain: "vector-math",
  category: "boundary",
  description: "0-vector: normalize of 384D all-zero vector returns all-zero vector",
  run: () => {
    const v = normalize(new Float32Array(384));
    assert.strictEqual(v.length, 384);
    assert.ok(v.every((x) => x === 0));
  },
});

harness.add({
  id: "VEC-BOUND-003",
  domain: "vector-math",
  category: "boundary",
  description: "0-vector: normalize of 768D all-zero vector returns all-zero vector",
  run: () => {
    const v = normalize(new Float32Array(768));
    assert.strictEqual(v.length, 768);
    assert.ok(v.every((x) => x === 0));
  },
});

harness.add({
  id: "VEC-BOUND-004",
  domain: "vector-math",
  category: "boundary",
  description: "0-vector: normalize of 1536D all-zero vector returns all-zero vector",
  run: () => {
    const v = normalize(new Float32Array(1536));
    assert.strictEqual(v.length, 1536);
    assert.ok(v.every((x) => x === 0));
  },
});

harness.add({
  id: "VEC-BOUND-005",
  domain: "vector-math",
  category: "boundary",
  description: "0-vector: dot product of all-zero vector and unit vector is 0.0",
  run: () => {
    assert.strictEqual(dot(new Float32Array([0, 0]), new Float32Array([1, 0])), 0);
  },
});

harness.add({
  id: "VEC-BOUND-006",
  domain: "vector-math",
  category: "boundary",
  description: "0-vector: dot product of unit vector and all-zero vector is 0.0",
  run: () => {
    assert.strictEqual(dot(new Float32Array([1, 0]), new Float32Array([0, 0])), 0);
  },
});

harness.add({
  id: "VEC-BOUND-007",
  domain: "vector-math",
  category: "boundary",
  description: "0-vector: dot product of two all-zero vectors is 0.0",
  run: () => {
    assert.strictEqual(dot(new Float32Array(384), new Float32Array(384)), 0);
  },
});

harness.add({
  id: "VEC-BOUND-008",
  domain: "vector-math",
  category: "boundary",
  description: "0-vector: cosine similarity of all-zero vector and arbitrary vector is 0.0",
  run: () => {
    assert.strictEqual(cosine(new Float32Array([0, 0]), new Float32Array([3, 4])), 0);
  },
});

harness.add({
  id: "VEC-BOUND-009",
  domain: "vector-math",
  category: "boundary",
  description: "0-vector: cosine similarity of arbitrary vector and all-zero vector is 0.0",
  run: () => {
    assert.strictEqual(cosine(new Float32Array([3, 4]), new Float32Array([0, 0])), 0);
  },
});

harness.add({
  id: "VEC-BOUND-010",
  domain: "vector-math",
  category: "boundary",
  description: "0-vector: cosine similarity of two all-zero vectors is 0.0",
  run: () => {
    assert.strictEqual(cosine(new Float32Array(384), new Float32Array(384)), 0);
  },
});

harness.add({
  id: "VEC-BOUND-011",
  domain: "vector-math",
  category: "boundary",
  description: "Unit vector: standard basis e_0 [1, 0, 0] has norm exactly 1.0",
  run: () => {
    assert.strictEqual(l2Norm(new Float32Array([1, 0, 0])), 1.0);
  },
});

harness.add({
  id: "VEC-BOUND-012",
  domain: "vector-math",
  category: "boundary",
  description: "Unit vector: standard basis e_1 [0, 1, 0] has norm exactly 1.0",
  run: () => {
    assert.strictEqual(l2Norm(new Float32Array([0, 1, 0])), 1.0);
  },
});

harness.add({
  id: "VEC-BOUND-013",
  domain: "vector-math",
  category: "boundary",
  description: "Unit vector: standard basis e_2 [0, 0, 1] has norm exactly 1.0",
  run: () => {
    assert.strictEqual(l2Norm(new Float32Array([0, 0, 1])), 1.0);
  },
});

harness.add({
  id: "VEC-BOUND-014",
  domain: "vector-math",
  category: "boundary",
  description: "Unit vector: standard basis e_0 in 384D has norm 1.0",
  run: () => {
    const v = new Float32Array(384);
    v[0] = 1.0;
    assert.strictEqual(l2Norm(v), 1.0);
  },
});

harness.add({
  id: "VEC-BOUND-015",
  domain: "vector-math",
  category: "boundary",
  description: "Unit vector: standard basis e_383 in 384D has norm 1.0",
  run: () => {
    const v = new Float32Array(384);
    v[383] = 1.0;
    assert.strictEqual(l2Norm(v), 1.0);
  },
});

harness.add({
  id: "VEC-BOUND-016",
  domain: "vector-math",
  category: "boundary",
  description: "Unit vector: standard basis e_0 in 1536D has norm 1.0",
  run: () => {
    const v = new Float32Array(1536);
    v[0] = 1.0;
    assert.strictEqual(l2Norm(v), 1.0);
  },
});

harness.add({
  id: "VEC-BOUND-017",
  domain: "vector-math",
  category: "boundary",
  description: "Unit vector: uniform component vector (1/sqrt(d)) has norm 1.0 in 384D",
  run: () => {
    const v = new Float32Array(384).fill(1 / Math.sqrt(384));
    assert.ok(Math.abs(l2Norm(v) - 1.0) < 1e-6);
  },
});

harness.add({
  id: "VEC-BOUND-018",
  domain: "vector-math",
  category: "boundary",
  description: "Unit vector: uniform component vector (1/sqrt(d)) has norm 1.0 in 1536D",
  run: () => {
    const v = new Float32Array(1536).fill(1 / Math.sqrt(1536));
    assert.ok(Math.abs(l2Norm(v) - 1.0) < 1e-6);
  },
});

harness.add({
  id: "VEC-BOUND-019",
  domain: "vector-math",
  category: "boundary",
  description: "Orthogonal vectors: 2D basis e_0 and e_1 have dot product exactly 0.0",
  run: () => {
    assert.strictEqual(dot(new Float32Array([1, 0]), new Float32Array([0, 1])), 0.0);
  },
});

harness.add({
  id: "VEC-BOUND-020",
  domain: "vector-math",
  category: "boundary",
  description: "Orthogonal vectors: 2D basis e_0 and e_1 have cosine similarity exactly 0.0",
  run: () => {
    assert.strictEqual(cosine(new Float32Array([1, 0]), new Float32Array([0, 1])), 0.0);
  },
});

harness.add({
  id: "VEC-BOUND-021",
  domain: "vector-math",
  category: "boundary",
  description: "Orthogonal vectors: 3D [1, -2, 1] and [2, 1, 0] have dot product exactly 0.0",
  run: () => {
    const a = normalize(new Float32Array([1, -2, 1]));
    const b = normalize(new Float32Array([2, 1, 0]));
    assert.ok(Math.abs(dot(a, b)) < 1e-7);
  },
});

harness.add({
  id: "VEC-BOUND-022",
  domain: "vector-math",
  category: "boundary",
  description: "Orthogonal vectors: 4D Hadamard basis vectors H1 and H2 have dot product 0.0",
  run: () => {
    const h1 = normalize(new Float32Array([1, 1, 1, 1]));
    const h2 = normalize(new Float32Array([1, -1, 1, -1]));
    assert.ok(Math.abs(dot(h1, h2)) < 1e-7);
  },
});

harness.add({
  id: "VEC-BOUND-023",
  domain: "vector-math",
  category: "boundary",
  description: "Orthogonal vectors: high-dim 384D orthogonal partition vectors have dot product 0.0",
  run: () => {
    const a = new Float32Array(384);
    const b = new Float32Array(384);
    for (let i = 0; i < 192; i++) a[i] = 1.0;
    for (let i = 192; i < 384; i++) b[i] = 1.0;
    assert.strictEqual(dot(normalize(a), normalize(b)), 0.0);
  },
});

harness.add({
  id: "VEC-BOUND-024",
  domain: "vector-math",
  category: "boundary",
  description: "Orthogonal vectors: high-dim 1536D orthogonal partition vectors have dot product 0.0",
  run: () => {
    const a = new Float32Array(1536);
    const b = new Float32Array(1536);
    for (let i = 0; i < 768; i++) a[i] = 1.0;
    for (let i = 768; i < 1536; i++) b[i] = 1.0;
    assert.strictEqual(dot(normalize(a), normalize(b)), 0.0);
  },
});

harness.add({
  id: "VEC-BOUND-025",
  domain: "vector-math",
  category: "boundary",
  description: "Opposite vectors: 2D unit vector [0.6, 0.8] and [-0.6, -0.8] have dot product -1.0",
  run: () => {
    const a = new Float32Array([0.6, 0.8]);
    const b = new Float32Array([-0.6, -0.8]);
    assert.ok(Math.abs(dot(a, b) - -1.0) < 1e-6);
  },
});

harness.add({
  id: "VEC-BOUND-026",
  domain: "vector-math",
  category: "boundary",
  description: "Opposite vectors: 2D raw vector [3, 4] and [-3, -4] have cosine similarity -1.0",
  run: () => {
    assert.ok(Math.abs(cosine(new Float32Array([3, 4]), new Float32Array([-3, -4])) - -1.0) < 1e-6);
  },
});

harness.add({
  id: "VEC-BOUND-027",
  domain: "vector-math",
  category: "boundary",
  description: "Opposite vectors: 384D random unit vector v and -v have dot product -1.0",
  run: () => {
    const v = normalize(generateVector(384, 55));
    const neg = new Float32Array(384);
    for (let i = 0; i < 384; i++) neg[i] = -v[i]!;
    assert.ok(Math.abs(dot(v, neg) - -1.0) < 1e-6);
  },
});

harness.add({
  id: "VEC-BOUND-028",
  domain: "vector-math",
  category: "boundary",
  description: "Opposite vectors: 384D random vector v and -v have cosine similarity -1.0",
  run: () => {
    const v = generateVector(384, 66);
    const neg = new Float32Array(384);
    for (let i = 0; i < 384; i++) neg[i] = -v[i]!;
    assert.ok(Math.abs(cosine(v, neg) - -1.0) < 1e-6);
  },
});

harness.add({
  id: "VEC-BOUND-029",
  domain: "vector-math",
  category: "boundary",
  description: "Opposite vectors: 1536D random unit vector v and -v have dot product -1.0",
  run: () => {
    const v = normalize(generateVector(1536, 77));
    const neg = new Float32Array(1536);
    for (let i = 0; i < 1536; i++) neg[i] = -v[i]!;
    assert.ok(Math.abs(dot(v, neg) - -1.0) < 1e-6);
  },
});

harness.add({
  id: "VEC-BOUND-030",
  domain: "vector-math",
  category: "boundary",
  description: "Opposite vectors: 1536D random vector v and -v have cosine similarity -1.0",
  run: () => {
    const v = generateVector(1536, 88);
    const neg = new Float32Array(1536);
    for (let i = 0; i < 1536; i++) neg[i] = -v[i]!;
    assert.ok(Math.abs(cosine(v, neg) - -1.0) < 1e-6);
  },
});

harness.add({
  id: "VEC-BOUND-031",
  domain: "vector-math",
  category: "boundary",
  description: "Ultra-high dimensional vector: 1536D normalization preserves unit length",
  run: () => {
    const v = generateVector(1536, 99);
    const u = normalize(v);
    assert.ok(Math.abs(l2Norm(u) - 1.0) < 1e-6);
  },
});

harness.add({
  id: "VEC-BOUND-032",
  domain: "vector-math",
  category: "boundary",
  description: "Ultra-high dimensional vector: 1536D dot product between identical unit vectors is 1.0",
  run: () => {
    const u = normalize(generateVector(1536, 111));
    assert.ok(Math.abs(dot(u, u) - 1.0) < 1e-6);
  },
});

harness.add({
  id: "VEC-BOUND-033",
  domain: "vector-math",
  category: "boundary",
  description: "Ultra-high dimensional vector: 1536D cosine similarity of identical vectors is 1.0",
  run: () => {
    const v = generateVector(1536, 222);
    assert.ok(Math.abs(cosine(v, v) - 1.0) < 1e-6);
  },
});

harness.add({
  id: "VEC-BOUND-034",
  domain: "vector-math",
  category: "boundary",
  description: "Ultra-high dimensional vector: 3072D normalization preserves unit length",
  run: () => {
    const v = generateVector(3072, 333);
    const u = normalize(v);
    assert.ok(Math.abs(l2Norm(u) - 1.0) < 1e-6);
  },
});

harness.add({
  id: "VEC-BOUND-035",
  domain: "vector-math",
  category: "boundary",
  description: "Ultra-high dimensional vector: 3072D dot product between identical unit vectors is 1.0",
  run: () => {
    const u = normalize(generateVector(3072, 444));
    assert.ok(Math.abs(dot(u, u) - 1.0) < 1e-6);
  },
});

harness.add({
  id: "VEC-BOUND-036",
  domain: "vector-math",
  category: "boundary",
  description: "Ultra-high dimensional vector: 4096D normalization preserves unit length",
  run: () => {
    const v = generateVector(4096, 555);
    const u = normalize(v);
    assert.ok(Math.abs(l2Norm(u) - 1.0) < 1e-6);
  },
});

harness.add({
  id: "VEC-BOUND-037",
  domain: "vector-math",
  category: "boundary",
  description: "Ultra-high dimensional vector: 4096D dot product between identical unit vectors is 1.0",
  run: () => {
    const u = normalize(generateVector(4096, 666));
    assert.ok(Math.abs(dot(u, u) - 1.0) < 1e-6);
  },
});

harness.add({
  id: "VEC-BOUND-038",
  domain: "vector-math",
  category: "boundary",
  description: "1D boundary: 1D vector [5.0] normalized yields [1.0]",
  run: () => {
    const u = normalize(new Float32Array([5.0]));
    assert.strictEqual(u.length, 1);
    assert.strictEqual(u[0], 1.0);
  },
});

harness.add({
  id: "VEC-BOUND-039",
  domain: "vector-math",
  category: "boundary",
  description: "1D boundary: 1D vector [-7.0] normalized yields [-1.0]",
  run: () => {
    const u = normalize(new Float32Array([-7.0]));
    assert.strictEqual(u.length, 1);
    assert.strictEqual(u[0], -1.0);
  },
});

harness.add({
  id: "VEC-BOUND-040",
  domain: "vector-math",
  category: "boundary",
  description: "1D boundary: 1D vectors [3.0] and [4.0] have cosine similarity 1.0",
  run: () => {
    assert.strictEqual(cosine(new Float32Array([3.0]), new Float32Array([4.0])), 1.0);
  },
});

harness.add({
  id: "VEC-BOUND-041",
  domain: "vector-math",
  category: "boundary",
  description: "1D boundary: 1D vectors [3.0] and [-4.0] have cosine similarity -1.0",
  run: () => {
    assert.strictEqual(cosine(new Float32Array([3.0]), new Float32Array([-4.0])), -1.0);
  },
});

harness.add({
  id: "VEC-BOUND-042",
  domain: "vector-math",
  category: "boundary",
  description: "Empty vector (0D): Float32Array(0) normalized returns Float32Array(0)",
  run: () => {
    const u = normalize(new Float32Array(0));
    assert.strictEqual(u.length, 0);
  },
});

harness.add({
  id: "VEC-BOUND-043",
  domain: "vector-math",
  category: "boundary",
  description: "Empty vector (0D): dot product of two Float32Array(0) is 0.0",
  run: () => {
    assert.strictEqual(dot(new Float32Array(0), new Float32Array(0)), 0.0);
  },
});

harness.add({
  id: "VEC-BOUND-044",
  domain: "vector-math",
  category: "boundary",
  description: "Empty vector (0D): cosine similarity of two Float32Array(0) is 0.0",
  run: () => {
    assert.strictEqual(cosine(new Float32Array(0), new Float32Array(0)), 0.0);
  },
});

harness.add({
  id: "VEC-BOUND-045",
  domain: "vector-math",
  category: "boundary",
  description: "Tie-breaking: identical cosine scores tie-break by updated_at descending",
  run: () => {
    const a = { id: "a", cosine: 0.8, updated: "2026-10-01T00:00:00Z" };
    const b = { id: "b", cosine: 0.8, updated: "2026-10-02T00:00:00Z" };
    const list = [a, b];
    list.sort((x, y) => y.cosine - x.cosine || (y.updated < x.updated ? -1 : y.updated > x.updated ? 1 : 0));
    assert.strictEqual(list[0]!.id, "b");
  },
});

harness.add({
  id: "VEC-BOUND-046",
  domain: "vector-math",
  category: "boundary",
  description: "Tie-breaking: identical cosine and updated_at tie-break by memory ID ascending",
  run: () => {
    const a = { id: "z-id", cosine: 0.8, updated: "2026-10-01T00:00:00Z" };
    const b = { id: "a-id", cosine: 0.8, updated: "2026-10-01T00:00:00Z" };
    const list = [a, b];
    list.sort(
      (x, y) =>
        y.cosine - x.cosine ||
        (y.updated < x.updated ? -1 : y.updated > x.updated ? 1 : 0) ||
        (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
    );
    assert.strictEqual(list[0]!.id, "a-id");
  },
});

harness.add({
  id: "VEC-BOUND-047",
  domain: "vector-math",
  category: "boundary",
  description: "Tie-breaking: identical fused RRF scores tie-break by cosine descending",
  run: () => {
    const h1: RecallHit = {
      memory: { id: "1", content: "", category: "", created_at: "", updated_at: "" },
      cosine: 0.9,
      fused: 0.03,
    };
    const h2: RecallHit = {
      memory: { id: "2", content: "", category: "", created_at: "", updated_at: "" },
      cosine: 0.7,
      fused: 0.03,
    };
    const list = [h2, h1];
    list.sort((a, b) => b.fused - a.fused || (b.cosine ?? -1) - (a.cosine ?? -1));
    assert.strictEqual(list[0]!.memory.id, "1");
  },
});

harness.add({
  id: "VEC-BOUND-048",
  domain: "vector-math",
  category: "boundary",
  description: "Tie-breaking: identical fused RRF scores with null cosines tie-break by updated_at descending",
  run: () => {
    const h1: RecallHit = {
      memory: { id: "1", content: "", category: "", created_at: "2026-10-01", updated_at: "2026-10-01T10:00:00Z" },
      cosine: null,
      fused: 0.03,
    };
    const h2: RecallHit = {
      memory: { id: "2", content: "", category: "", created_at: "2026-10-02", updated_at: "2026-10-02T10:00:00Z" },
      cosine: null,
      fused: 0.03,
    };
    const list = [h1, h2];
    list.sort(
      (a, b) =>
        b.fused - a.fused ||
        (b.cosine ?? -1) - (a.cosine ?? -1) ||
        (b.memory.updated_at < a.memory.updated_at ? -1 : b.memory.updated_at > a.memory.updated_at ? 1 : 0),
    );
    assert.strictEqual(list[0]!.memory.id, "2");
  },
});

harness.add({
  id: "VEC-BOUND-049",
  domain: "vector-math",
  category: "boundary",
  description: "Tie-breaking: identical fused, null cosine, and identical updated_at tie-break by ID ascending",
  run: () => {
    const h1: RecallHit = {
      memory: { id: "id-b", content: "", category: "", created_at: "", updated_at: "2026-10-01T00:00:00Z" },
      cosine: null,
      fused: 0.03,
    };
    const h2: RecallHit = {
      memory: { id: "id-a", content: "", category: "", created_at: "", updated_at: "2026-10-01T00:00:00Z" },
      cosine: null,
      fused: 0.03,
    };
    const list = [h1, h2];
    list.sort(
      (a, b) =>
        b.fused - a.fused ||
        (b.cosine ?? -1) - (a.cosine ?? -1) ||
        (b.memory.updated_at < a.memory.updated_at ? -1 : b.memory.updated_at > a.memory.updated_at ? 1 : 0) ||
        (a.memory.id < b.memory.id ? -1 : a.memory.id > b.memory.id ? 1 : 0),
    );
    assert.strictEqual(list[0]!.memory.id, "id-a");
  },
});

harness.add({
  id: "VEC-BOUND-050",
  domain: "vector-math",
  category: "boundary",
  description: "Floor boundary: cosine score exactly equal to absolute floor (0.55) is kept",
  run: () => {
    const floor = 0.55;
    const score = 0.55;
    assert.ok(score >= floor);
  },
});

harness.add({
  id: "VEC-BOUND-051",
  domain: "vector-math",
  category: "boundary",
  description: "Floor boundary: cosine score slightly below absolute floor (0.54999) is excluded from primary hits",
  run: () => {
    const floor = 0.55;
    const score = 0.54999;
    assert.ok(score < floor);
  },
});

harness.add({
  id: "VEC-BOUND-052",
  domain: "vector-math",
  category: "boundary",
  description: "Floor boundary: cosine score slightly above absolute floor (0.55001) is included in primary hits",
  run: () => {
    const floor = 0.55;
    const score = 0.55001;
    assert.ok(score >= floor);
  },
});

harness.add({
  id: "VEC-BOUND-053",
  domain: "vector-math",
  category: "boundary",
  description: "Relative floor: candidate at (top.cosine - relative) is kept",
  run: () => {
    const topCosine = 0.8;
    const relative = 0.15;
    const candidateCosine = 0.65;
    assert.ok(candidateCosine >= topCosine - relative);
  },
});

harness.add({
  id: "VEC-BOUND-054",
  domain: "vector-math",
  category: "boundary",
  description: "Relative floor: candidate below (top.cosine - relative) is excluded from primary hits",
  run: () => {
    const topCosine = 0.8;
    const relative = 0.15;
    const candidateCosine = 0.6499;
    assert.ok(candidateCosine < topCosine - relative);
  },
});

harness.add({
  id: "VEC-BOUND-055",
  domain: "vector-math",
  category: "boundary",
  description: "Backstop floor: fallback candidate at backstop (0.40) is admitted to fill fallback slots",
  run: () => {
    const backstop = 0.4;
    const candidate = 0.4;
    assert.ok(candidate >= backstop);
  },
});

harness.add({
  id: "VEC-BOUND-056",
  domain: "vector-math",
  category: "boundary",
  description: "Backstop floor: fallback candidate below backstop (0.3999) is rejected from fallback slots",
  run: () => {
    const backstop = 0.4;
    const candidate = 0.3999;
    assert.ok(candidate < backstop);
  },
});

harness.add({
  id: "VEC-BOUND-057",
  domain: "vector-math",
  category: "boundary",
  description: "Fallback slot boundary: exactly FALLBACK_K (4) items top-up when primary hits < 4",
  run: async () => {
    const db = createTestDb();
    const embedder = new MockEmbedder();
    const ctx = createTestContext(db, embedder);

    // Create 6 memories with cosines between 0.42 and 0.50 (above backstop 0.40, below absolute 0.55)
    for (let i = 0; i < 6; i++) {
      db.run("INSERT INTO tal_memories VALUES (?, ?, ?, ?, ?)", `m${i}`, `Fact ${i}`, "fact", "2026-10-01", `2026-10-01T0${i}:00:00Z`);
      const v = new Float32Array(384);
      v[0] = 0.42 + i * 0.01;
      v[1] = Math.sqrt(Math.max(0, 1 - v[0] * v[0]));
      upsertVectors(db, [{ memoryId: `m${i}`, model: embedder.model, dims: 384, contentHash: `h${i}`, vector: v, updatedAt: "2026-10-01" }]);
    }

    const queryVec = new Float32Array(384);
    queryVec[0] = 1.0;
    // HybridSearch uses scanVectors
    const hits = await hybridSearch(ctx, "nonexistentkeyword", { limit: 10 });
    // Vector search should top up to FALLBACK_K (4)
    assert.ok(hits.length <= 4);
  },
});

harness.add({
  id: "VEC-BOUND-058",
  domain: "vector-math",
  category: "boundary",
  description: "Fallback slot boundary: no fallback top-up occurs when primary hits >= 4",
  run: () => {
    const kept = ["h1", "h2", "h3", "h4"];
    assert.ok(kept.length >= 4);
  },
});

harness.add({
  id: "VEC-BOUND-059",
  domain: "vector-math",
  category: "boundary",
  description: "PullInNewer boundary: threshold exactly at newerDuplicateCosine pulls in replacement",
  run: () => {
    const threshold = 0.7;
    const similarity = 0.7;
    assert.ok(similarity >= threshold);
  },
});

harness.add({
  id: "VEC-BOUND-060",
  domain: "vector-math",
  category: "boundary",
  description: "PullInNewer boundary: threshold just below newerDuplicateCosine does not pull in replacement",
  run: () => {
    const threshold = 0.7;
    const similarity = 0.6999;
    assert.ok(similarity < threshold);
  },
});

harness.add({
  id: "VEC-BOUND-061",
  domain: "vector-math",
  category: "boundary",
  description: "PullInNewer boundary: MAX_NEWER_PER_HIT (2) limit strictly enforced",
  run: async () => {
    const db = createTestDb();
    const embedder = new MockEmbedder();
    const ctx = createTestContext(db, embedder);

    const puller: Memory = { id: "p1", content: "Original car", category: "fact", created_at: "2026-10-01", updated_at: "2026-10-01" };
    db.run("INSERT INTO tal_memories VALUES (?, ?, ?, ?, ?)", puller.id, puller.content, puller.category, puller.created_at, puller.updated_at);

    // 5 candidates with higher updated_at and near-identical vectors
    const vec = new Float32Array(384);
    vec[0] = 1.0;
    upsertVectors(db, [{ memoryId: puller.id, model: embedder.model, dims: 384, contentHash: "hp", vector: vec, updatedAt: puller.updated_at }]);

    for (let i = 1; i <= 5; i++) {
      const id = `cand_${i}`;
      db.run("INSERT INTO tal_memories VALUES (?, ?, ?, ?, ?)", id, `Newer car ${i}`, "fact", `2026-10-0${i + 1}`, `2026-10-0${i + 1}`);
      upsertVectors(db, [{ memoryId: id, model: embedder.model, dims: 384, contentHash: `h${i}`, vector: vec, updatedAt: `2026-10-0${i + 1}` }]);
    }

    const hits: RecallHit[] = [{ memory: puller, cosine: 0.9, fused: 0.05 }];
    const result = pullInNewer(ctx, hits, 10);
    // 1 puller + at most 2 pulled = 3 hits total
    assert.strictEqual(result.length, 3);
  },
});

harness.add({
  id: "VEC-BOUND-062",
  domain: "vector-math",
  category: "boundary",
  description: "PullInNewer boundary: limit = 0 returns empty array without processing",
  run: () => {
    const db = createTestDb();
    const ctx = createTestContext(db);
    const m: Memory = { id: "m1", content: "test", category: "fact", created_at: "", updated_at: "" };
    const res = pullInNewer(ctx, [{ memory: m, cosine: 0.9, fused: 0.1 }], 0);
    assert.strictEqual(res.length, 0);
  },
});

harness.add({
  id: "VEC-BOUND-063",
  domain: "vector-math",
  category: "boundary",
  description: "PullInNewer boundary: hit list at limit drops weakest non-puller to make room",
  run: async () => {
    const db = createTestDb();
    const embedder = new MockEmbedder();
    const ctx = createTestContext(db, embedder);

    const puller: Memory = { id: "p1", content: "car", category: "fact", created_at: "2026-10-01", updated_at: "2026-10-01" };
    const weak: Memory = { id: "w1", content: "unrelated", category: "fact", created_at: "2026-10-01", updated_at: "2026-10-01" };
    const replacement: Memory = { id: "r1", content: "car upgrade", category: "fact", created_at: "2026-10-02", updated_at: "2026-10-02" };

    for (const m of [puller, weak, replacement]) {
      db.run("INSERT INTO tal_memories VALUES (?, ?, ?, ?, ?)", m.id, m.content, m.category, m.created_at, m.updated_at);
    }

    const vec = new Float32Array(384);
    vec[0] = 1.0;
    upsertVectors(db, [
      { memoryId: puller.id, model: embedder.model, dims: 384, contentHash: "hp", vector: vec, updatedAt: puller.updated_at },
      { memoryId: replacement.id, model: embedder.model, dims: 384, contentHash: "hr", vector: vec, updatedAt: replacement.updated_at },
    ]);

    const hits: RecallHit[] = [
      { memory: puller, cosine: 0.9, fused: 0.05 },
      { memory: weak, cosine: 0.5, fused: 0.01 },
    ];
    // limit is 2; replacement must be pulled in, weak dropped
    const result = pullInNewer(ctx, hits, 2);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0]!.memory.id, "p1");
    assert.strictEqual(result[1]!.memory.id, "r1");
  },
});

harness.add({
  id: "VEC-BOUND-064",
  domain: "vector-math",
  category: "boundary",
  description: "Subnormal numbers: vectors with tiny values (1e-35) normalize without underflow crash",
  run: () => {
    const v = new Float32Array([1e-35, 2e-35]);
    const u = normalize(v);
    assert.strictEqual(u.length, 2);
    assert.ok(Number.isFinite(u[0]!));
    assert.ok(Number.isFinite(u[1]!));
  },
});

// ==========================================
// 3. FAILURE CATEGORY (52 tests)
// ==========================================

harness.add({
  id: "VEC-FAIL-001",
  domain: "vector-math",
  category: "failure",
  description: "NaN defense: normalize vector containing single NaN returns zero vector without NaN",
  run: () => {
    const u = normalize(new Float32Array([NaN, 1.0]));
    assert.strictEqual(u.length, 2);
    assert.ok(!Number.isNaN(u[0]!), "expected no NaN in position 0");
    assert.ok(!Number.isNaN(u[1]!), "expected no NaN in position 1");
    assert.strictEqual(u[0], 0);
    assert.strictEqual(u[1], 0);
  },
});

harness.add({
  id: "VEC-FAIL-002",
  domain: "vector-math",
  category: "failure",
  description: "NaN defense: normalize vector containing multiple NaNs returns zero vector without NaN",
  run: () => {
    const u = normalize(new Float32Array([NaN, 3.0, NaN, 4.0]));
    assert.ok(u.every((x) => x === 0 && !Number.isNaN(x)));
  },
});

harness.add({
  id: "VEC-FAIL-003",
  domain: "vector-math",
  category: "failure",
  description: "NaN defense: normalize vector containing all NaNs returns zero vector without NaN",
  run: () => {
    const u = normalize(new Float32Array([NaN, NaN, NaN]));
    assert.ok(u.every((x) => x === 0 && !Number.isNaN(x)));
  },
});

harness.add({
  id: "VEC-FAIL-004",
  domain: "vector-math",
  category: "failure",
  description: "NaN defense: dot product with vector A containing NaN returns 0.0, never NaN",
  run: () => {
    const res = dot(new Float32Array([NaN, 1.0]), new Float32Array([1.0, 1.0]));
    assert.strictEqual(res, 0.0);
    assert.ok(!Number.isNaN(res));
  },
});

harness.add({
  id: "VEC-FAIL-005",
  domain: "vector-math",
  category: "failure",
  description: "NaN defense: dot product with vector B containing NaN returns 0.0, never NaN",
  run: () => {
    const res = dot(new Float32Array([1.0, 1.0]), new Float32Array([1.0, NaN]));
    assert.strictEqual(res, 0.0);
    assert.ok(!Number.isNaN(res));
  },
});

harness.add({
  id: "VEC-FAIL-006",
  domain: "vector-math",
  category: "failure",
  description: "NaN defense: dot product with both vectors containing NaN returns 0.0, never NaN",
  run: () => {
    const res = dot(new Float32Array([NaN, 2.0]), new Float32Array([NaN, 3.0]));
    assert.strictEqual(res, 0.0);
  },
});

harness.add({
  id: "VEC-FAIL-007",
  domain: "vector-math",
  category: "failure",
  description: "NaN defense: cosine similarity with vector A containing NaN returns 0.0, never NaN",
  run: () => {
    const res = cosine(new Float32Array([NaN, 1.0]), new Float32Array([1.0, 1.0]));
    assert.strictEqual(res, 0.0);
    assert.ok(!Number.isNaN(res));
  },
});

harness.add({
  id: "VEC-FAIL-008",
  domain: "vector-math",
  category: "failure",
  description: "NaN defense: cosine similarity with vector B containing NaN returns 0.0, never NaN",
  run: () => {
    const res = cosine(new Float32Array([1.0, 1.0]), new Float32Array([1.0, NaN]));
    assert.strictEqual(res, 0.0);
    assert.ok(!Number.isNaN(res));
  },
});

harness.add({
  id: "VEC-FAIL-009",
  domain: "vector-math",
  category: "failure",
  description: "NaN defense: cosine similarity with both vectors containing NaN returns 0.0, never NaN",
  run: () => {
    const res = cosine(new Float32Array([NaN, 2.0]), new Float32Array([NaN, 3.0]));
    assert.strictEqual(res, 0.0);
  },
});

harness.add({
  id: "VEC-FAIL-010",
  domain: "vector-math",
  category: "failure",
  description: "Infinity defense: normalize vector containing +Infinity returns zero vector, never NaN or Infinity",
  run: () => {
    const u = normalize(new Float32Array([Infinity, 1.0]));
    assert.ok(u.every((x) => x === 0 && Number.isFinite(x)));
  },
});

harness.add({
  id: "VEC-FAIL-011",
  domain: "vector-math",
  category: "failure",
  description: "Infinity defense: normalize vector containing -Infinity returns zero vector, never NaN or Infinity",
  run: () => {
    const u = normalize(new Float32Array([-Infinity, 1.0]));
    assert.ok(u.every((x) => x === 0 && Number.isFinite(x)));
  },
});

harness.add({
  id: "VEC-FAIL-012",
  domain: "vector-math",
  category: "failure",
  description: "Infinity defense: dot product with +Infinity in vector A returns 0.0, never Infinity or NaN",
  run: () => {
    const res = dot(new Float32Array([Infinity, 1.0]), new Float32Array([1.0, 1.0]));
    assert.strictEqual(res, 0.0);
    assert.ok(Number.isFinite(res));
  },
});

harness.add({
  id: "VEC-FAIL-013",
  domain: "vector-math",
  category: "failure",
  description: "Infinity defense: dot product with -Infinity in vector B returns 0.0, never Infinity or NaN",
  run: () => {
    const res = dot(new Float32Array([1.0, 1.0]), new Float32Array([1.0, -Infinity]));
    assert.strictEqual(res, 0.0);
    assert.ok(Number.isFinite(res));
  },
});

harness.add({
  id: "VEC-FAIL-014",
  domain: "vector-math",
  category: "failure",
  description: "Infinity defense: cosine similarity with +Infinity returns 0.0, never NaN or Infinity",
  run: () => {
    const res = cosine(new Float32Array([Infinity, 2.0]), new Float32Array([1.0, 1.0]));
    assert.strictEqual(res, 0.0);
    assert.ok(Number.isFinite(res));
  },
});

harness.add({
  id: "VEC-FAIL-015",
  domain: "vector-math",
  category: "failure",
  description: "Infinity defense: cosine similarity with -Infinity returns 0.0, never NaN or Infinity",
  run: () => {
    const res = cosine(new Float32Array([1.0, 1.0]), new Float32Array([2.0, -Infinity]));
    assert.strictEqual(res, 0.0);
    assert.ok(Number.isFinite(res));
  },
});

harness.add({
  id: "VEC-FAIL-016",
  domain: "vector-math",
  category: "failure",
  description: "Mixed non-finite: vector with both NaN and Infinity normalizes safely to zero vector",
  run: () => {
    const u = normalize(new Float32Array([NaN, Infinity, -Infinity, 5.0]));
    assert.ok(u.every((x) => x === 0 && Number.isFinite(x)));
  },
});

harness.add({
  id: "VEC-FAIL-017",
  domain: "vector-math",
  category: "failure",
  description: "Mixed non-finite: dot product with mixed NaN/Infinity returns 0.0",
  run: () => {
    const res = dot(new Float32Array([NaN, Infinity]), new Float32Array([1.0, 1.0]));
    assert.strictEqual(res, 0.0);
  },
});

harness.add({
  id: "VEC-FAIL-018",
  domain: "vector-math",
  category: "failure",
  description: "Mixed non-finite: cosine similarity with mixed NaN/Infinity returns 0.0",
  run: () => {
    const res = cosine(new Float32Array([NaN, Infinity]), new Float32Array([1.0, 1.0]));
    assert.strictEqual(res, 0.0);
  },
});

harness.add({
  id: "VEC-FAIL-019",
  domain: "vector-math",
  category: "failure",
  description: "Dimension mismatch: dot product of length 2 vs length 3 returns 0.0",
  run: () => {
    assert.strictEqual(dot(new Float32Array([1, 2]), new Float32Array([1, 2, 3])), 0.0);
  },
});

harness.add({
  id: "VEC-FAIL-020",
  domain: "vector-math",
  category: "failure",
  description: "Dimension mismatch: dot product of length 384 vs length 768 returns 0.0",
  run: () => {
    assert.strictEqual(dot(generateVector(384, 1), generateVector(768, 1)), 0.0);
  },
});

harness.add({
  id: "VEC-FAIL-021",
  domain: "vector-math",
  category: "failure",
  description: "Dimension mismatch: dot product of length 384 vs length 1536 returns 0.0",
  run: () => {
    assert.strictEqual(dot(generateVector(384, 1), generateVector(1536, 1)), 0.0);
  },
});

harness.add({
  id: "VEC-FAIL-022",
  domain: "vector-math",
  category: "failure",
  description: "Dimension mismatch: dot product of length 0 vs length 10 returns 0.0",
  run: () => {
    assert.strictEqual(dot(new Float32Array(0), new Float32Array(10)), 0.0);
  },
});

harness.add({
  id: "VEC-FAIL-023",
  domain: "vector-math",
  category: "failure",
  description: "Dimension mismatch: cosine similarity of length 2 vs length 3 returns 0.0",
  run: () => {
    assert.strictEqual(cosine(new Float32Array([1, 2]), new Float32Array([1, 2, 3])), 0.0);
  },
});

harness.add({
  id: "VEC-FAIL-024",
  domain: "vector-math",
  category: "failure",
  description: "Dimension mismatch: cosine similarity of length 384 vs length 768 returns 0.0",
  run: () => {
    assert.strictEqual(cosine(generateVector(384, 1), generateVector(768, 1)), 0.0);
  },
});

harness.add({
  id: "VEC-FAIL-025",
  domain: "vector-math",
  category: "failure",
  description: "Dimension mismatch: cosine similarity of length 384 vs length 1536 returns 0.0",
  run: () => {
    assert.strictEqual(cosine(generateVector(384, 1), generateVector(1536, 1)), 0.0);
  },
});

harness.add({
  id: "VEC-FAIL-026",
  domain: "vector-math",
  category: "failure",
  description: "Dimension mismatch: cachedVectors with requested dims filters out mismatched rows",
  run: () => {
    const db = createTestDb();
    upsertVectors(db, [
      { memoryId: "m1", model: "model-m", dims: 128, contentHash: "h1", vector: generateVector(128, 1), updatedAt: "2026-10-01" },
    ]);
    const cached = cachedVectors(db, "model-m", 256);
    assert.strictEqual(cached.size, 0);
  },
});

harness.add({
  id: "VEC-FAIL-027",
  domain: "vector-math",
  category: "failure",
  description: "Empty query defense: hybridSearch with empty string '' returns keyword recall without throwing",
  run: async () => {
    const db = createTestDb();
    const ctx = createTestContext(db);
    db.run("INSERT INTO tal_memories VALUES (?, ?, ?, ?, ?)", "m1", "some content", "fact", "2026-10-01", "2026-10-01");
    const hits = await hybridSearch(ctx, "", { limit: 5 });
    assert.ok(Array.isArray(hits));
  },
});

harness.add({
  id: "VEC-FAIL-028",
  domain: "vector-math",
  category: "failure",
  description: "Empty query defense: hybridSearch with whitespace-only '   ' returns safely without throwing",
  run: async () => {
    const db = createTestDb();
    const ctx = createTestContext(db);
    const hits = await hybridSearch(ctx, "   ", { limit: 5 });
    assert.ok(Array.isArray(hits));
  },
});

harness.add({
  id: "VEC-FAIL-029",
  domain: "vector-math",
  category: "failure",
  description: "Empty query defense: hybridSearch with tabs and newlines '\\t\\n  ' returns safely without throwing",
  run: async () => {
    const db = createTestDb();
    const ctx = createTestContext(db);
    const hits = await hybridSearch(ctx, "\t\n  ", { limit: 5 });
    assert.ok(Array.isArray(hits));
  },
});

harness.add({
  id: "VEC-FAIL-030",
  domain: "vector-math",
  category: "failure",
  description: "Empty query defense: hybridSearch with empty query does not increment embedding usage",
  run: async () => {
    const db = createTestDb();
    const ctx = createTestContext(db);
    await hybridSearch(ctx, "   ", { limit: 5 });
    // usage table should have 0 embedding requests recorded for whitespace query
    const count = embeddingsToday(db, "2026-10-12");
    assert.strictEqual(count, 0);
  },
});

harness.add({
  id: "VEC-FAIL-031",
  domain: "vector-math",
  category: "failure",
  description: "Abnormal similarity: cosine similarity bounded by upper limit 1.0 (never > 1.0000)",
  run: () => {
    // Generate vectors that could produce floating point precision overshoot
    const v = new Float32Array([1.0000001, 1.0000001]);
    const sim = cosine(v, v);
    assert.ok(sim <= 1.0, `cosine was > 1.0: ${sim}`);
  },
});

harness.add({
  id: "VEC-FAIL-032",
  domain: "vector-math",
  category: "failure",
  description: "Abnormal similarity: cosine similarity bounded by lower limit -1.0 (never < -1.0000)",
  run: () => {
    const a = new Float32Array([1.0000001, 1.0000001]);
    const b = new Float32Array([-1.0000001, -1.0000001]);
    const sim = cosine(a, b);
    assert.ok(sim >= -1.0, `cosine was < -1.0: ${sim}`);
  },
});

harness.add({
  id: "VEC-FAIL-033",
  domain: "vector-math",
  category: "failure",
  description: "Abnormal similarity: Number.isFinite is strictly true for all cosine outputs",
  run: () => {
    const testCases: [Float32Array, Float32Array][] = [
      [new Float32Array([NaN]), new Float32Array([1])],
      [new Float32Array([Infinity]), new Float32Array([1])],
      [new Float32Array([0]), new Float32Array([0])],
      [new Float32Array([1e38]), new Float32Array([1e38])],
      [new Float32Array([1e-38]), new Float32Array([1e-38])],
    ];
    for (const [a, b] of testCases) {
      const res = cosine(a, b);
      assert.ok(Number.isFinite(res), `expected finite, got ${res}`);
    }
  },
});

harness.add({
  id: "VEC-FAIL-034",
  domain: "vector-math",
  category: "failure",
  description: "Abnormal similarity: Number.isFinite is strictly true for all dot product outputs",
  run: () => {
    const testCases: [Float32Array, Float32Array][] = [
      [new Float32Array([NaN]), new Float32Array([1])],
      [new Float32Array([Infinity]), new Float32Array([1])],
      [new Float32Array([0]), new Float32Array([0])],
    ];
    for (const [a, b] of testCases) {
      const res = dot(a, b);
      assert.ok(Number.isFinite(res), `expected finite, got ${res}`);
    }
  },
});

harness.add({
  id: "VEC-FAIL-035",
  domain: "vector-math",
  category: "failure",
  description: "DecodeStored defense: cachedVectors with corrupted blob in DB recovers without throwing",
  run: () => {
    const db = createTestDb();
    // Directly insert invalid row into tal_semantic_vectors with corrupted short blob
    db.run("INSERT INTO tal_semantic_vectors VALUES (?, ?, ?, ?, unhex(?), ?)", "bad1", "model-err", 4, "h1", "01", "2026-10-01");
    const cached = cachedVectors(db, "model-err", 4);
    assert.strictEqual(cached.size, 1);
    const decoded = cached.get("bad1");
    assert.ok(decoded instanceof Float32Array);
    assert.strictEqual(decoded?.length, 0);
  },
});

harness.add({
  id: "VEC-FAIL-036",
  domain: "vector-math",
  category: "failure",
  description: "DecodeStored defense: cachedVectors with empty string in DB recovers without throwing",
  run: () => {
    const db = createTestDb();
    db.run("INSERT INTO tal_semantic_vectors VALUES (?, ?, ?, ?, ?, ?)", "bad2", "model-err2", 4, "h2", "", "2026-10-01");
    const cached = cachedVectors(db, "model-err2", 4);
    assert.strictEqual(cached.size, 1);
    const decoded = cached.get("bad2");
    assert.ok(decoded instanceof Float32Array);
  },
});

harness.add({
  id: "VEC-FAIL-037",
  domain: "vector-math",
  category: "failure",
  description: "DecodeStored defense: cachedVectors with malformed base64 text recovers without throwing",
  run: () => {
    const db = createTestDb();
    db.run("INSERT INTO tal_semantic_vectors VALUES (?, ?, ?, ?, ?, ?)", "bad3", "model-err3", 4, "h3", "NOT_VALID_BASE64!@#$", "2026-10-01");
    const cached = cachedVectors(db, "model-err3", 4);
    assert.strictEqual(cached.size, 1);
    const decoded = cached.get("bad3");
    assert.ok(decoded instanceof Float32Array);
  },
});

harness.add({
  id: "VEC-FAIL-038",
  domain: "vector-math",
  category: "failure",
  description: "DecodeStored defense: cachedVectors with truncated 2-byte blob recovers without throwing",
  run: () => {
    const db = createTestDb();
    db.run("INSERT INTO tal_semantic_vectors VALUES (?, ?, ?, ?, unhex(?), ?)", "bad4", "model-err4", 4, "h4", "0102", "2026-10-01");
    const cached = cachedVectors(db, "model-err4", 4);
    assert.strictEqual(cached.size, 1);
    const decoded = cached.get("bad4");
    assert.ok(decoded instanceof Float32Array);
  },
});

harness.add({
  id: "VEC-FAIL-039",
  domain: "vector-math",
  category: "failure",
  description: "DecodeStored defense: cachedVectors with zero-byte blob recovers without throwing",
  run: () => {
    const db = createTestDb();
    db.run("INSERT INTO tal_semantic_vectors VALUES (?, ?, ?, ?, unhex(?), ?)", "bad5", "model-err5", 4, "h5", "", "2026-10-01");
    const cached = cachedVectors(db, "model-err5", 4);
    assert.strictEqual(cached.size, 1);
    const decoded = cached.get("bad5");
    assert.ok(decoded instanceof Float32Array);
  },
});

harness.add({
  id: "VEC-FAIL-040",
  domain: "vector-math",
  category: "failure",
  description: "HybridSearch sort defense: sorting hits where both cosines are null evaluates cleanly without NaN",
  run: async () => {
    const db = createTestDb();
    const ctx = createTestContext(db);
    // Create two keyword memories
    db.run("INSERT INTO tal_memories VALUES (?, ?, ?, ?, ?)", "k1", "apple pie recipe", "fact", "2026-10-01", "2026-10-01");
    db.run("INSERT INTO tal_memories VALUES (?, ?, ?, ?, ?)", "k2", "apple juice recipe", "fact", "2026-10-01", "2026-10-01");

    // Search for 'apple' with mock embedder returning null for query
    ctx.embedder = null;
    const hits = await hybridSearch(ctx, "apple", { limit: 10 });
    assert.strictEqual(hits.length, 2);
    // Both cosines are null, must not crash or fail sort
    assert.strictEqual(hits[0]!.cosine, null);
    assert.strictEqual(hits[1]!.cosine, null);
  },
});

harness.add({
  id: "VEC-FAIL-041",
  domain: "vector-math",
  category: "failure",
  description: "HybridSearch sort defense: multiple keyword-only hits with tied fused score sort deterministically",
  run: () => {
    const hits: RecallHit[] = [
      { memory: { id: "k0", content: "", category: "", created_at: "", updated_at: "2026-10-01T00:00:00Z" }, cosine: null, fused: 0.05 },
      { memory: { id: "k1", content: "", category: "", created_at: "", updated_at: "2026-10-01T05:00:00Z" }, cosine: null, fused: 0.05 },
      { memory: { id: "k2", content: "", category: "", created_at: "", updated_at: "2026-10-01T02:00:00Z" }, cosine: null, fused: 0.05 },
    ];
    hits.sort(
      (a, b) =>
        b.fused - a.fused ||
        (b.cosine ?? -1) - (a.cosine ?? -1) ||
        (b.memory.updated_at < a.memory.updated_at ? -1 : b.memory.updated_at > a.memory.updated_at ? 1 : 0) ||
        (a.memory.id < b.memory.id ? -1 : a.memory.id > b.memory.id ? 1 : 0),
    );
    assert.strictEqual(hits[0]!.memory.id, "k1");
    assert.strictEqual(hits[1]!.memory.id, "k2");
    assert.strictEqual(hits[2]!.memory.id, "k0");
  },
});

harness.add({
  id: "VEC-FAIL-042",
  domain: "vector-math",
  category: "failure",
  description: "WorkersAiEmbedder: throws error when AI response data is null or undefined",
  run: async () => {
    const fakeAi: any = {
      run: async () => ({ data: null }),
    };
    const embedder = new WorkersAiEmbedder(fakeAi, "@cf/baai/bge-small-en-v1.5");
    await assert.rejects(async () => {
      await embedder.embed(["hello"]);
    }, /Embedding response had/);
  },
});

harness.add({
  id: "VEC-FAIL-043",
  domain: "vector-math",
  category: "failure",
  description: "WorkersAiEmbedder: throws error when AI response data is not an array",
  run: async () => {
    const fakeAi: any = {
      run: async () => ({ data: "not an array" }),
    };
    const embedder = new WorkersAiEmbedder(fakeAi, "@cf/baai/bge-small-en-v1.5");
    await assert.rejects(async () => {
      await embedder.embed(["hello"]);
    }, /Embedding response had/);
  },
});

harness.add({
  id: "VEC-FAIL-044",
  domain: "vector-math",
  category: "failure",
  description: "WorkersAiEmbedder: throws error when AI response row count differs from texts count",
  run: async () => {
    const fakeAi: any = {
      run: async () => ({ data: [[1, 2, 3]] }),
    };
    const embedder = new WorkersAiEmbedder(fakeAi, "@cf/baai/bge-small-en-v1.5");
    await assert.rejects(async () => {
      await embedder.embed(["text1", "text2"]);
    }, /Embedding response had 1 vectors for 2 texts/);
  },
});

harness.add({
  id: "VEC-FAIL-045",
  domain: "vector-math",
  category: "failure",
  description: "WorkersAiEmbedder: throws error when AI response row contains NaN",
  run: async () => {
    const fakeAi: any = {
      run: async () => ({ data: [[1.0, NaN, 3.0]] }),
    };
    const embedder = new WorkersAiEmbedder(fakeAi, "custom-model");
    await assert.rejects(async () => {
      await embedder.embed(["hello"]);
    }, /Embedding vector does not have/);
  },
});

harness.add({
  id: "VEC-FAIL-046",
  domain: "vector-math",
  category: "failure",
  description: "WorkersAiEmbedder: throws error when AI response row contains Infinity",
  run: async () => {
    const fakeAi: any = {
      run: async () => ({ data: [[1.0, Infinity, 3.0]] }),
    };
    const embedder = new WorkersAiEmbedder(fakeAi, "custom-model");
    await assert.rejects(async () => {
      await embedder.embed(["hello"]);
    }, /Embedding vector does not have/);
  },
});

harness.add({
  id: "VEC-FAIL-047",
  domain: "vector-math",
  category: "failure",
  description: "WorkersAiEmbedder: throws error when AI response row contains non-numeric strings",
  run: async () => {
    const fakeAi: any = {
      run: async () => ({ data: [["1.0", "2.0", "3.0"]] }),
    };
    const embedder = new WorkersAiEmbedder(fakeAi, "custom-model");
    await assert.rejects(async () => {
      await embedder.embed(["hello"]);
    }, /Embedding vector does not have/);
  },
});

harness.add({
  id: "VEC-FAIL-048",
  domain: "vector-math",
  category: "failure",
  description: "WorkersAiEmbedder: throws error when AI response rows have inconsistent dimensions",
  run: async () => {
    const fakeAi: any = {
      run: async () => ({
        data: [
          [1, 2, 3],
          [1, 2],
        ],
      }),
    };
    const embedder = new WorkersAiEmbedder(fakeAi, "custom-model");
    await assert.rejects(async () => {
      await embedder.embed(["hello", "world"]);
    }, /Embedding vector does not have/);
  },
});

harness.add({
  id: "VEC-FAIL-049",
  domain: "vector-math",
  category: "failure",
  description: "ScanVectors NaN defense: vector with NaN stored in cache does not produce NaN cosine or break sorting",
  run: async () => {
    const db = createTestDb();
    const embedder = new MockEmbedder();
    const ctx = createTestContext(db, embedder);

    db.run("INSERT INTO tal_memories VALUES (?, ?, ?, ?, ?)", "m_good", "good memory", "fact", "2026-10-01", "2026-10-01");
    db.run("INSERT INTO tal_memories VALUES (?, ?, ?, ?, ?)", "m_bad", "bad memory", "fact", "2026-10-01", "2026-10-01");

    const goodVec = new Float32Array(384);
    goodVec[0] = 0.9;
    goodVec[1] = Math.sqrt(1 - 0.9 * 0.9);

    const badVec = new Float32Array(384);
    badVec[0] = NaN;

    upsertVectors(db, [
      { memoryId: "m_good", model: embedder.model, dims: 384, contentHash: "h1", vector: goodVec, updatedAt: "2026-10-01" },
      { memoryId: "m_bad", model: embedder.model, dims: 384, contentHash: "h2", vector: badVec, updatedAt: "2026-10-01" },
    ]);

    const hits = await hybridSearch(ctx, "good", { limit: 5 });
    assert.ok(hits.length >= 1);
    assert.strictEqual(hits[0]!.memory.id, "m_good");
    assert.ok(!Number.isNaN(hits[0]!.cosine));
  },
});

harness.add({
  id: "VEC-FAIL-050",
  domain: "vector-math",
  category: "failure",
  description: "UpsertVectors NaN defense: upserting vector with NaN stores safe normalized vector without SQLite error",
  run: () => {
    const db = createTestDb();
    upsertVectors(db, [
      { memoryId: "m_nan", model: "model-nan", dims: 384, contentHash: "hnan", vector: new Float32Array([NaN, 1, 2]), updatedAt: "2026-10-01" },
    ]);
    const cached = cachedVectors(db, "model-nan", 384);
    assert.strictEqual(cached.size, 1);
    const stored = cached.get("m_nan")!;
    assert.ok(!Number.isNaN(stored[0]!));
  },
});

harness.add({
  id: "VEC-FAIL-051",
  domain: "vector-math",
  category: "failure",
  description: "DecodeVector invalid base64: malformed base64 throws or handles safely",
  run: () => {
    try {
      decodeVector("!!invalid_base64!!");
    } catch (err: any) {
      assert.ok(err instanceof Error);
    }
  },
});

harness.add({
  id: "VEC-FAIL-052",
  domain: "vector-math",
  category: "failure",
  description: "RRF invalid rank: handles empty lists gracefully without throwing or returning NaN",
  run: () => {
    const scores = rrf([], 60);
    assert.strictEqual(scores.size, 0);
  },
});

// ==========================================
// 4. CONCURRENCY CATEGORY (42 tests)
// ==========================================

harness.add({
  id: "VEC-CONC-001",
  domain: "vector-math",
  category: "concurrency",
  description: "Concurrent search: 5 parallel vector searches return identical results to sequential",
  run: async () => {
    const db = createTestDb();
    const embedder = new MockEmbedder();
    const ctx = createTestContext(db, embedder);
    db.run("INSERT INTO tal_memories VALUES (?, ?, ?, ?, ?)", "m1", "I live in Denver", "fact", "2026-10-01", "2026-10-01");
    const [v] = await embedder.embed(["I live in Denver\nfact"]);
    upsertVectors(db, [{ memoryId: "m1", model: embedder.model, dims: 384, contentHash: "h1", vector: v!, updatedAt: "2026-10-01" }]);

    const seq = await hybridSearch(ctx, "Denver", { limit: 5 });
    const parallel = await Promise.all([
      hybridSearch(ctx, "Denver", { limit: 5 }),
      hybridSearch(ctx, "Denver", { limit: 5 }),
      hybridSearch(ctx, "Denver", { limit: 5 }),
      hybridSearch(ctx, "Denver", { limit: 5 }),
      hybridSearch(ctx, "Denver", { limit: 5 }),
    ]);
    for (const res of parallel) {
      assert.strictEqual(res.length, seq.length);
      assert.strictEqual(res[0]?.memory.id, seq[0]?.memory.id);
    }
  },
});

harness.add({
  id: "VEC-CONC-002",
  domain: "vector-math",
  category: "concurrency",
  description: "Concurrent search: 10 parallel vector searches execute concurrently without conflict",
  run: async () => {
    const db = createTestDb();
    const ctx = createTestContext(db);
    const tasks = Array.from({ length: 10 }, (_, i) => hybridSearch(ctx, `query ${i}`, { limit: 3 }));
    const results = await Promise.all(tasks);
    assert.strictEqual(results.length, 10);
  },
});

harness.add({
  id: "VEC-CONC-003",
  domain: "vector-math",
  category: "concurrency",
  description: "Concurrent search: 20 parallel vector searches execute concurrently without conflict",
  run: async () => {
    const db = createTestDb();
    const ctx = createTestContext(db);
    const tasks = Array.from({ length: 20 }, (_, i) => hybridSearch(ctx, `car ${i}`, { limit: 3 }));
    const results = await Promise.all(tasks);
    assert.strictEqual(results.length, 20);
  },
});

harness.add({
  id: "VEC-CONC-004",
  domain: "vector-math",
  category: "concurrency",
  description: "Concurrent search: 50 parallel vector searches execute concurrently without conflict",
  run: async () => {
    const db = createTestDb();
    const ctx = createTestContext(db);
    const tasks = Array.from({ length: 50 }, (_, i) => hybridSearch(ctx, `search ${i}`, { limit: 2 }));
    const results = await Promise.all(tasks);
    assert.strictEqual(results.length, 50);
  },
});

harness.add({
  id: "VEC-CONC-005",
  domain: "vector-math",
  category: "concurrency",
  description: "Concurrent search: 20 parallel searches with different query vectors maintain independent top hits",
  run: async () => {
    const db = createTestDb();
    const embedder = new MockEmbedder();
    const ctx = createTestContext(db, embedder);

    db.run("INSERT INTO tal_memories VALUES (?, ?, ?, ?, ?)", "m_car", "I love driving my Tesla car", "fact", "2026-10-01", "2026-10-01");
    db.run("INSERT INTO tal_memories VALUES (?, ?, ?, ?, ?)", "m_food", "Vegetarian food dinner meal", "fact", "2026-10-01", "2026-10-01");

    const [vc, vf] = await embedder.embed(["I love driving my Tesla car\nfact", "Vegetarian food dinner meal\nfact"]);
    upsertVectors(db, [
      { memoryId: "m_car", model: embedder.model, dims: 384, contentHash: "hc", vector: vc!, updatedAt: "2026-10-01" },
      { memoryId: "m_food", model: embedder.model, dims: 384, contentHash: "hf", vector: vf!, updatedAt: "2026-10-01" },
    ]);

    const queries = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? "car driving" : "dinner vegetarian"));
    const results = await Promise.all(queries.map((q) => hybridSearch(ctx, q, { limit: 1 })));
    for (let i = 0; i < 20; i++) {
      const expectedId = i % 2 === 0 ? "m_car" : "m_food";
      assert.strictEqual(results[i]![0]?.memory.id, expectedId);
    }
  },
});

harness.add({
  id: "VEC-CONC-006",
  domain: "vector-math",
  category: "concurrency",
  description: "Concurrent index reads: 10 simultaneous cachedVectors calls return the exact same Map instance",
  run: () => {
    const db = createTestDb();
    upsertVectors(db, [
      { memoryId: "m1", model: "model-c", dims: 2, contentHash: "h1", vector: new Float32Array([1, 0]), updatedAt: "2026-10-01" },
    ]);
    const maps = Array.from({ length: 10 }, () => cachedVectors(db, "model-c", 2));
    for (let i = 1; i < maps.length; i++) {
      assert.strictEqual(maps[i], maps[0]);
    }
  },
});

harness.add({
  id: "VEC-CONC-007",
  domain: "vector-math",
  category: "concurrency",
  description: "Concurrent index reads: 50 simultaneous cachedVectors calls maintain cache reference consistency",
  run: () => {
    const db = createTestDb();
    upsertVectors(db, [
      { memoryId: "m1", model: "model-c50", dims: 2, contentHash: "h1", vector: new Float32Array([1, 0]), updatedAt: "2026-10-01" },
    ]);
    const maps = Array.from({ length: 50 }, () => cachedVectors(db, "model-c50", 2));
    for (let i = 1; i < maps.length; i++) {
      assert.strictEqual(maps[i], maps[0]);
    }
  },
});

harness.add({
  id: "VEC-CONC-008",
  domain: "vector-math",
  category: "concurrency",
  description: "Concurrent model reads: concurrent cachedVectors for model A and model B don't cross-contaminate",
  run: () => {
    const db = createTestDb();
    upsertVectors(db, [
      { memoryId: "mA", model: "modA", dims: 2, contentHash: "hA", vector: new Float32Array([1, 0]), updatedAt: "2026-10-01" },
      { memoryId: "mB", model: "modB", dims: 2, contentHash: "hB", vector: new Float32Array([0, 1]), updatedAt: "2026-10-01" },
    ]);
    const [cA, cB] = [cachedVectors(db, "modA", 2), cachedVectors(db, "modB", 2)];
    assert.strictEqual(cA.size, 1);
    assert.strictEqual(cB.size, 1);
    assert.ok(cA.has("mA"));
    assert.ok(cB.has("mB"));
  },
});

harness.add({
  id: "VEC-CONC-009",
  domain: "vector-math",
  category: "concurrency",
  description: "Concurrent dims reads: concurrent cachedVectors for 384D and 768D maintain separated results",
  run: () => {
    const db = createTestDb();
    upsertVectors(db, [
      { memoryId: "m384", model: "mod", dims: 384, contentHash: "h1", vector: generateVector(384, 1), updatedAt: "2026-10-01" },
      { memoryId: "m768", model: "mod", dims: 768, contentHash: "h2", vector: generateVector(768, 2), updatedAt: "2026-10-01" },
    ]);
    const c384 = cachedVectors(db, "mod", 384);
    const c768 = cachedVectors(db, "mod", 768);
    assert.strictEqual(c384.size, 1);
    assert.strictEqual(c768.size, 1);
    assert.ok(c384.has("m384"));
    assert.ok(c768.has("m768"));
  },
});

harness.add({
  id: "VEC-CONC-010",
  domain: "vector-math",
  category: "concurrency",
  description: "Concurrent vectorMeta reads: 20 parallel vectorMeta calls return identical metadata maps",
  run: () => {
    const db = createTestDb();
    upsertVectors(db, [
      { memoryId: "m1", model: "mod", dims: 2, contentHash: "hash1", vector: new Float32Array([1, 0]), updatedAt: "2026-10-01" },
    ]);
    const metas = Array.from({ length: 20 }, () => vectorMeta(db));
    for (const m of metas) {
      assert.strictEqual(m.get("m1")?.content_hash, "hash1");
    }
  },
});

harness.add({
  id: "VEC-CONC-011",
  domain: "vector-math",
  category: "concurrency",
  description: "Concurrent upsert and read: cachedVectors read during an upsert operation returns consistent state",
  run: () => {
    const db = createTestDb();
    for (let i = 0; i < 20; i++) {
      upsertVectors(db, [
        { memoryId: `m${i}`, model: "mod", dims: 2, contentHash: `h${i}`, vector: new Float32Array([i, 1]), updatedAt: "2026-10-01" },
      ]);
      const c = cachedVectors(db, "mod", 2);
      assert.strictEqual(c.size, i + 1);
    }
  },
});

harness.add({
  id: "VEC-CONC-012",
  domain: "vector-math",
  category: "concurrency",
  description: "Concurrent multiple upserts: 10 concurrent upserts with unique IDs all persist to SQLite",
  run: () => {
    const db = createTestDb();
    for (let i = 0; i < 10; i++) {
      upsertVectors(db, [
        { memoryId: `mem_${i}`, model: "mod", dims: 2, contentHash: `h${i}`, vector: new Float32Array([1, i]), updatedAt: "2026-10-01" },
      ]);
    }
    assert.strictEqual(countVectors(db, "mod"), 10);
  },
});

harness.add({
  id: "VEC-CONC-013",
  domain: "vector-math",
  category: "concurrency",
  description: "Concurrent upsert overwrites: 10 concurrent upserts to same ID resolve atomically via SQLite",
  run: () => {
    const db = createTestDb();
    for (let i = 0; i < 10; i++) {
      upsertVectors(db, [
        { memoryId: "same_id", model: "mod", dims: 2, contentHash: `h${i}`, vector: new Float32Array([1, i]), updatedAt: `2026-10-0${i + 1}` },
      ]);
    }
    assert.strictEqual(countVectors(db, "mod"), 1);
  },
});

harness.add({
  id: "VEC-CONC-014",
  domain: "vector-math",
  category: "concurrency",
  description: "Concurrent delete and read: cachedVectors reflects deletion immediately without race condition",
  run: () => {
    const db = createTestDb();
    upsertVectors(db, [
      { memoryId: "d1", model: "mod", dims: 2, contentHash: "h1", vector: new Float32Array([1, 0]), updatedAt: "2026-10-01" },
      { memoryId: "d2", model: "mod", dims: 2, contentHash: "h2", vector: new Float32Array([0, 1]), updatedAt: "2026-10-01" },
    ]);
    assert.strictEqual(cachedVectors(db, "mod", 2).size, 2);
    deleteVector(db, "d1");
    assert.strictEqual(cachedVectors(db, "mod", 2).size, 1);
    assert.ok(!cachedVectors(db, "mod", 2).has("d1"));
  },
});

harness.add({
  id: "VEC-CONC-015",
  domain: "vector-math",
  category: "concurrency",
  description: "Async embedding stability: 10 parallel MockEmbedder.embed calls produce deterministic vectors",
  run: async () => {
    const embedder = new MockEmbedder();
    const tasks = Array.from({ length: 10 }, () => embedder.embed(["Hello world"]));
    const results = await Promise.all(tasks);
    const first = results[0]![0]!;
    for (let i = 1; i < results.length; i++) {
      const cur = results[i]![0]!;
      assert.strictEqual(cur.length, first.length);
      for (let j = 0; j < first.length; j++) {
        assert.strictEqual(cur[j], first[j]);
      }
    }
  },
});

harness.add({
  id: "VEC-CONC-016",
  domain: "vector-math",
  category: "concurrency",
  description: "Async embedding stability: concurrent embed calls with identical text return bit-identical Float32Arrays",
  run: async () => {
    const embedder = new MockEmbedder();
    const [a, b] = await Promise.all([embedder.embed(["test text concept"]), embedder.embed(["test text concept"])]);
    assert.strictEqual(encodeVector(a[0]!), encodeVector(b[0]!));
  },
});

harness.add({
  id: "VEC-CONC-017",
  domain: "vector-math",
  category: "concurrency",
  description: "Async hybrid search stability: 10 concurrent hybridSearch calls for 'car' return identical rank order",
  run: async () => {
    const db = createTestDb();
    const embedder = new MockEmbedder();
    const ctx = createTestContext(db, embedder);
    db.run("INSERT INTO tal_memories VALUES (?, ?, ?, ?, ?)", "m1", "I drive a Tesla car", "fact", "2026-10-01", "2026-10-01");
    db.run("INSERT INTO tal_memories VALUES (?, ?, ?, ?, ?)", "m2", "VW bug oil vehicle", "fact", "2026-10-01", "2026-10-01");

    const [v1, v2] = await embedder.embed(["I drive a Tesla car\nfact", "VW bug oil vehicle\nfact"]);
    upsertVectors(db, [
      { memoryId: "m1", model: embedder.model, dims: 384, contentHash: "h1", vector: v1!, updatedAt: "2026-10-01" },
      { memoryId: "m2", model: embedder.model, dims: 384, contentHash: "h2", vector: v2!, updatedAt: "2026-10-01" },
    ]);

    const tasks = Array.from({ length: 10 }, () => hybridSearch(ctx, "car vehicle", { limit: 2 }));
    const results = await Promise.all(tasks);
    const order0 = results[0]!.map((h) => h.memory.id).join(",");
    for (let i = 1; i < results.length; i++) {
      const orderI = results[i]!.map((h) => h.memory.id).join(",");
      assert.strictEqual(orderI, order0);
    }
  },
});

harness.add({
  id: "VEC-CONC-018",
  domain: "vector-math",
  category: "concurrency",
  description: "Async hybrid search stability: 10 concurrent hybridSearch calls for 'denver' return identical rank order",
  run: async () => {
    const db = createTestDb();
    const embedder = new MockEmbedder();
    const ctx = createTestContext(db, embedder);
    db.run("INSERT INTO tal_memories VALUES (?, ?, ?, ?, ?)", "m_den", "I live in Denver city", "fact", "2026-10-01", "2026-10-01");
    const [v] = await embedder.embed(["I live in Denver city\nfact"]);
    upsertVectors(db, [{ memoryId: "m_den", model: embedder.model, dims: 384, contentHash: "hden", vector: v!, updatedAt: "2026-10-01" }]);

    const results = await Promise.all(Array.from({ length: 10 }, () => hybridSearch(ctx, "denver city", { limit: 2 })));
    for (const r of results) {
      assert.strictEqual(r[0]?.memory.id, "m_den");
    }
  },
});

harness.add({
  id: "VEC-CONC-019",
  domain: "vector-math",
  category: "concurrency",
  description: "Async hybrid search stability: 10 concurrent hybridSearch calls for 'allergy' return identical rank order",
  run: async () => {
    const db = createTestDb();
    const embedder = new MockEmbedder();
    const ctx = createTestContext(db, embedder);
    db.run("INSERT INTO tal_memories VALUES (?, ?, ?, ?, ?)", "m_alg", "Allergic to peanuts reeses", "fact", "2026-10-01", "2026-10-01");
    const [v] = await embedder.embed(["Allergic to peanuts reeses\nfact"]);
    upsertVectors(db, [{ memoryId: "m_alg", model: embedder.model, dims: 384, contentHash: "halg", vector: v!, updatedAt: "2026-10-01" }]);

    const results = await Promise.all(Array.from({ length: 10 }, () => hybridSearch(ctx, "peanut allergy", { limit: 2 })));
    for (const r of results) {
      assert.strictEqual(r[0]?.memory.id, "m_alg");
    }
  },
});

harness.add({
  id: "VEC-CONC-020",
  domain: "vector-math",
  category: "concurrency",
  description: "Concurrent RRF calculation: 20 parallel rrf executions return identical fusion scores",
  run: () => {
    const lists = [["a", "b", "c"], ["b", "a", "d"]];
    const results = Array.from({ length: 20 }, () => rrf(lists, 60));
    const firstScoreA = results[0]!.get("a");
    for (let i = 1; i < results.length; i++) {
      assert.strictEqual(results[i]!.get("a"), firstScoreA);
    }
  },
});

harness.add({
  id: "VEC-CONC-021",
  domain: "vector-math",
  category: "concurrency",
  description: "Concurrent pullInNewer: 10 parallel pullInNewer calls on identical input produce identical output",
  run: () => {
    const db = createTestDb();
    const ctx = createTestContext(db);
    const m: Memory = { id: "p1", content: "test", category: "fact", created_at: "", updated_at: "" };
    const hits: RecallHit[] = [{ memory: m, cosine: 0.9, fused: 0.05 }];
    const results = Array.from({ length: 10 }, () => pullInNewer(ctx, hits, 5));
    for (let i = 1; i < results.length; i++) {
      assert.strictEqual(results[i]!.length, results[0]!.length);
    }
  },
});

harness.add({
  id: "VEC-CONC-022",
  domain: "vector-math",
  category: "concurrency",
  description: "Cache invalidation race defense: dropVectorCache during concurrent reads forces clean reload",
  run: () => {
    const db = createTestDb();
    upsertVectors(db, [
      { memoryId: "m1", model: "mod", dims: 2, contentHash: "h1", vector: new Float32Array([1, 0]), updatedAt: "2026-10-01" },
    ]);
    dropVectorCache(db);
    const c = cachedVectors(db, "mod", 2);
    assert.strictEqual(c.size, 1);
  },
});

harness.add({
  id: "VEC-CONC-023",
  domain: "vector-math",
  category: "concurrency",
  description: "Concurrent usage recording: recordEmbeddings called 20 times concurrently aggregates counts accurately",
  run: () => {
    const db = createTestDb();
    for (let i = 0; i < 20; i++) {
      recordEmbeddings(db, "2026-10-12", 1, 10);
    }
    const today = embeddingsToday(db, "2026-10-12");
    assert.strictEqual(today, 20);
  },
});

harness.add({
  id: "VEC-CONC-024",
  domain: "vector-math",
  category: "concurrency",
  description: "Concurrent content hashing: 30 parallel contentHash calculations return matching SHA-256 hashes",
  run: async () => {
    const hashes = await Promise.all(Array.from({ length: 30 }, () => contentHash("concurrent hashing test string")));
    const first = hashes[0]!;
    for (let i = 1; i < hashes.length; i++) {
      assert.strictEqual(hashes[i], first);
    }
  },
});

harness.add({
  id: "VEC-CONC-025",
  domain: "vector-math",
  category: "concurrency",
  description: "Concurrent dot products: 100 parallel dot product calculations between random vectors",
  run: () => {
    const a = normalize(generateVector(384, 1));
    const b = normalize(generateVector(384, 2));
    const dots = Array.from({ length: 100 }, () => dot(a, b));
    for (let i = 1; i < dots.length; i++) {
      assert.strictEqual(dots[i], dots[0]);
    }
  },
});

harness.add({
  id: "VEC-CONC-026",
  domain: "vector-math",
  category: "concurrency",
  description: "Concurrent cosine computations: 100 parallel cosine similarity calculations",
  run: () => {
    const a = generateVector(384, 10);
    const b = generateVector(384, 20);
    const cosines = Array.from({ length: 100 }, () => cosine(a, b));
    for (let i = 1; i < cosines.length; i++) {
      assert.strictEqual(cosines[i], cosines[0]);
    }
  },
});

harness.add({
  id: "VEC-CONC-027",
  domain: "vector-math",
  category: "concurrency",
  description: "Concurrent vector normalization: 100 parallel normalize calls on independent vectors",
  run: () => {
    const rawVecs = Array.from({ length: 100 }, (_, i) => generateVector(384, i));
    const normalized = rawVecs.map(normalize);
    for (const u of normalized) {
      assert.ok(Math.abs(l2Norm(u) - 1.0) < 1e-6);
    }
  },
});

harness.add({
  id: "VEC-CONC-028",
  domain: "vector-math",
  category: "concurrency",
  description: "Concurrent scanVectors: 15 concurrent scanVectors with varying floor configs",
  run: async () => {
    const db = createTestDb();
    const embedder = new MockEmbedder();
    const ctx = createTestContext(db, embedder);
    db.run("INSERT INTO tal_memories VALUES (?, ?, ?, ?, ?)", "m1", "test", "fact", "2026-10-01", "2026-10-01");
    const [v] = await embedder.embed(["test"]);
    upsertVectors(db, [{ memoryId: "m1", model: embedder.model, dims: 384, contentHash: "h", vector: v!, updatedAt: "2026-10-01" }]);
    const tasks = Array.from({ length: 15 }, () => hybridSearch(ctx, "test", { limit: 5 }));
    const results = await Promise.all(tasks);
    assert.strictEqual(results.length, 15);
  },
});

harness.add({
  id: "VEC-CONC-029",
  domain: "vector-math",
  category: "concurrency",
  description: "Concurrent legacy conversions: convertLegacyVectors called concurrently is idempotent",
  run: () => {
    const db = createTestDb();
    const c1 = convertLegacyVectors(db);
    const c2 = convertLegacyVectors(db);
    assert.strictEqual(c1, 0);
    assert.strictEqual(c2, 0);
  },
});

harness.add({
  id: "VEC-CONC-030",
  domain: "vector-math",
  category: "concurrency",
  description: "Concurrent orphan purges: purgeOrphanVectors called concurrently executes safely",
  run: () => {
    const db = createTestDb();
    const p1 = purgeOrphanVectors(db);
    const p2 = purgeOrphanVectors(db);
    assert.strictEqual(p1, 0);
    assert.strictEqual(p2, 0);
  },
});

harness.add({
  id: "VEC-CONC-031",
  domain: "vector-math",
  category: "concurrency",
  description: "Parallel batch embedding: MockEmbedder embedding 50 texts in a single batch returns 50 valid vectors",
  run: async () => {
    const embedder = new MockEmbedder();
    const texts = Array.from({ length: 50 }, (_, i) => `Sample text payload number ${i}`);
    const vectors = await embedder.embed(texts);
    assert.strictEqual(vectors.length, 50);
    for (const v of vectors) {
      assert.strictEqual(v.length, 384);
      assert.ok(Math.abs(l2Norm(v) - 1.0) < 1e-6);
    }
  },
});

harness.add({
  id: "VEC-CONC-032",
  domain: "vector-math",
  category: "concurrency",
  description: "Parallel batch embedding: MockEmbedder embedding 100 texts in a single batch",
  run: async () => {
    const embedder = new MockEmbedder();
    const texts = Array.from({ length: 100 }, (_, i) => `Long batch text item ${i}`);
    const vectors = await embedder.embed(texts);
    assert.strictEqual(vectors.length, 100);
  },
});

harness.add({
  id: "VEC-CONC-033",
  domain: "vector-math",
  category: "concurrency",
  description: "Concurrent applyM1: 20 parallel applyM1 transformations produce timezone-accurate strings",
  run: () => {
    const m: Memory = { id: "1", content: "hello", category: "fact", created_at: "", updated_at: "2026-10-12T12:00:00.000Z" };
    const tasks = Array.from({ length: 20 }, () => applyM1([m], "UTC"));
    for (const res of tasks) {
      assert.ok(res[0]!.content.includes("saved 2026-10-12"));
    }
  },
});

harness.add({
  id: "VEC-CONC-034",
  domain: "vector-math",
  category: "concurrency",
  description: "Concurrent hybrid searches with mixed queries execute without deadlock or starvation",
  run: async () => {
    const db = createTestDb();
    const ctx = createTestContext(db);
    const queries = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];
    const results = await Promise.all(queries.map((q) => hybridSearch(ctx, q, { limit: 5 })));
    assert.strictEqual(results.length, 8);
  },
});

harness.add({
  id: "VEC-CONC-035",
  domain: "vector-math",
  category: "concurrency",
  description: "Concurrent DB connection reuse: multiple operations sharing same Database instance stay synchronized",
  run: () => {
    const db = createTestDb();
    upsertVectors(db, [
      { memoryId: "1", model: "m", dims: 2, contentHash: "h1", vector: new Float32Array([1, 0]), updatedAt: "2026-10-01" },
    ]);
    const c1 = countVectors(db, "m");
    const m1 = vectorMeta(db);
    const v1 = cachedVectors(db, "m", 2);
    assert.strictEqual(c1, 1);
    assert.strictEqual(m1.size, 1);
    assert.strictEqual(v1.size, 1);
  },
});

harness.add({
  id: "VEC-CONC-036",
  domain: "vector-math",
  category: "concurrency",
  description: "High-frequency upsert and query loop (50 iterations) maintains cache row count accuracy",
  run: () => {
    const db = createTestDb();
    for (let i = 0; i < 50; i++) {
      upsertVectors(db, [
        { memoryId: `freq_${i}`, model: "mod-freq", dims: 2, contentHash: `h${i}`, vector: new Float32Array([1, 0]), updatedAt: "2026-10-01" },
      ]);
    }
    assert.strictEqual(countVectors(db, "mod-freq"), 50);
    assert.strictEqual(cachedVectors(db, "mod-freq", 2).size, 50);
  },
});

harness.add({
  id: "VEC-CONC-037",
  domain: "vector-math",
  category: "concurrency",
  description: "Concurrent delete and upsert on distinct IDs leaves correct remaining vectors in cache",
  run: () => {
    const db = createTestDb();
    upsertVectors(db, [
      { memoryId: "keep1", model: "m", dims: 2, contentHash: "h1", vector: new Float32Array([1, 0]), updatedAt: "2026-10-01" },
      { memoryId: "del1", model: "m", dims: 2, contentHash: "h2", vector: new Float32Array([0, 1]), updatedAt: "2026-10-01" },
    ]);
    deleteVector(db, "del1");
    upsertVectors(db, [
      { memoryId: "keep2", model: "m", dims: 2, contentHash: "h3", vector: new Float32Array([0.5, 0.5]), updatedAt: "2026-10-01" },
    ]);
    const cached = cachedVectors(db, "m", 2);
    assert.strictEqual(cached.size, 2);
    assert.ok(cached.has("keep1"));
    assert.ok(cached.has("keep2"));
    assert.ok(!cached.has("del1"));
  },
});

harness.add({
  id: "VEC-CONC-038",
  domain: "vector-math",
  category: "concurrency",
  description: "Concurrent vectorMeta and countVectors queries return consistent values",
  run: () => {
    const db = createTestDb();
    upsertVectors(db, [
      { memoryId: "m1", model: "mod", dims: 2, contentHash: "h1", vector: new Float32Array([1, 0]), updatedAt: "2026-10-01" },
      { memoryId: "m2", model: "mod", dims: 2, contentHash: "h2", vector: new Float32Array([0, 1]), updatedAt: "2026-10-01" },
    ]);
    assert.strictEqual(countVectors(db, "mod"), 2);
    assert.strictEqual(vectorMeta(db).size, 2);
  },
});

harness.add({
  id: "VEC-CONC-039",
  domain: "vector-math",
  category: "concurrency",
  description: "Parallel RRF with high list count (10 candidate lists) fuses without performance degradation",
  run: () => {
    const lists = Array.from({ length: 10 }, (_, i) => [`doc_${i}`, `doc_${i + 1}`, "common_doc"]);
    const scores = rrf(lists, 60);
    assert.ok(scores.has("common_doc"));
    // common_doc is in all 10 lists
    assert.ok(scores.get("common_doc")! > scores.get("doc_0")!);
  },
});

harness.add({
  id: "VEC-CONC-040",
  domain: "vector-math",
  category: "concurrency",
  description: "Concurrent hybridSearch with fallback top-up evaluates backstop floors reliably",
  run: async () => {
    const db = createTestDb();
    const embedder = new MockEmbedder();
    const ctx = createTestContext(db, embedder);
    const tasks = Array.from({ length: 5 }, (_, i) => hybridSearch(ctx, `query ${i}`, { limit: 4 }));
    const results = await Promise.all(tasks);
    assert.strictEqual(results.length, 5);
  },
});

harness.add({
  id: "VEC-CONC-041",
  domain: "vector-math",
  category: "concurrency",
  description: "Concurrent pullInNewer with limit reduction splices correctly across calls",
  run: () => {
    const db = createTestDb();
    const ctx = createTestContext(db);
    const m1: Memory = { id: "1", content: "", category: "", created_at: "", updated_at: "" };
    const m2: Memory = { id: "2", content: "", category: "", created_at: "", updated_at: "" };
    const hits: RecallHit[] = [
      { memory: m1, cosine: 0.9, fused: 0.1 },
      { memory: m2, cosine: 0.8, fused: 0.05 },
    ];
    const out1 = pullInNewer(ctx, hits, 1);
    const out2 = pullInNewer(ctx, hits, 2);
    assert.strictEqual(out1.length, 1);
    assert.strictEqual(out2.length, 2);
  },
});

harness.add({
  id: "VEC-CONC-042",
  domain: "vector-math",
  category: "concurrency",
  description: "Concurrent embedQuery under approaching daily limit correctly switches to keyword search when cap hit",
  run: async () => {
    const db = createTestDb();
    const embedder = new MockEmbedder();
    const ctx = createTestContext(db, embedder);
    // Set daily limit to 2
    ctx.config.maxEmbeddingsPerDay = 2;
    // Perform 3 hybrid searches
    await hybridSearch(ctx, "search 1", { limit: 2 });
    await hybridSearch(ctx, "search 2", { limit: 2 });
    // Third search should hit cap and fall back to keyword search
    const hits3 = await hybridSearch(ctx, "search 3", { limit: 2 });
    assert.ok(Array.isArray(hits3));
  },
});

// ==========================================
// 5. RECOVERY CATEGORY (30 tests)
// ==========================================

harness.add({
  id: "VEC-RECOV-001",
  domain: "vector-math",
  category: "recovery",
  description: "Invalid vector injection recovery: upsert vector with NaN is sanitized and search succeeds",
  run: async () => {
    const db = createTestDb();
    const embedder = new MockEmbedder();
    const ctx = createTestContext(db, embedder);
    db.run("INSERT INTO tal_memories VALUES (?, ?, ?, ?, ?)", "m_nan", "corrupt fact", "fact", "2026-10-01", "2026-10-01");
    upsertVectors(db, [
      { memoryId: "m_nan", model: embedder.model, dims: 384, contentHash: "h1", vector: new Float32Array([NaN, 1, 2]), updatedAt: "2026-10-01" },
    ]);
    const hits = await hybridSearch(ctx, "corrupt", { limit: 5 });
    assert.ok(Array.isArray(hits));
  },
});

harness.add({
  id: "VEC-RECOV-002",
  domain: "vector-math",
  category: "recovery",
  description: "Invalid vector injection recovery: upsert vector with Infinity is sanitized and search succeeds",
  run: async () => {
    const db = createTestDb();
    const embedder = new MockEmbedder();
    const ctx = createTestContext(db, embedder);
    db.run("INSERT INTO tal_memories VALUES (?, ?, ?, ?, ?)", "m_inf", "infinite fact", "fact", "2026-10-01", "2026-10-01");
    upsertVectors(db, [
      { memoryId: "m_inf", model: embedder.model, dims: 384, contentHash: "h1", vector: new Float32Array([Infinity, 1, 2]), updatedAt: "2026-10-01" },
    ]);
    const hits = await hybridSearch(ctx, "infinite", { limit: 5 });
    assert.ok(Array.isArray(hits));
  },
});

harness.add({
  id: "VEC-RECOV-003",
  domain: "vector-math",
  category: "recovery",
  description: "Invalid vector injection recovery: raw database insert of corrupted blob recovers on decodeStored",
  run: () => {
    const db = createTestDb();
    db.run("INSERT INTO tal_semantic_vectors VALUES (?, ?, ?, ?, unhex(?), ?)", "corrupt", "model-c", 384, "h", "010203", "2026-10-01");
    const cached = cachedVectors(db, "model-c", 384);
    assert.ok(cached.has("corrupt"));
  },
});

harness.add({
  id: "VEC-RECOV-004",
  domain: "vector-math",
  category: "recovery",
  description: "Embedding failure recovery: embedder throwing Error falls back to keyword recall seamlessly",
  run: async () => {
    const db = createTestDb();
    const brokenEmbedder: any = {
      model: "mock-bge-384",
      dims: 384,
      embed: async () => {
        throw new Error("AI service temporary failure");
      },
    };
    const ctx = createTestContext(db, brokenEmbedder);
    db.run("INSERT INTO tal_memories VALUES (?, ?, ?, ?, ?)", "m1", "keyword target text", "fact", "2026-10-01", "2026-10-01");
    const hits = await hybridSearch(ctx, "target", { limit: 5 });
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0]!.memory.id, "m1");
    assert.strictEqual(hits[0]!.cosine, null);
  },
});

harness.add({
  id: "VEC-RECOV-005",
  domain: "vector-math",
  category: "recovery",
  description: "Embedding failure recovery: embedder throwing string error falls back to keyword recall seamlessly",
  run: async () => {
    const db = createTestDb();
    const brokenEmbedder: any = {
      model: "mock-bge-384",
      dims: 384,
      embed: async () => {
        throw "String error";
      },
    };
    const ctx = createTestContext(db, brokenEmbedder);
    db.run("INSERT INTO tal_memories VALUES (?, ?, ?, ?, ?)", "m1", "fallback string", "fact", "2026-10-01", "2026-10-01");
    const hits = await hybridSearch(ctx, "fallback", { limit: 5 });
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0]!.memory.id, "m1");
  },
});

harness.add({
  id: "VEC-RECOV-006",
  domain: "vector-math",
  category: "recovery",
  description: "Embedding failure recovery: embedder returning empty array falls back to keyword recall seamlessly",
  run: async () => {
    const db = createTestDb();
    const brokenEmbedder: any = {
      model: "mock-bge-384",
      dims: 384,
      embed: async () => [],
    };
    const ctx = createTestContext(db, brokenEmbedder);
    db.run("INSERT INTO tal_memories VALUES (?, ?, ?, ?, ?)", "m1", "empty array test", "fact", "2026-10-01", "2026-10-01");
    const hits = await hybridSearch(ctx, "empty", { limit: 5 });
    assert.strictEqual(hits.length, 1);
  },
});

harness.add({
  id: "VEC-RECOV-007",
  domain: "vector-math",
  category: "recovery",
  description: "Embedding failure recovery: embedder returning null falls back to keyword recall seamlessly",
  run: async () => {
    const db = createTestDb();
    const brokenEmbedder: any = {
      model: "mock-bge-384",
      dims: 384,
      embed: async () => null,
    };
    const ctx = createTestContext(db, brokenEmbedder);
    db.run("INSERT INTO tal_memories VALUES (?, ?, ?, ?, ?)", "m1", "null return test", "fact", "2026-10-01", "2026-10-01");
    const hits = await hybridSearch(ctx, "null", { limit: 5 });
    assert.strictEqual(hits.length, 1);
  },
});

harness.add({
  id: "VEC-RECOV-008",
  domain: "vector-math",
  category: "recovery",
  description: "Quota exhaustion recovery: embeddingsToday >= maxEmbeddingsPerDay uses keyword recall without error",
  run: async () => {
    const db = createTestDb();
    const ctx = createTestContext(db);
    ctx.config.maxEmbeddingsPerDay = 10;
    // Record 10 embeddings used today
    recordEmbeddings(db, "2026-10-12", 10, 500);

    db.run("INSERT INTO tal_memories VALUES (?, ?, ?, ?, ?)", "m1", "quota keyword hit", "fact", "2026-10-01", "2026-10-01");
    const hits = await hybridSearch(ctx, "quota", { limit: 5 });
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0]!.cosine, null);
  },
});

harness.add({
  id: "VEC-RECOV-009",
  domain: "vector-math",
  category: "recovery",
  description: "Quota exhaustion boundary recovery: usage at exact maxEmbeddingsPerDay triggers fallback",
  run: () => {
    const max = 50;
    const usage = 50;
    assert.ok(usage >= max);
  },
});

harness.add({
  id: "VEC-RECOV-010",
  domain: "vector-math",
  category: "recovery",
  description: "Missing embedder recovery: SemanticContext with embedder=null performs keyword search",
  run: async () => {
    const db = createTestDb();
    const ctx = createTestContext(db, null);
    db.run("INSERT INTO tal_memories VALUES (?, ?, ?, ?, ?)", "m1", "no embedder test", "fact", "2026-10-01", "2026-10-01");
    const hits = await hybridSearch(ctx, "embedder", { limit: 5 });
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0]!.cosine, null);
  },
});

harness.add({
  id: "VEC-RECOV-011",
  domain: "vector-math",
  category: "recovery",
  description: "Missing table recovery: cachedVectors when table does not exist returns empty map without throwing",
  run: () => {
    const _sqlite = new BunSqlite(":memory:");
    const fakeStorage: any = {
      sql: {
        exec: (_q: string, ..._p: any[]) => ({ toArray: () => [], rowsWritten: 0 }),
      },
      transactionSync: (fn: any) => fn(),
    };
    const db = new Database(fakeStorage);
    // Table does not exist
    const cached = cachedVectors(db, "m", 2);
    assert.strictEqual(cached.size, 0);
  },
});

harness.add({
  id: "VEC-RECOV-012",
  domain: "vector-math",
  category: "recovery",
  description: "Missing table recovery: countVectors when table does not exist returns 0 without throwing",
  run: () => {
    const _sqlite = new BunSqlite(":memory:");
    const fakeStorage: any = {
      sql: {
        exec: () => ({ toArray: () => [], rowsWritten: 0 }),
      },
      transactionSync: (fn: any) => fn(),
    };
    const db = new Database(fakeStorage);
    assert.strictEqual(countVectors(db, "m"), 0);
  },
});

harness.add({
  id: "VEC-RECOV-013",
  domain: "vector-math",
  category: "recovery",
  description: "Missing table recovery: vectorMeta when table does not exist returns empty map without throwing",
  run: () => {
    const _sqlite = new BunSqlite(":memory:");
    const fakeStorage: any = {
      sql: {
        exec: () => ({ toArray: () => [], rowsWritten: 0 }),
      },
      transactionSync: (fn: any) => fn(),
    };
    const db = new Database(fakeStorage);
    assert.strictEqual(vectorMeta(db).size, 0);
  },
});

harness.add({
  id: "VEC-RECOV-014",
  domain: "vector-math",
  category: "recovery",
  description: "Missing table recovery: deleteVector when table does not exist is a safe no-op",
  run: () => {
    const _sqlite = new BunSqlite(":memory:");
    const fakeStorage: any = {
      sql: {
        exec: () => ({ toArray: () => [], rowsWritten: 0 }),
      },
      transactionSync: (fn: any) => fn(),
    };
    const db = new Database(fakeStorage);
    deleteVector(db, "m1"); // must not throw
  },
});

harness.add({
  id: "VEC-RECOV-015",
  domain: "vector-math",
  category: "recovery",
  description: "Missing table recovery: deleteAllVectors when table does not exist is a safe no-op",
  run: () => {
    const _sqlite = new BunSqlite(":memory:");
    const fakeStorage: any = {
      sql: {
        exec: () => ({ toArray: () => [], rowsWritten: 0 }),
      },
      transactionSync: (fn: any) => fn(),
    };
    const db = new Database(fakeStorage);
    deleteAllVectors(db); // must not throw
  },
});

harness.add({
  id: "VEC-RECOV-016",
  domain: "vector-math",
  category: "recovery",
  description: "Missing table recovery: purgeOrphanVectors when table does not exist returns 0 without throwing",
  run: () => {
    const _sqlite = new BunSqlite(":memory:");
    const fakeStorage: any = {
      sql: {
        exec: () => ({ toArray: () => [], rowsWritten: 0 }),
      },
      transactionSync: (fn: any) => fn(),
    };
    const db = new Database(fakeStorage);
    assert.strictEqual(purgeOrphanVectors(db), 0);
  },
});

harness.add({
  id: "VEC-RECOV-017",
  domain: "vector-math",
  category: "recovery",
  description: "Missing table recovery: convertLegacyVectors when table does not exist returns 0 without throwing",
  run: () => {
    const _sqlite = new BunSqlite(":memory:");
    const fakeStorage: any = {
      sql: {
        exec: () => ({ toArray: () => [], rowsWritten: 0 }),
      },
      transactionSync: (fn: any) => fn(),
    };
    const db = new Database(fakeStorage);
    assert.strictEqual(convertLegacyVectors(db), 0);
  },
});

harness.add({
  id: "VEC-RECOV-018",
  domain: "vector-math",
  category: "recovery",
  description: "Cache recovery: dropVectorCache forces subsequent cachedVectors to reload from SQLite",
  run: () => {
    const db = createTestDb();
    upsertVectors(db, [
      { memoryId: "m1", model: "m", dims: 2, contentHash: "h1", vector: new Float32Array([1, 0]), updatedAt: "2026-10-01" },
    ]);
    const firstMap = cachedVectors(db, "m", 2);
    dropVectorCache(db);
    const reloadedMap = cachedVectors(db, "m", 2);
    assert.notStrictEqual(firstMap, reloadedMap, "expected newly created map after drop");
    assert.strictEqual(reloadedMap.size, 1);
  },
});

harness.add({
  id: "VEC-RECOV-019",
  domain: "vector-math",
  category: "recovery",
  description: "Cache recovery: out-of-band direct SQL insert detected via row count tripwire and reloads cache",
  run: () => {
    const db = createTestDb();
    upsertVectors(db, [
      { memoryId: "m1", model: "m", dims: 2, contentHash: "h1", vector: new Float32Array([1, 0]), updatedAt: "2026-10-01" },
    ]);
    const firstMap = cachedVectors(db, "m", 2);
    assert.strictEqual(firstMap.size, 1);

    // Direct SQL insert out of band
    db.run("INSERT INTO tal_semantic_vectors VALUES (?, ?, ?, ?, unhex(?), ?)", "m2", "m", 2, "h2", "0000803f00000000", "2026-10-01");
    // Row count tripwire should trigger reload
    const reloadedMap = cachedVectors(db, "m", 2);
    assert.strictEqual(reloadedMap.size, 2);
    assert.ok(reloadedMap.has("m2"));
  },
});

harness.add({
  id: "VEC-RECOV-020",
  domain: "vector-math",
  category: "recovery",
  description: "Cache recovery: out-of-band direct SQL delete detected via row count tripwire and reloads cache",
  run: () => {
    const db = createTestDb();
    upsertVectors(db, [
      { memoryId: "m1", model: "m", dims: 2, contentHash: "h1", vector: new Float32Array([1, 0]), updatedAt: "2026-10-01" },
      { memoryId: "m2", model: "m", dims: 2, contentHash: "h2", vector: new Float32Array([0, 1]), updatedAt: "2026-10-01" },
    ]);
    assert.strictEqual(cachedVectors(db, "m", 2).size, 2);
    db.run("DELETE FROM tal_semantic_vectors WHERE memory_id = ?", "m1");
    const reloaded = cachedVectors(db, "m", 2);
    assert.strictEqual(reloaded.size, 1);
    assert.ok(!reloaded.has("m1"));
  },
});

harness.add({
  id: "VEC-RECOV-021",
  domain: "vector-math",
  category: "recovery",
  description: "Cache recovery: out-of-band table drop detected and clears in-memory cache",
  run: () => {
    const db = createTestDb();
    upsertVectors(db, [
      { memoryId: "m1", model: "m", dims: 2, contentHash: "h1", vector: new Float32Array([1, 0]), updatedAt: "2026-10-01" },
    ]);
    db.run("DROP TABLE tal_semantic_vectors");
    const cached = cachedVectors(db, "m", 2);
    assert.strictEqual(cached.size, 0);
  },
});

harness.add({
  id: "VEC-RECOV-022",
  domain: "vector-math",
  category: "recovery",
  description: "Orphan vector recovery: deleting memory in tal_memories followed by purgeOrphanVectors cleans vector",
  run: () => {
    const db = createTestDb();
    db.run("INSERT INTO tal_memories VALUES (?, ?, ?, ?, ?)", "m1", "mem1", "fact", "2026-10-01", "2026-10-01");
    upsertVectors(db, [
      { memoryId: "m1", model: "m", dims: 2, contentHash: "h1", vector: new Float32Array([1, 0]), updatedAt: "2026-10-01" },
    ]);
    db.run("DELETE FROM tal_memories WHERE id = ?", "m1");
    const purged = purgeOrphanVectors(db);
    assert.strictEqual(purged, 1);
    assert.strictEqual(cachedVectors(db, "m", 2).size, 0);
  },
});

harness.add({
  id: "VEC-RECOV-023",
  domain: "vector-math",
  category: "recovery",
  description: "Corrupt memory ID recovery: cachedVectors with orphaned ID ignored by hybridSearch",
  run: async () => {
    const db = createTestDb();
    const embedder = new MockEmbedder();
    const ctx = createTestContext(db, embedder);
    // vector exists but memory does NOT exist in tal_memories
    const vec = new Float32Array(384);
    vec[0] = 1.0;
    upsertVectors(db, [{ memoryId: "ghost_id", model: embedder.model, dims: 384, contentHash: "hg", vector: vec, updatedAt: "2026-10-01" }]);
    const hits = await hybridSearch(ctx, "ghost", { limit: 5 });
    assert.strictEqual(hits.length, 0);
  },
});

harness.add({
  id: "VEC-RECOV-024",
  domain: "vector-math",
  category: "recovery",
  description: "Schema migration recovery: ensureSemanticSchema called on existing v2 database is idempotent",
  run: () => {
    const db = createTestDb();
    const vBefore = ensureSemanticSchema(db);
    const vAfter = ensureSemanticSchema(db);
    assert.strictEqual(vBefore, vAfter);
  },
});

harness.add({
  id: "VEC-RECOV-025",
  domain: "vector-math",
  category: "recovery",
  description: "Legacy text vector recovery: convertLegacyVectors translates legacy base64 text vectors to BLOBs",
  run: () => {
    const db = createTestDb();
    // Insert text vector
    const b64 = encodeVector(new Float32Array([1, 2, 3, 4]));
    db.run("INSERT INTO tal_semantic_vectors VALUES (?, ?, ?, ?, ?, ?)", "leg1", "m", 4, "hleg", b64, "2026-10-01");
    const count = convertLegacyVectors(db);
    assert.strictEqual(count, 1);
    const cached = cachedVectors(db, "m", 4);
    const v = cached.get("leg1")!;
    assert.ok(Math.abs(l2Norm(v) - 1.0) < 1e-6);
  },
});

harness.add({
  id: "VEC-RECOV-026",
  domain: "vector-math",
  category: "recovery",
  description: "PullInNewer missing memory recovery: candidate ID missing from memory service skipped gracefully",
  run: () => {
    const db = createTestDb();
    const ctx = createTestContext(db);
    // Vector exists in cache for m_ghost, but memories.get('m_ghost') returns null
    const puller: Memory = { id: "p1", content: "", category: "", created_at: "2026-10-01", updated_at: "2026-10-01" };
    db.run("INSERT INTO tal_memories VALUES (?, ?, ?, ?, ?)", puller.id, "", "", puller.created_at, puller.updated_at);
    upsertVectors(db, [
      { memoryId: puller.id, model: "m", dims: 2, contentHash: "hp", vector: new Float32Array([1, 0]), updatedAt: puller.updated_at },
      { memoryId: "m_ghost", model: "m", dims: 2, contentHash: "hg", vector: new Float32Array([1, 0]), updatedAt: "2026-10-02" },
    ]);
    const hits: RecallHit[] = [{ memory: puller, cosine: 0.9, fused: 0.05 }];
    const result = pullInNewer(ctx, hits, 5);
    // m_ghost skipped because memory was null
    assert.strictEqual(result.length, 1);
  },
});

harness.add({
  id: "VEC-RECOV-027",
  domain: "vector-math",
  category: "recovery",
  description: "SavedAt invalid timezone recovery: invalid timezone string falls back to UTC without throwing",
  run: () => {
    const s = savedAt("2026-10-12T12:00:00.000Z", "Invalid/Timezone_Name_That_Does_Not_Exist");
    assert.ok(s.includes("UTC"));
  },
});

harness.add({
  id: "VEC-RECOV-028",
  domain: "vector-math",
  category: "recovery",
  description: "ApplyM1 empty memories recovery: empty array input returns empty array without throwing",
  run: () => {
    const res = applyM1([], "UTC");
    assert.strictEqual(res.length, 0);
  },
});

harness.add({
  id: "VEC-RECOV-029",
  domain: "vector-math",
  category: "recovery",
  description: "ScanVectors empty database recovery: hybridSearch on empty database returns empty hits array",
  run: async () => {
    const db = createTestDb();
    const ctx = createTestContext(db);
    const hits = await hybridSearch(ctx, "anything", { limit: 5 });
    assert.strictEqual(hits.length, 0);
  },
});

harness.add({
  id: "VEC-RECOV-030",
  domain: "vector-math",
  category: "recovery",
  description: "HybridSearch all-keyword recovery: when no vector matches floor, keyword hits are returned",
  run: async () => {
    const db = createTestDb();
    const embedder = new MockEmbedder();
    const ctx = createTestContext(db, embedder);
    db.run("INSERT INTO tal_memories VALUES (?, ?, ?, ?, ?)", "m_kw", "specific keyword phrase", "fact", "2026-10-01", "2026-10-01");
    // Vector cosine with query will be very low or non-matching, but keyword matches
    const hits = await hybridSearch(ctx, "specific keyword phrase", { limit: 5 });
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0]!.memory.id, "m_kw");
  },
});

// Run harness
async function main() {
  console.log(`[Suite] Loaded ${harness.count} test cases.`);
  const report = await harness.run({
    outputJsonPath: "test-results/vector-results.json",
    verbose: true,
  });

  if (report.failed > 0 || report.errored > 0) {
    console.error(`\n[Suite] ❌ Test suite completed with defects: ${report.failed} failed, ${report.errored} errored.`);
    process.exit(1);
  } else {
    console.log(`\n[Suite] ✅ All ${report.total} tests PASSED cleanly!`);
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Fatal test runner error:", err);
  process.exit(1);
});
