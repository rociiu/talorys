import { describe, expect, it, vi } from "vitest";
import { inAgent } from "./helpers";
import { invalidateSemanticCache } from "../src/semantic";
import { DEFAULT_SEMANTIC_CONFIG, type SemanticConfig, deleteSemanticConfig } from "../src/semantic/config";
import { MeteredEmbedder, MockEmbedder, embeddingsToday } from "../src/semantic/embeddings";
import type { IndexerContext } from "../src/semantic/indexer";
import type { ItemType } from "../src/semantic/itemStore";
import { dropSemanticData } from "../src/semantic/migrations";
import { type SemanticContext, hybridSearch } from "../src/semantic/recall";
import { itemUsageToday, runItemPass, startBackgroundItemBackfill } from "../src/semantic/itemIndex";
import { taskText } from "../src/semantic/itemText";
import { UsageService } from "../src/services/usage";
import type { TalorysAgent } from "../src/agent/talorys-agent";

/** Clears items and semantic state and returns an enabled context with a spied mock embedder. */
function context(a: TalorysAgent, patch: Partial<SemanticConfig> = {}) {
  const s = a.services;
  dropSemanticData(s.db);
  deleteSemanticConfig(s.settings);
  invalidateSemanticCache(s);
  for (const table of ["tal_tasks", "tal_notes", "tal_automations"]) s.db.run(`DELETE FROM ${table}`);
  const embedder = new MockEmbedder();
  const embed = vi.spyOn(embedder, "embed");
  const ctx: IndexerContext = { db: s.db, embedder, config: { ...DEFAULT_SEMANTIC_CONFIG, enabled: true, maxEmbeddingsPerDay: 10_000, ...patch } };
  /** Every text sent to the embedder so far, across calls. */
  const texts = () => embed.mock.calls.flatMap(([batch]) => batch);
  return { ctx, embed, texts, s };
}

const parts = (a: TalorysAgent, type: ItemType, id: string) =>
  a.services.db
    .all<{ part: number }>(`SELECT part FROM tal_semantic_item_vectors WHERE item_type = ? AND item_id = ? ORDER BY part`, type, id)
    .map((r) => r.part);

const reminder = (a: TalorysAgent, name: string) =>
  a.services.automationsRepo.create({ name, kind: "reminder", message: name, schedule: { type: "daily", time: "08:00" }, enabled: true });

/** A scheduler-style run: only run fields and updated_at change. */
const recordRun = (a: TalorysAgent, id: string, n: number) =>
  a.services.automationsRepo.update(id, { last_run: new Date().toISOString(), last_result: `run ${n}`, run_count: n });

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** A paragraph of about 870 characters: two never share a chunk. */
const paragraph = (i: number, word: string) => `Paragraph ${i} about ${word}. ${`${word}${i} `.repeat(120)}`.slice(0, 1100).trim();

describe("semantic item pass", () => {
  it("IDX-new: embeds every new part in one call and nothing on a second pass", async () => {
    await inAgent(async (a) => {
      const { ctx, embed, s } = context(a);
      for (const title of ["Water the plants", "Call the bank", "Renew passport"]) s.tasks.create({ title });
      reminder(a, "Take Lipitor");
      reminder(a, "Stretch");
      const note = s.notes.create({ title: "Packing list", content: "Passport, charger and sunscreen." });

      expect(await runItemPass(ctx)).toEqual({ embedded: 7, pending: 0, purged: 0 });
      expect(embed).toHaveBeenCalledTimes(1);
      expect(embed.mock.calls[0]![0]).toHaveLength(7);
      expect(parts(a, "note", note.id)).toEqual([0, 1]);

      expect(await runItemPass(ctx)).toEqual({ embedded: 0, pending: 0, purged: 0 });
      expect(embed).toHaveBeenCalledTimes(1);
    });
  });

  it("EDIT-status: status changes and scheduler runs embed nothing", async () => {
    await inAgent(async (a) => {
      const { ctx, embed, s } = context(a);
      const task = s.tasks.create({ title: "Water the plants" });
      const auto = reminder(a, "Take Lipitor");
      await runItemPass(ctx);
      embed.mockClear();
      await tick();

      s.tasks.complete(task.id);
      recordRun(a, auto.id, 1);
      expect(await runItemPass(ctx)).toEqual({ embedded: 0, pending: 0, purged: 0 });
      expect(embed).not.toHaveBeenCalled();
    });
  });

  it("EDIT-missed: a title edited straight in SQL without updated_at is re-embedded by a full pass", async () => {
    await inAgent(async (a) => {
      const { ctx, embed, texts, s } = context(a);
      const task = s.tasks.create({ title: "Water the plants" });
      s.tasks.create({ title: "Call the bank" });
      await runItemPass(ctx);
      embed.mockClear();

      s.db.run(`UPDATE tal_tasks SET title = ? WHERE id = ?`, "Water the orchids", task.id);
      // An unchanged updated_at keeps the row out of the change check until a full pass.
      expect(await runItemPass(ctx)).toEqual({ embedded: 0, pending: 0, purged: 0 });
      expect(await runItemPass(ctx, { full: true })).toEqual({ embedded: 1, pending: 0, purged: 0 });
      expect(texts()).toEqual([taskText({ title: "Water the orchids", description: "" })]);
    });
  });

  it("S-runs: repeated automation runs never call the embedder", async () => {
    await inAgent(async (a) => {
      const { ctx, embed } = context(a);
      const auto = reminder(a, "Take Lipitor");
      await runItemPass(ctx);
      const calls = embed.mock.calls.length;
      for (let n = 1; n <= 3; n++) {
        await tick();
        recordRun(a, auto.id, n);
        await runItemPass(ctx);
      }
      expect(embed.mock.calls.length).toBe(calls);
    });
  });

  it("DEL-orphan: deleting items through their repositories removes their vectors", async () => {
    await inAgent(async (a) => {
      const { ctx, s } = context(a);
      const task = s.tasks.create({ title: "Water the plants" });
      const kept = s.tasks.create({ title: "Call the bank" });
      const note = s.notes.create({ title: "Packing list", content: "Passport and charger." });
      const auto = reminder(a, "Take Lipitor");
      await runItemPass(ctx);

      s.tasks.delete(task.id);
      s.notes.delete(note.id);
      s.automationsRepo.delete(auto.id);
      expect(await runItemPass(ctx)).toEqual({ embedded: 0, pending: 0, purged: 4 });
      expect(parts(a, "task", task.id)).toEqual([]);
      expect(parts(a, "note", note.id)).toEqual([]);
      expect(parts(a, "automation", auto.id)).toEqual([]);
      expect(parts(a, "task", kept.id)).toEqual([0]);
    });
  });

  it("CH-edit: editing one paragraph re-embeds one chunk and shrinking deletes the tail", async () => {
    await inAgent(async (a) => {
      const { ctx, embed, texts, s } = context(a);
      const words = ["apple", "birch", "cedar", "delta", "ember", "fjord", "grove", "harbor", "island"];
      const paragraphs = words.map((w, i) => paragraph(i, w));
      const note = s.notes.create({ title: "Field notes", content: paragraphs.join("\n\n") });
      expect(await runItemPass(ctx)).toEqual({ embedded: 10, pending: 0, purged: 0 });
      expect(parts(a, "note", note.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      embed.mockClear();
      await tick();

      const edited = [...paragraphs];
      edited[4] = paragraph(4, "zephyr");
      s.notes.update(note.id, { content: edited.join("\n\n") });
      expect(await runItemPass(ctx)).toEqual({ embedded: 1, pending: 0, purged: 0 });
      expect(texts()).toEqual([`Field notes: ${edited[4]}`]);
      // The unchanged parts took the new updated_at, so the next pass does not re-chunk the note.
      expect(await runItemPass(ctx)).toEqual({ embedded: 0, pending: 0, purged: 0 });
      embed.mockClear();
      await tick();

      // Trailing blank space keeps the note over NOTE_SPLIT_CHARS, so it stays chunked: three chunks.
      s.notes.update(note.id, { content: `${edited.slice(0, 3).join("\n\n")}\n\n${" ".repeat(2000)}` });
      expect(await runItemPass(ctx)).toEqual({ embedded: 0, pending: 0, purged: 0 });
      expect(embed).not.toHaveBeenCalled();
      expect(parts(a, "note", note.id)).toEqual([0, 1, 2, 3]);
    });
  });

  it("CAP-separate: a backfill stops at the item cap and leaves the memory cap untouched", { timeout: 120_000 }, async () => {
    await inAgent(async (a) => {
      const { ctx, s } = context(a, { maxEmbeddingsPerDay: 10 });
      const ts = new Date().toISOString();
      s.db.transaction(() => {
        for (let i = 0; i < 3000; i++) {
          s.db.run(`INSERT INTO tal_notes (id, title, content, created_at, updated_at) VALUES (?, ?, '', ?, ?)`, `note-${i}`, `Note ${i}`, ts, ts);
        }
      });
      await startBackgroundItemBackfill(ctx);
      const day = UsageService.day();
      expect(itemUsageToday(s.db, day).requests).toBe(50);
      expect(s.db.one<{ n: number }>(`SELECT COUNT(*) AS n FROM tal_semantic_item_vectors`)!.n).toBe(2500);
      expect(embeddingsToday(s.db, day)).toBe(0);

      s.memories.create({ content: "My car is a VW bug", category: "fact" });
      const search: SemanticContext = { ...ctx, services: s, embedder: new MeteredEmbedder(s.db, ctx.embedder!) };
      await hybridSearch(search, "my car", { limit: 5 });
      expect(embeddingsToday(s.db, day)).toBe(1);
      s.db.run(`DELETE FROM tal_notes`);
    });
  });

  it("CAP-tokens-pass: a pass embeds only the texts that fit the token cap", async () => {
    await inAgent(async (a) => {
      const { ctx, texts, s } = context(a);
      // Each task text is about 253 estimated tokens, so three fit 1,000 and a fourth does not.
      for (let i = 0; i < 5; i++) s.tasks.create({ title: `T${i}`, description: "x".repeat(1000) });
      const caps = { requests: 50, tokens: 1000 };
      expect(await runItemPass(ctx, { caps })).toEqual({ embedded: 3, pending: 2, purged: 0, capped: true });
      expect(await runItemPass(ctx, { caps })).toEqual({ embedded: 0, pending: 2, purged: 0, capped: true });
      expect(texts()).toHaveLength(3);
      expect(itemUsageToday(s.db, UsageService.day()).tokens).toBeLessThanOrEqual(1000);
    });
  });

  it("IDX-coalesce: concurrent passes embed each pending part exactly once", async () => {
    await inAgent(async (a) => {
      const { ctx, texts, s } = context(a);
      for (const title of ["Water the plants", "Call the bank", "Renew passport"]) s.tasks.create({ title });
      reminder(a, "Take Lipitor");
      s.notes.create({ title: "Packing list", content: "Passport and charger." });
      s.notes.create({ title: "Empty note", content: "" });

      const reports = await Promise.all([runItemPass(ctx), runItemPass(ctx), runItemPass(ctx)]);
      expect(reports.reduce((n, r) => n + r.embedded, 0)).toBe(7);
      expect(texts()).toHaveLength(7);
      expect(new Set(texts()).size).toBe(7);
      expect(reports.every((r) => r.pending === 0 && !r.error)).toBe(true);
    });
  });
});
