import { BACKUP_FORMAT } from "@talorys/shared";
import { describe, expect, it } from "vitest";
import { inAgent, loggedIn } from "./helpers";
import { invalidateSemanticCache } from "../src/semantic";
import { type SemanticConfigPatch, deleteSemanticConfig, writeSemanticConfig } from "../src/semantic/config";
import { dropSemanticData, semanticTableNames } from "../src/semantic/migrations";
import { UsageService } from "../src/services/usage";
import type { Services } from "../src/services/container";

type Client = Awaited<ReturnType<typeof loggedIn>>;
type Items = { vectors: number; pending: number; by_type: { task: number; note: number; automation: number }; items_today: number; items_cap: number; indexing: boolean };

/** Clears semantic state and every task, note and automation. */
function reset(s: Services) {
  dropSemanticData(s.db);
  deleteSemanticConfig(s.settings);
  invalidateSemanticCache(s);
  for (const table of ["tal_tasks", "tal_notes", "tal_automations"]) s.db.run(`DELETE FROM ${table}`);
}

/** Turns the feature on without the PUT route, so no background backfill starts. */
async function enableQuietly(patch: SemanticConfigPatch = {}) {
  await inAgent((agent) => {
    const s = agent.services;
    writeSemanticConfig(s.settings, { enabled: true, ...patch }, s.db);
    invalidateSemanticCache(s);
  });
}

const items = async (c: Client): Promise<Items> => (await c.json("/api/semantic/status")).items as Items;

/** Polls the status until `done` holds for the items block. */
async function itemsWhen(c: Client, done: (i: Items) => boolean): Promise<Items> {
  for (let i = 0; i < 200; i++) {
    const next = await items(c);
    if (done(next)) return next;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`background item pass did not finish: ${JSON.stringify(await items(c))}`);
}

const rowsFor = (s: Services, id: string) =>
  s.db.one<{ n: number }>(`SELECT count(*) AS n FROM tal_semantic_item_vectors WHERE item_id = ?`, id)?.n ?? 0;

/** Spends today's item cap, so no item pass can embed. */
const spendItemCap = (s: Services) =>
  s.db.run(`INSERT INTO tal_semantic_item_usage (day, requests, tokens) VALUES (?, 50, 0) ON CONFLICT(day) DO UPDATE SET requests = 50`, UsageService.day());

describe("semantic surface routes", () => {
  it("RT-status: reports an all-zero items block and creates no table when never enabled", async () => {
    await inAgent((a) => {
      reset(a.services);
      a.services.tasks.create({ title: "Renew passport" });
    });
    const c = await loggedIn();
    expect(await items(c)).toEqual({ vectors: 0, pending: 0, by_type: { task: 0, note: 0, automation: 0 }, items_today: 0, items_cap: 50, indexing: false });
    await inAgent((a) => {
      expect(semanticTableNames(a.services.db)).toEqual([]);
      expect(a.services.db.one(`SELECT name FROM sqlite_master WHERE name = 'tal_semantic_item_vectors'`)).toBeNull();
    });

    // Once enabled, pending counts parts (a note is a title row plus a body part) without embedding.
    await inAgent((a) => a.services.notes.create({ title: "Packing list", content: "Passport and charger." }));
    await enableQuietly();
    expect(await items(c)).toEqual({ vectors: 0, pending: 3, by_type: { task: 0, note: 0, automation: 0 }, items_today: 0, items_cap: 50, indexing: false });
    await inAgent((a) => reset(a.services));
  });

  it("RT-enable: turning the feature on backfills tasks after memories", async () => {
    await inAgent((a) => {
      reset(a.services);
      a.services.tasks.create({ title: "Water the plants" });
      a.services.tasks.create({ title: "Call the bank" });
    });
    const c = await loggedIn();
    expect((await c.call("/api/semantic/config", { method: "PUT", body: { enabled: true } })).status).toBe(200);
    const done = await itemsWhen(c, (i) => i.pending === 0 && i.by_type.task === 2);
    expect(done).toMatchObject({ vectors: 2, pending: 0, by_type: { task: 2, note: 0, automation: 0 }, items_today: 1 });
    await inAgent((a) => reset(a.services));
  });

  it("RT-reindex: drops item vectors and re-embeds every part", async () => {
    await inAgent((a) => {
      reset(a.services);
      a.services.tasks.create({ title: "Renew passport" });
      a.services.notes.create({ title: "Packing list", content: "Passport and charger." });
    });
    await enableQuietly({ maxEmbeddingsPerDay: 10_000 });
    const c = await loggedIn();
    const first = await c.json("/api/semantic/reindex", { method: "POST" });
    expect(first.surfaces).toEqual({ embedded: 3, pending: 0 });
    expect(first).toMatchObject({ pending: 0, capped: false });
    // A second reindex embeds every part again rather than finding them current.
    expect((await c.json("/api/semantic/reindex", { method: "POST" })).surfaces).toEqual({ embedded: 3, pending: 0 });
    expect(await items(c)).toMatchObject({ vectors: 3, pending: 0, by_type: { task: 1, note: 1, automation: 0 }, items_today: 2 });

    // While capped the reindex stops and reports what is left.
    await inAgent((a) => spendItemCap(a.services));
    expect((await c.json("/api/semantic/reindex", { method: "POST" })).surfaces).toEqual({ embedded: 0, pending: 3 });
    await inAgent((a) => reset(a.services));
  });

  it("DEL-restore: an import drops vectors of items the restored data no longer has", async () => {
    const { gone, kept } = await inAgent((a) => {
      reset(a.services);
      return { gone: a.services.tasks.create({ title: "Old errand" }).id, kept: a.services.tasks.create({ title: "Keep me" }).id };
    });
    await enableQuietly({ maxEmbeddingsPerDay: 10_000 });
    const c = await loggedIn();
    expect((await c.json("/api/semantic/reindex", { method: "POST" })).surfaces).toEqual({ embedded: 2, pending: 0 });
    // The restored data lacks the task, but its vector rows are still there.
    await inAgent((a) => {
      a.services.db.run(`DELETE FROM tal_tasks WHERE id = ?`, gone);
      expect(rowsFor(a.services, gone)).toBe(1);
    });
    const backup = { format: BACKUP_FORMAT, version: 1, exported_at: new Date().toISOString(), data: {} };
    expect((await c.call("/api/import", { method: "POST", body: backup })).status).toBe(200);
    await itemsWhen(c, (i) => i.vectors === 1);
    await inAgent((a) => {
      expect(rowsFor(a.services, gone)).toBe(0);
      expect(rowsFor(a.services, kept)).toBe(1);
    });

    // A failed import starts nothing.
    await inAgent((a) => a.services.db.run(`DELETE FROM tal_tasks WHERE id = ?`, kept));
    expect((await c.call("/api/import", { method: "POST", body: { format: "nope" } })).status).toBe(400);
    await new Promise((r) => setTimeout(r, 50));
    await inAgent((a) => expect(rowsFor(a.services, kept)).toBe(1));
    await inAgent((a) => reset(a.services));
  });

  it("CAP-reset: deleting semantic data removes the item usage counter", async () => {
    await inAgent((a) => {
      reset(a.services);
      a.services.tasks.create({ title: "Renew passport" });
    });
    await enableQuietly({ maxEmbeddingsPerDay: 10_000 });
    const c = await loggedIn();
    await c.json("/api/semantic/reindex", { method: "POST" });
    expect(await items(c)).toMatchObject({ vectors: 1, items_today: 1 });

    expect((await c.call("/api/semantic/data", { method: "DELETE", body: { confirm: "DELETE" } })).status).toBe(200);
    await inAgent((a) => expect(a.services.db.one(`SELECT name FROM sqlite_master WHERE name = 'tal_semantic_item_usage'`)).toBeNull());
    expect(await items(c)).toEqual({ vectors: 0, pending: 0, by_type: { task: 0, note: 0, automation: 0 }, items_today: 0, items_cap: 50, indexing: false });
    await inAgent((a) => reset(a.services));
  });

  it("RT-model: a model change leaves every item part pending until the backfill runs", async () => {
    await inAgent((a) => {
      reset(a.services);
      a.services.tasks.create({ title: "Renew passport" });
      a.services.tasks.create({ title: "Call the bank" });
      a.services.notes.create({ title: "Packing list", content: "Passport and charger." });
    });
    await enableQuietly({ maxEmbeddingsPerDay: 10_000 });
    const c = await loggedIn();
    expect((await c.json("/api/semantic/reindex", { method: "POST" })).surfaces).toEqual({ embedded: 4, pending: 0 });

    // The mock embedder has one model name, so the rows are relabelled as the previous model's.
    // With the item cap spent the backfill cannot embed, so status shows the pending parts.
    await inAgent((a) => {
      a.services.db.run(`UPDATE tal_semantic_item_vectors SET model = '@cf/baai/bge-m3'`);
      spendItemCap(a.services);
    });
    expect((await c.call("/api/semantic/config", { method: "PUT", body: { model: "@cf/baai/bge-small-en-v1.5" } })).status).toBe(200);
    expect(await itemsWhen(c, (i) => i.pending === 4)).toMatchObject({ pending: 4, vectors: 0, by_type: { task: 0, note: 0, automation: 0 } });

    // Once the cap allows it, a model change backfills every part under the new model.
    await inAgent((a) => a.services.db.run(`DELETE FROM tal_semantic_item_usage`));
    await c.call("/api/semantic/config", { method: "PUT", body: { model: "@cf/baai/bge-m3" } });
    expect(await itemsWhen(c, (i) => i.pending === 0)).toMatchObject({ vectors: 4, by_type: { task: 2, note: 1, automation: 0 } });
    await inAgent((a) => reset(a.services));
  });
});
