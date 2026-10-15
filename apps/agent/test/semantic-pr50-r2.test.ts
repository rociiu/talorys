import { describe, expect, it } from "vitest";
import { inAgent, loggedIn } from "./helpers";
import { invalidateSemanticCache } from "../src/semantic";
import { deleteSemanticConfig, writeSemanticConfig } from "../src/semantic/config";
import { dropSemanticData } from "../src/semantic/migrations";
import type { Services } from "../src/services/container";

function reset(s: Services) {
  dropSemanticData(s.db);
  deleteSemanticConfig(s.settings);
  invalidateSemanticCache(s);
  for (const table of ["tal_tasks", "tal_notes", "tal_automations"]) s.db.run(`DELETE FROM ${table}`);
}

const snapshot = (s: Services) =>
  s.db.all(
    `SELECT item_type, item_id, part, content_hash, source_updated_at, updated_at FROM tal_semantic_item_vectors ORDER BY item_type, item_id, part`,
  );

describe("semantic status is read-only", () => {
  it("R2: polling the status leaves every item vector row as it was", async () => {
    const ids = await inAgent((a) => {
      const s = a.services;
      reset(s);
      writeSemanticConfig(s.settings, { enabled: true, maxEmbeddingsPerDay: 10_000 }, s.db);
      invalidateSemanticCache(s);
      const task = s.tasks.create({ title: "Renew passport" });
      const body = Array.from({ length: 120 }, (_, i) => `Line ${i} of the long packing list for the trip.`).join("\n");
      expect(body.length).toBeGreaterThan(4000);
      const note = s.notes.create({ title: "Packing list", content: body });
      return { task: task.id, note: note.id };
    });
    const c = await loggedIn();
    expect((await c.call("/api/semantic/reindex", { method: "POST" })).status).toBe(200);

    const before = await inAgent((a) => {
      const s = a.services;
      expect(s.db.one<{ n: number }>(`SELECT count(*) AS n FROM tal_semantic_item_vectors WHERE item_id = ?`, ids.note)!.n).toBeGreaterThan(2);
      s.db.run(`UPDATE tal_tasks SET updated_at = ? WHERE id = ?`, "2099-01-01T00:00:00.000Z", ids.task);
      s.db.run(`UPDATE tal_notes SET content = ?, updated_at = ? WHERE id = ?`, "Passport only.", "2099-01-01T00:00:00.000Z", ids.note);
      return snapshot(s);
    });

    const first = (await c.json("/api/semantic/status")) as { items: { pending: number } };
    const second = (await c.json("/api/semantic/status")) as { items: { pending: number } };
    await inAgent((a) => expect(snapshot(a.services)).toEqual(before));
    expect(second.items.pending).toBe(first.items.pending);
    await inAgent((a) => reset(a.services));
  });
});
