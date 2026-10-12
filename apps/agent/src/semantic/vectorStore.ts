import type { Database } from "../db/database";
import { decodeVector } from "./embeddings";

/**
 * The only module whose SQL touches `tal_semantic_vectors` (the slim v1 `CREATE TABLE` in
 * `migrations.ts` aside). Vectors are stored unit-length as little-endian Float32 BLOBs.
 *
 * Each Durable Object keeps one decoded cache of the vectors of one model and size. Every
 * write below changes SQLite and the cache in the same synchronous call, so the cache never
 * needs to expire. A read compares the cached row count with SQLite and reloads on a mismatch,
 * which catches out-of-band inserts and deletes; an eviction simply loads again.
 */

const TABLE = "tal_semantic_vectors";

/**
 * Slim migration v2: rebuilds the table with `vector BLOB NOT NULL`, same columns and key.
 * Rows keep their base64 TEXT until `convertLegacyVectors` runs in the same transaction.
 */
export const VECTOR_TABLE_V2 = [
  `CREATE TABLE tal_semantic_vectors_v2 (memory_id TEXT PRIMARY KEY, model TEXT NOT NULL, dims INTEGER NOT NULL,
    content_hash TEXT NOT NULL, vector BLOB NOT NULL, updated_at TEXT NOT NULL)`,
  `INSERT INTO tal_semantic_vectors_v2 (memory_id, model, dims, content_hash, vector, updated_at)
    SELECT memory_id, model, dims, content_hash, vector, updated_at FROM tal_semantic_vectors`,
  `DROP TABLE tal_semantic_vectors`,
  `ALTER TABLE tal_semantic_vectors_v2 RENAME TO tal_semantic_vectors`,
];

export interface VectorRow {
  memoryId: string;
  model: string;
  dims: number;
  contentHash: string;
  vector: Float32Array;
  updatedAt: string;
}

export interface VectorMeta {
  model: string;
  dims: number;
  content_hash: string;
}

interface VectorCache {
  model: string;
  /** 0 when the size is unknown: every row of the model. */
  dims: number;
  count: number;
  vectors: Map<string, Float32Array>;
}

/** One cache per database, and so per Durable Object. */
const caches = new WeakMap<Database, VectorCache>();

function hasTable(db: Database): boolean {
  return db.one(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, TABLE) !== null;
}

/** A new unit-length copy of `v`; a zero vector stays zero. Non-finite values return a zero vector. */
export function normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  const out = new Float32Array(v.length);
  if (!Number.isFinite(sum) || sum === 0) return out;
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm === 0) return out;
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm;
  return out;
}

/** Dot product; the cosine of two unit vectors. 0 when the lengths differ or result is non-finite. */
export function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return Number.isFinite(sum) ? sum : 0;
}

/**
 * Hex of the little-endian Float32 bytes, bound through `unhex(?)`: the upstream `Database`
 * wrapper JSON-stringifies a typed array, so a BLOB cannot be bound directly.
 */
function toHex(v: Float32Array): string {
  const view = new DataView(new ArrayBuffer(v.length * 4));
  for (let i = 0; i < v.length; i++) view.setFloat32(i * 4, v[i]!, true);
  const bytes = new Uint8Array(view.buffer);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, "0");
  return hex;
}

/** A stored vector: a little-endian Float32 BLOB, or a legacy base64 TEXT row decoded and normalized. */
function decodeStored(value: unknown): Float32Array {
  if (typeof value === "string") return normalize(decodeVector(value));
  const view = ArrayBuffer.isView(value)
    ? new DataView(value.buffer, value.byteOffset, value.byteLength)
    : new DataView(value as ArrayBuffer);
  const out = new Float32Array(view.byteLength >> 2);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

/**
 * Rewrites every base64 TEXT vector as a unit-length Float32 BLOB in place, keeping model,
 * dims, content_hash and updated_at. Rows already stored as BLOBs are untouched. Returns the
 * number converted.
 */
export function convertLegacyVectors(db: Database): number {
  if (!hasTable(db)) return 0;
  const rows = db.all<{ memory_id: string; vector: string }>(
    `SELECT memory_id, vector FROM tal_semantic_vectors WHERE typeof(vector) = 'text'`,
  );
  for (const row of rows) {
    db.run(`UPDATE tal_semantic_vectors SET vector = unhex(?) WHERE memory_id = ?`, toHex(normalize(decodeVector(row.vector))), row.memory_id);
  }
  return rows.length;
}

/** True when a row of `model` and `dims` belongs in `cache`. */
const fits = (cache: VectorCache, model: string, dims: number) => cache.model === model && (cache.dims === 0 || cache.dims === dims);

/** Removes `ids` from the cache, keeping its count in step. */
function forget(db: Database, ids: Iterable<string>): void {
  const cache = caches.get(db);
  if (!cache) return;
  for (const id of ids) if (cache.vectors.delete(id)) cache.count--;
}

/**
 * Inserts or replaces vectors, normalized, in one transaction, then updates the cache.
 */
export function upsertVectors(db: Database, rows: VectorRow[]): void {
  const unit = rows.map((r) => ({ ...r, vector: normalize(r.vector) }));
  db.transaction(() => {
    for (const r of unit) {
      db.run(
        `INSERT INTO tal_semantic_vectors (memory_id, model, dims, content_hash, vector, updated_at) VALUES (?, ?, ?, ?, unhex(?), ?)
         ON CONFLICT(memory_id) DO UPDATE SET model = excluded.model, dims = excluded.dims,
           content_hash = excluded.content_hash, vector = excluded.vector, updated_at = excluded.updated_at`,
        r.memoryId, r.model, r.dims, r.contentHash, toHex(r.vector), r.updatedAt,
      );
    }
  });
  const cache = caches.get(db);
  if (!cache) return;
  for (const r of unit) {
    const had = cache.vectors.has(r.memoryId);
    if (fits(cache, r.model, r.dims)) {
      cache.vectors.set(r.memoryId, r.vector);
      if (!had) cache.count++;
    } else if (had) {
      cache.vectors.delete(r.memoryId);
      cache.count--;
    }
  }
}

/** Deletes one memory's vector. A no-op without the table, so forgetting works while the feature is off. */
export function deleteVector(db: Database, memoryId: string): void {
  if (!hasTable(db)) return;
  db.run(`DELETE FROM tal_semantic_vectors WHERE memory_id = ?`, memoryId);
  forget(db, [memoryId]);
}

/** Deletes every vector. A no-op without the table. */
export function deleteAllVectors(db: Database): void {
  if (!hasTable(db)) return;
  db.run(`DELETE FROM tal_semantic_vectors`);
  const cache = caches.get(db);
  if (!cache) return;
  cache.vectors.clear();
  cache.count = 0;
}

/** Deletes vectors whose memory no longer exists and returns how many went. */
export function purgeOrphanVectors(db: Database): number {
  if (!hasTable(db)) return 0;
  const gone = db
    .all<{ memory_id: string }>(`DELETE FROM tal_semantic_vectors WHERE memory_id NOT IN (SELECT id FROM tal_memories) RETURNING memory_id`)
    .map((r) => r.memory_id);
  forget(db, gone);
  return gone.length;
}

/** Forgets the cache, after the table is dropped or the model changes; the next read loads afresh. */
export function dropVectorCache(db: Database): void {
  caches.delete(db);
}

/** model, dims and content hash per memory id, for the pending check. */
export function vectorMeta(db: Database): Map<string, VectorMeta> {
  const meta = new Map<string, VectorMeta>();
  if (!hasTable(db)) return meta;
  for (const r of db.all<VectorMeta & { memory_id: string }>(`SELECT memory_id, model, dims, content_hash FROM tal_semantic_vectors`)) {
    meta.set(r.memory_id, { model: r.model, dims: r.dims, content_hash: r.content_hash });
  }
  return meta;
}

/** Stored vectors of `model`, of any size. */
export function countVectors(db: Database, model: string): number {
  if (!hasTable(db)) return 0;
  return db.one<{ n: number }>(`SELECT count(*) AS n FROM tal_semantic_vectors WHERE model = ?`, model)?.n ?? 0;
}

function countFor(db: Database, model: string, dims: number): number {
  return dims > 0
    ? (db.one<{ n: number }>(`SELECT count(*) AS n FROM tal_semantic_vectors WHERE model = ? AND dims = ?`, model, dims)?.n ?? 0)
    : (db.one<{ n: number }>(`SELECT count(*) AS n FROM tal_semantic_vectors WHERE model = ?`, model)?.n ?? 0);
}

/**
 * Unit vectors by memory id for `model` and `dims` (every row of the model when `dims` is 0).
 * Served from the cache unless it holds another model or size, or its row count no longer
 * matches SQLite. The returned map is the cache itself: read it, never change it.
 */
export function cachedVectors(db: Database, model: string, dims: number): ReadonlyMap<string, Float32Array> {
  if (!hasTable(db)) {
    caches.delete(db);
    return new Map();
  }
  const count = countFor(db, model, dims);
  const cache = caches.get(db);
  if (cache && cache.model === model && cache.dims === dims && cache.count === count) return cache.vectors;
  const rows =
    dims > 0
      ? db.all<{ memory_id: string; vector: unknown }>(`SELECT memory_id, vector FROM tal_semantic_vectors WHERE model = ? AND dims = ?`, model, dims)
      : db.all<{ memory_id: string; vector: unknown }>(`SELECT memory_id, vector FROM tal_semantic_vectors WHERE model = ?`, model);
  const vectors = new Map<string, Float32Array>();
  for (const row of rows) vectors.set(row.memory_id, decodeStored(row.vector));
  caches.set(db, { model, dims, count: vectors.size, vectors });
  return vectors;
}
