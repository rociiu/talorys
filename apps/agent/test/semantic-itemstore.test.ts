import { describe, expect, it } from "vitest";
import { inAgent } from "./helpers";
import { invalidateSemanticCache } from "../src/semantic";
import { deleteSemanticConfig } from "../src/semantic/config";
import {
  type ItemVectorRow,
  cachedItemVectors,
  countIndexedItems,
  itemVectorMeta,
  purgeOrphanItemVectors,
  upsertItemVectors,
} from "../src/semantic/itemStore";
import { SEMANTIC_MIGRATIONS, dropSemanticData, ensureSemanticSchema, semanticSchema, tableExists } from "../src/semantic/migrations";
import { cachedVectors, upsertVectors } from "../src/semantic/vectorStore";
import type { Services } from "../src/services/container";

const MODEL = "mock-bge-384";
const DIMS = 384;
const NOW = "2026-10-14T00:00:00.000Z";

function reset(s: Services) {
  dropSemanticData(s.db);
  deleteSemanticConfig(s.settings);
  invalidateSemanticCache(s);
}

/** A raw (not unit-length) vector with a few non-zero coordinates. */
function raw(seed: number, dims = DIMS): Float32Array {
  const v = new Float32Array(dims);
  for (let i = 0; i < 6; i++) v[(seed * 7 + i * 13) % dims] = (i + 1) * (seed + 2) * 0.37;
  return v;
}

const norm = (v: Float32Array) => Math.hypot(...v);

function row(itemType: ItemVectorRow["itemType"], itemId: string, part: number, seed: number, over: Partial<ItemVectorRow> = {}): ItemVectorRow {
  return { itemType, itemId, part, model: MODEL, dims: DIMS, contentHash: `h${seed}`, sourceUpdatedAt: NOW, vector: raw(seed), updatedAt: NOW, ...over };
}

function blobs(s: Services, table: string, key: string): string {
  return JSON.stringify(s.db.all<Record<string, unknown>>(`SELECT ${key}, hex(vector) AS v FROM ${table} ORDER BY ${key}`));
}

describe("item vector store", () => {
  it("ITEM-migrate: an enabled v2 database upgrades to slim v3 and keeps its memory vectors", async () => {
    await inAgent((a) => {
      const s = a.services;
      reset(s);
      expect(ensureSemanticSchema(s.db, SEMANTIC_MIGRATIONS.slice(0, 2))).toBe(2);
      expect(tableExists(s.db, "tal_semantic_item_vectors")).toBe(false);
      upsertVectors(s.db, [1, 2, 3].map((i) => ({ memoryId: `m${i}`, model: MODEL, dims: DIMS, contentHash: `c${i}`, vector: raw(i), updatedAt: NOW })));
      const before = blobs(s, "tal_semantic_vectors", "memory_id");

      expect(ensureSemanticSchema(s.db)).toBe(3);
      expect(semanticSchema(s.db)).toEqual({ track: "slim", version: 3 });
      expect(tableExists(s.db, "tal_semantic_item_vectors")).toBe(true);
      expect(tableExists(s.db, "tal_semantic_item_usage")).toBe(true);
      expect(s.db.one(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'tal_semantic_item_vectors_model'`)).not.toBeNull();
      expect(blobs(s, "tal_semantic_vectors", "memory_id")).toBe(before);
      expect(cachedVectors(s.db, MODEL, DIMS).size).toBe(3);
      reset(s);
    });
  });

  it("ITEM-roundtrip: stored parts come back unit-length, grouped by item, for one model and size", async () => {
    await inAgent((a) => {
      const s = a.services;
      reset(s);
      ensureSemanticSchema(s.db);
      upsertItemVectors(s.db, [
        row("note", "n1", 0, 1),
        row("note", "n1", 1, 2),
        row("note", "n2", 0, 3),
        row("note", "n3", 0, 4, { model: "other-model" }),
        row("note", "n4", 0, 5, { dims: 128, vector: raw(5, 128) }),
        row("task", "t1", 0, 6),
        row("note", "n5", 0, 7, { vector: new Float32Array(DIMS) }),
      ]);
      const notes = cachedItemVectors(s.db, "note", MODEL, DIMS);
      expect([...notes.keys()].sort()).toEqual(["n1", "n2", "n5"]);
      expect(notes.get("n1")!.map((p) => p.part)).toEqual([0, 1]);
      for (const parts of [notes.get("n1")!, notes.get("n2")!]) for (const p of parts) expect(norm(p.vector)).toBeCloseTo(1, 5);
      // A zero vector stays zero rather than turning into NaN.
      expect([...notes.get("n5")![0]!.vector].every((x) => x === 0)).toBe(true);
      expect([...cachedItemVectors(s.db, "note", "other-model", DIMS).keys()]).toEqual(["n3"]);
      expect([...cachedItemVectors(s.db, "task", MODEL, DIMS).keys()]).toEqual(["t1"]);
      expect(countIndexedItems(s.db, MODEL, DIMS)).toEqual({ task: 1, note: 3, automation: 0 });

      // Replacing a part is seen by the next read.
      upsertItemVectors(s.db, [row("note", "n2", 0, 9, { contentHash: "new" })]);
      expect(itemVectorMeta(s.db, "note").get("n2")).toEqual([{ part: 0, model: MODEL, dims: DIMS, content_hash: "new", source_updated_at: NOW }]);
      const n2 = cachedItemVectors(s.db, "note", MODEL, DIMS).get("n2")![0]!.vector;
      const expected = raw(9);
      const scale = norm(expected);
      for (let i = 0; i < DIMS; i++) expect(n2[i]!).toBeCloseTo(expected[i]! / scale, 5);
      reset(s);
    });
  });

  it("ITEM-purge: removes parts of a deleted task, note and automation and keeps the rest", async () => {
    await inAgent((a) => {
      const s = a.services;
      reset(s);
      ensureSemanticSchema(s.db);
      const keepTask = s.tasks.create({ title: "Wax the kayak" });
      const goneTask = s.tasks.create({ title: "Return library books" });
      const keepNote = s.notes.create({ title: "Packing list" });
      const goneNote = s.notes.create({ title: "Old draft" });
      const schedule = { type: "interval" as const, minutes: 60 };
      const keepAuto = s.automationsRepo.create({ name: "Stretch", kind: "reminder", message: "Stretch", schedule, enabled: false });
      const goneAuto = s.automationsRepo.create({ name: "Water", kind: "reminder", message: "Water plants", schedule, enabled: false });
      upsertItemVectors(s.db, [
        row("task", keepTask.id, 0, 1),
        row("task", goneTask.id, 0, 2),
        row("note", keepNote.id, 0, 3),
        row("note", goneNote.id, 0, 4),
        row("note", goneNote.id, 1, 5),
        row("automation", keepAuto.id, 0, 6),
        row("automation", goneAuto.id, 0, 7),
      ]);
      expect(cachedItemVectors(s.db, "note", MODEL, DIMS).size).toBe(2);
      s.tasks.delete(goneTask.id);
      s.notes.delete(goneNote.id);
      s.automationsRepo.delete(goneAuto.id);

      expect(purgeOrphanItemVectors(s.db)).toBe(4);
      expect([...cachedItemVectors(s.db, "task", MODEL, DIMS).keys()]).toEqual([keepTask.id]);
      expect([...cachedItemVectors(s.db, "note", MODEL, DIMS).keys()]).toEqual([keepNote.id]);
      expect([...cachedItemVectors(s.db, "automation", MODEL, DIMS).keys()]).toEqual([keepAuto.id]);
      expect(purgeOrphanItemVectors(s.db)).toBe(0);

      s.tasks.delete(keepTask.id);
      s.notes.delete(keepNote.id);
      s.automationsRepo.delete(keepAuto.id);
      reset(s);
    });
  });

  it("ITEM-drop: dropping semantic data removes both item tables and empties the cache", async () => {
    await inAgent((a) => {
      const s = a.services;
      reset(s);
      ensureSemanticSchema(s.db);
      upsertItemVectors(s.db, [row("task", "t1", 0, 1)]);
      expect(cachedItemVectors(s.db, "task", MODEL, DIMS).size).toBe(1);

      dropSemanticData(s.db);
      expect(tableExists(s.db, "tal_semantic_item_vectors")).toBe(false);
      expect(tableExists(s.db, "tal_semantic_item_usage")).toBe(false);
      expect(cachedItemVectors(s.db, "task", MODEL, DIMS).size).toBe(0);
      // Re-enabling starts empty.
      ensureSemanticSchema(s.db);
      expect(cachedItemVectors(s.db, "task", MODEL, DIMS).size).toBe(0);
      reset(s);
    });
  });

  it("ITEM-tripwire: a row inserted by direct SQL is picked up by the next read", async () => {
    await inAgent((a) => {
      const s = a.services;
      reset(s);
      ensureSemanticSchema(s.db);
      upsertItemVectors(s.db, [row("automation", "a1", 0, 1)]);
      expect([...cachedItemVectors(s.db, "automation", MODEL, DIMS).keys()]).toEqual(["a1"]);

      const unit = new Float32Array(DIMS);
      unit[3] = 1;
      const hex = [...new Uint8Array(unit.buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
      s.db.run(
        `INSERT INTO tal_semantic_item_vectors (item_type, item_id, part, model, dims, content_hash, source_updated_at, vector, updated_at)
         VALUES ('automation', 'a2', 0, ?, ?, 'h', ?, unhex(?), ?)`,
        MODEL, DIMS, NOW, hex, NOW,
      );
      const after = cachedItemVectors(s.db, "automation", MODEL, DIMS);
      expect([...after.keys()].sort()).toEqual(["a1", "a2"]);
      expect(after.get("a2")![0]!.vector[3]).toBe(1);
      reset(s);
    });
  });
});
