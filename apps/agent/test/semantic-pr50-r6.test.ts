import { describe, expect, it, vi } from "vitest";
import { inAgent } from "./helpers";
import { invalidateSemanticCache } from "../src/semantic";
import { deleteSemanticConfig } from "../src/semantic/config";
import { type ItemVectorRow, purgeOrphanItemVectors, upsertItemVectors } from "../src/semantic/itemStore";
import { dropSemanticData, ensureSemanticSchema } from "../src/semantic/migrations";

const NOW = "2026-10-15T00:00:00.000Z";

const row = (itemType: ItemVectorRow["itemType"], itemId: string): ItemVectorRow => ({
  itemType,
  itemId,
  part: 0,
  model: "mock-bge-384",
  dims: 384,
  contentHash: `h-${itemId}`,
  sourceUpdatedAt: NOW,
  vector: new Float32Array(384).fill(0.5),
  updatedAt: NOW,
});

describe("orphan purge", () => {
  it("R6: purgeOrphanItemVectors runs no DELETE when nothing is orphaned", async () => {
    await inAgent((a) => {
      const s = a.services;
      dropSemanticData(s.db);
      deleteSemanticConfig(s.settings);
      invalidateSemanticCache(s);
      for (const table of ["tal_tasks", "tal_notes", "tal_automations"]) s.db.run(`DELETE FROM ${table}`);
      ensureSemanticSchema(s.db);
      const task = s.tasks.create({ title: "Renew passport" });
      const note = s.notes.create({ title: "Packing list", content: "Passport and charger." });
      upsertItemVectors(s.db, [row("task", task.id), row("note", note.id)]);

      const all = vi.spyOn(s.db, "all");
      const run = vi.spyOn(s.db, "run");
      try {
        expect(purgeOrphanItemVectors(s.db)).toBe(0);
        const sql = [...all.mock.calls, ...run.mock.calls].map((call) => String(call[0]));
        expect(sql.filter((q) => /\bDELETE\b/i.test(q))).toEqual([]);
      } finally {
        all.mockRestore();
        run.mockRestore();
      }
      expect(s.db.one<{ n: number }>(`SELECT count(*) AS n FROM tal_semantic_item_vectors`)?.n).toBe(2);
      dropSemanticData(s.db);
      for (const table of ["tal_tasks", "tal_notes"]) s.db.run(`DELETE FROM ${table}`);
    });
  });
});
