import { describe, expect, it, vi } from "vitest";
import { inAgent } from "./helpers";
import { invalidateSemanticCache } from "../src/semantic";
import { DEFAULT_SEMANTIC_CONFIG, deleteSemanticConfig } from "../src/semantic/config";
import { MockEmbedder } from "../src/semantic/embeddings";
import type { IndexerContext } from "../src/semantic/indexer";
import { dropSemanticData } from "../src/semantic/migrations";
import { changedItemRows, pendingItems, runItemPass } from "../src/semantic/itemIndex";
import { itemSourceStamp } from "../src/semantic/itemText";
import type { TalorysAgent } from "../src/agent/talorys-agent";

/** Clears items and semantic state, seeds `n` tasks and indexes them all. */
async function indexedTasks(a: TalorysAgent, n: number) {
  const s = a.services;
  dropSemanticData(s.db);
  deleteSemanticConfig(s.settings);
  invalidateSemanticCache(s);
  for (const table of ["tal_tasks", "tal_notes", "tal_automations"]) s.db.run(`DELETE FROM ${table}`);
  const ids = Array.from({ length: n }, (_, i) => s.tasks.create({ title: `Task number ${i}` }).id);
  const embedder = new MockEmbedder();
  const embed = vi.spyOn(embedder, "embed");
  const ctx: IndexerContext = { db: s.db, embedder, config: { ...DEFAULT_SEMANTIC_CONFIG, enabled: true, maxEmbeddingsPerDay: 10_000 } };
  expect(await runItemPass(ctx, { maxEmbed: n })).toMatchObject({ embedded: n, pending: 0 });
  embed.mockClear();
  const check = (full = false) => pendingItems(s.db, embedder.model, embedder.dims, { full });
  return { s, ids, ctx, embed, check };
}

/** Moves a task's updated_at forward without changing its text. */
const bump = (a: TalorysAgent, id: string, at: string) => a.services.db.run(`UPDATE tal_tasks SET updated_at = ? WHERE id = ?`, at, id);

const stamp = (a: TalorysAgent, id: string) =>
  a.services.db.one<{ s: string }>(`SELECT source_updated_at AS s FROM tal_semantic_item_vectors WHERE item_type = 'task' AND item_id = ?`, id)?.s;

describe("item change check", () => {
  it("FU1-a: hashes no unchanged task and only the touched ones", async () => {
    await inAgent(async (a) => {
      const { ids, check } = await indexedTasks(a, 500);
      expect(await check()).toEqual({ pending: [], touched: 0, hashed: 0 });

      for (const id of ids.slice(0, 3)) bump(a, id, "2099-01-01T00:00:00.000Z");
      expect(await check()).toEqual({ pending: [], touched: 3, hashed: 3 });
      expect(await check()).toEqual({ pending: [], touched: 0, hashed: 0 });
    });
  });

  it("FU1-c: an edit that keeps the text is hashed once, not re-embedded, and then skipped", async () => {
    await inAgent(async (a) => {
      const { ids, ctx, embed, check } = await indexedTasks(a, 5);
      const id = ids[2]!;
      bump(a, id, "2099-02-02T00:00:00.000Z");

      const first = await check();
      expect(first).toEqual({ pending: [], touched: 1, hashed: 1 });
      expect(stamp(a, id)).toBe(itemSourceStamp("task", "2099-02-02T00:00:00.000Z"));
      expect(await runItemPass(ctx)).toEqual({ embedded: 0, pending: 0, purged: 0 });
      expect(embed).not.toHaveBeenCalled();
      expect(await check()).toEqual({ pending: [], touched: 0, hashed: 0 });
    });
  });

  it("re-checks every task when full is set, and a changed text is pending", async () => {
    await inAgent(async (a) => {
      const { s, ids, embed, check } = await indexedTasks(a, 4);
      expect(await check(true)).toEqual({ pending: [], touched: 0, hashed: 4 });
      s.db.run(`UPDATE tal_tasks SET title = 'Renamed', updated_at = '2099-03-03T00:00:00.000Z' WHERE id = ?`, ids[0]!);
      const { pending, hashed } = await check();
      expect(hashed).toBe(1);
      expect(pending.map((p) => [p.id, p.sourceUpdatedAt])).toEqual([[ids[0], itemSourceStamp("task", "2099-03-03T00:00:00.000Z")]]);
      expect(embed).not.toHaveBeenCalled();
    });
  });
});

describe("item change check in SQL", () => {
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

  it("fetches only tasks never indexed or whose updated_at differs from the stored stamp", async () => {
    await inAgent(async (a) => {
      const { s, ids: taskIds, ctx, embed, check } = await indexedTasks(a, 20);
      expect(changedItemRows(s.db, "task", ctx.embedder!.model, ctx.embedder!.dims)).toEqual([]);

      // A later stamp, an earlier one with the same precision, and a new task.
      bump(a, taskIds[3]!, "2099-01-01T00:00:00.000Z");
      bump(a, taskIds[7]!, "2000-01-01T00:00:00.000Z");
      const fresh = s.tasks.create({ title: "Brand new task" }).id;
      const changed = changedItemRows<{ id: string }>(s.db, "task", ctx.embedder!.model, ctx.embedder!.dims);
      expect(ids(changed)).toEqual([taskIds[3]!, taskIds[7]!, fresh].sort());

      // The check itself never reads every task row.
      const all = vi.spyOn(s.db, "all");
      const { pending, hashed } = await check();
      expect(hashed).toBe(3);
      expect(pending.map((p) => p.id)).toEqual([fresh]);
      const reads = all.mock.calls.map(([sql]) => String(sql)).filter((sql) => /FROM tal_tasks/.test(sql));
      expect(reads.length).toBeGreaterThan(0);
      for (const sql of reads) expect(sql).toMatch(/WHERE/);
      all.mockRestore();
      expect(embed).not.toHaveBeenCalled();

      // Another model or size makes every row a candidate; full returns all rows.
      expect(changedItemRows(s.db, "task", "other-model", ctx.embedder!.dims)).toHaveLength(21);
      expect(changedItemRows(s.db, "task", ctx.embedder!.model, ctx.embedder!.dims + 1)).toHaveLength(21);
      expect(changedItemRows(s.db, "task", ctx.embedder!.model, ctx.embedder!.dims, true)).toHaveLength(21);
    });
  });

  it("fetches a note until every part carries its updated_at, and an automation by its stamp", async () => {
    await inAgent(async (a) => {
      const { s, ctx } = await indexedTasks(a, 1);
      const { model, dims } = ctx.embedder!;
      const note = s.notes.create({ title: "Lease", content: "Pets allowed with a deposit." }).id;
      const automation = s.automationsRepo.create({ name: "Bins", kind: "reminder", message: "Take the bins out", schedule: { type: "daily", time: "20:00" }, enabled: true }).id;
      expect(ids(changedItemRows(s.db, "note", model, dims))).toEqual([note]);
      expect(ids(changedItemRows(s.db, "automation", model, dims))).toEqual([automation]);

      await runItemPass(ctx, { maxEmbed: 50 });
      expect(changedItemRows(s.db, "note", model, dims)).toEqual([]);
      expect(changedItemRows(s.db, "automation", model, dims)).toEqual([]);

      s.db.run(`UPDATE tal_notes SET updated_at = '2099-04-04T00:00:00.000Z' WHERE id = ?`, note);
      s.db.run(`UPDATE tal_automations SET updated_at = '2099-04-04T00:00:00.000Z' WHERE id = ?`, automation);
      expect(ids(changedItemRows(s.db, "note", model, dims))).toEqual([note]);
      expect(ids(changedItemRows(s.db, "automation", model, dims))).toEqual([automation]);
    });
  });
});
