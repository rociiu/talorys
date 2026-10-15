import type { Database } from "../db/database";
import { normalize } from "./vectorStore";

/**
 * The only module whose SQL touches `tal_semantic_item_vectors` (the slim v3 `CREATE TABLE`
 * aside). Tasks, notes and automations are stored as one or more parts per item, each a
 * unit-length little-endian Float32 BLOB, so scoring is a plain dot product.
 *
 * Each Durable Object keeps one decoded cache per item type, of one model and size. Writes
 * through this module drop that type's cache; a read compares the cached row count with
 * SQLite and reloads on a mismatch, which catches out-of-band inserts and deletes.
 */

const TABLE = "tal_semantic_item_vectors";

/** Slim migration v3: the per-item vector table, its model index and the separate item usage counter. */
export const ITEM_TABLES_V3 = [
  `CREATE TABLE IF NOT EXISTS tal_semantic_item_vectors (item_type TEXT NOT NULL CHECK (item_type IN ('task','note','automation')),
    item_id TEXT NOT NULL, part INTEGER NOT NULL, model TEXT NOT NULL, dims INTEGER NOT NULL, content_hash TEXT NOT NULL,
    source_updated_at TEXT NOT NULL, vector BLOB NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (item_type, item_id, part))`,
  `CREATE INDEX IF NOT EXISTS tal_semantic_item_vectors_model ON tal_semantic_item_vectors (item_type, model, dims)`,
  `CREATE TABLE IF NOT EXISTS tal_semantic_item_usage (day TEXT PRIMARY KEY, requests INTEGER NOT NULL DEFAULT 0,
    tokens INTEGER NOT NULL DEFAULT 0)`,
];

export type ItemType = "task" | "note" | "automation";

export const ITEM_TYPES: readonly ItemType[] = ["task", "note", "automation"];

/** The upstream table each item type is indexed from, read only to find orphans. */
const SOURCE_TABLE: Record<ItemType, string> = { task: "tal_tasks", note: "tal_notes", automation: "tal_automations" };

export interface ItemVectorRow {
  itemType: ItemType;
  itemId: string;
  part: number;
  model: string;
  dims: number;
  contentHash: string;
  sourceUpdatedAt: string;
  vector: Float32Array;
  updatedAt: string;
}

export interface ItemPartMeta {
  part: number;
  model: string;
  dims: number;
  content_hash: string;
  source_updated_at: string;
}

export interface ItemPartVector {
  part: number;
  vector: Float32Array;
}

interface ItemCache {
  model: string;
  dims: number;
  count: number;
  items: Map<string, ItemPartVector[]>;
}

/** One cache per database, and so per Durable Object, with one entry per item type. */
const caches = new WeakMap<Database, Map<ItemType, ItemCache>>();

function hasTable(db: Database): boolean {
  return db.one(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, TABLE) !== null;
}

/** Forgets the cached rows of `types`; the next read of each loads afresh. */
function invalidate(db: Database, types: Iterable<ItemType>): void {
  const perType = caches.get(db);
  if (!perType) return;
  for (const type of types) perType.delete(type);
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

function fromBlob(value: unknown): Float32Array {
  const view = ArrayBuffer.isView(value)
    ? new DataView(value.buffer, value.byteOffset, value.byteLength)
    : new DataView(value as ArrayBuffer);
  const out = new Float32Array(view.byteLength >> 2);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

/** Inserts or replaces item parts, normalized, in one transaction. A no-op without the table. */
export function upsertItemVectors(db: Database, rows: ItemVectorRow[]): void {
  if (rows.length === 0 || !hasTable(db)) return;
  db.transaction(() => {
    for (const r of rows) {
      db.run(
        `INSERT INTO tal_semantic_item_vectors (item_type, item_id, part, model, dims, content_hash, source_updated_at, vector, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, unhex(?), ?)
         ON CONFLICT(item_type, item_id, part) DO UPDATE SET model = excluded.model, dims = excluded.dims,
           content_hash = excluded.content_hash, source_updated_at = excluded.source_updated_at,
           vector = excluded.vector, updated_at = excluded.updated_at`,
        r.itemType, r.itemId, r.part, r.model, r.dims, r.contentHash, r.sourceUpdatedAt, toHex(normalize(r.vector)), r.updatedAt,
      );
    }
  });
  invalidate(db, new Set(rows.map((r) => r.itemType)));
}

/** Deletes an item's parts numbered `fromPart` and up: all of them by default, or the tail after a note shrinks. */
export function deleteItemParts(db: Database, type: ItemType, id: string, fromPart = 0): void {
  if (!hasTable(db)) return;
  db.run(`DELETE FROM tal_semantic_item_vectors WHERE item_type = ? AND item_id = ? AND part >= ?`, type, id, fromPart);
  invalidate(db, [type]);
}

/** Deletes every item vector. A no-op without the table. */
export function deleteAllItemVectors(db: Database): void {
  if (!hasTable(db)) return;
  db.run(`DELETE FROM tal_semantic_item_vectors`);
  invalidate(db, ITEM_TYPES);
}

/** Records that an item's source changed without changing its embedded text; vectors stay as they are. */
export function touchItemSource(db: Database, type: ItemType, id: string, sourceUpdatedAt: string): void {
  if (!hasTable(db)) return;
  db.run(`UPDATE tal_semantic_item_vectors SET source_updated_at = ? WHERE item_type = ? AND item_id = ?`, sourceUpdatedAt, type, id);
}

/** Stored parts per item id of `type`, in part order, for the change check. */
export function itemVectorMeta(db: Database, type: ItemType): Map<string, ItemPartMeta[]> {
  const meta = new Map<string, ItemPartMeta[]>();
  if (!hasTable(db)) return meta;
  const rows = db.all<ItemPartMeta & { item_id: string }>(
    `SELECT item_id, part, model, dims, content_hash, source_updated_at FROM tal_semantic_item_vectors WHERE item_type = ? ORDER BY item_id, part`,
    type,
  );
  for (const r of rows) {
    const parts = meta.get(r.item_id) ?? [];
    parts.push({ part: r.part, model: r.model, dims: r.dims, content_hash: r.content_hash, source_updated_at: r.source_updated_at });
    meta.set(r.item_id, parts);
  }
  return meta;
}

/** Deletes parts whose task, note or automation no longer exists and returns how many rows went. */
export function purgeOrphanItemVectors(db: Database): number {
  if (!hasTable(db)) return 0;
  // A read first, so a pass with nothing orphaned writes nothing.
  const orphaned = ITEM_TYPES.some(
    (type) =>
      db.one(`SELECT 1 FROM tal_semantic_item_vectors WHERE item_type = ? AND item_id NOT IN (SELECT id FROM ${SOURCE_TABLE[type]}) LIMIT 1`, type) !==
      null,
  );
  if (!orphaned) return 0;
  let gone = 0;
  const touched: ItemType[] = [];
  db.transaction(() => {
    for (const type of ITEM_TYPES) {
      const deleted = db.all(
        `DELETE FROM tal_semantic_item_vectors WHERE item_type = ? AND item_id NOT IN (SELECT id FROM ${SOURCE_TABLE[type]}) RETURNING part`,
        type,
      ).length;
      if (deleted > 0) touched.push(type);
      gone += deleted;
    }
  });
  invalidate(db, touched);
  return gone;
}

/** Stored item parts of `model`, of any size and type. */
export function countItemVectors(db: Database, model: string): number {
  if (!hasTable(db)) return 0;
  return db.one<{ n: number }>(`SELECT count(*) AS n FROM tal_semantic_item_vectors WHERE model = ?`, model)?.n ?? 0;
}

/** Items (not parts) with at least one vector of `model` and `dims`, per type. */
export function countIndexedItems(db: Database, model: string, dims: number): Record<ItemType, number> {
  const counts: Record<ItemType, number> = { task: 0, note: 0, automation: 0 };
  if (!hasTable(db)) return counts;
  const rows = db.all<{ item_type: ItemType; n: number }>(
    `SELECT item_type, count(DISTINCT item_id) AS n FROM tal_semantic_item_vectors WHERE model = ? AND dims = ? GROUP BY item_type`,
    model,
    dims,
  );
  for (const r of rows) counts[r.item_type] = r.n;
  return counts;
}

function countFor(db: Database, type: ItemType, model: string, dims: number): number {
  return (
    db.one<{ n: number }>(`SELECT count(*) AS n FROM tal_semantic_item_vectors WHERE item_type = ? AND model = ? AND dims = ?`, type, model, dims)
      ?.n ?? 0
  );
}

/**
 * Unit vectors of `type` by item id, each with its part number, for `model` and `dims`. Served
 * from the cache unless it holds another model or size, or its row count no longer matches
 * SQLite. The returned map is the cache itself: read it, never change it.
 */
export function cachedItemVectors(db: Database, type: ItemType, model: string, dims: number): ReadonlyMap<string, ItemPartVector[]> {
  if (!hasTable(db)) {
    caches.delete(db);
    return new Map();
  }
  const count = countFor(db, type, model, dims);
  let perType = caches.get(db);
  const cache = perType?.get(type);
  if (cache && cache.model === model && cache.dims === dims && cache.count === count) return cache.items;
  const rows = db.all<{ item_id: string; part: number; vector: unknown }>(
    `SELECT item_id, part, vector FROM tal_semantic_item_vectors WHERE item_type = ? AND model = ? AND dims = ? ORDER BY item_id, part`,
    type,
    model,
    dims,
  );
  const items = new Map<string, ItemPartVector[]>();
  for (const row of rows) {
    const parts = items.get(row.item_id) ?? [];
    parts.push({ part: row.part, vector: fromBlob(row.vector) });
    items.set(row.item_id, parts);
  }
  if (!perType) {
    perType = new Map();
    caches.set(db, perType);
  }
  perType.set(type, { model, dims, count: rows.length, items });
  return items;
}

/** Forgets every item cache, after the tables are dropped or the model changes; the next read loads afresh. */
export function dropItemVectorCache(db: Database): void {
  caches.delete(db);
}
