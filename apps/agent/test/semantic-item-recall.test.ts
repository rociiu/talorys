import { describe, expect, it } from "vitest";
import { inAgent } from "./helpers";
import { FixtureEmbedder, fixtureConfig } from "./fixture-embedder";
import { invalidateSemanticCache } from "../src/semantic";
import { deleteSemanticConfig } from "../src/semantic/config";
import { runIndexer } from "../src/semantic/indexer";
import { MAX_RECALLED_ITEMS, automationLine, selectSemanticItems } from "../src/semantic/itemRecall";
import { dropSemanticData, ensureSemanticSchema } from "../src/semantic/migrations";
import { type SemanticContext, queryVector, selectSemanticMemories } from "../src/semantic/recall";
import { itemUsageToday, runItemPass } from "../src/semantic/itemIndex";
import { formatLocal } from "../src/services/time";
import { UsageService } from "../src/services/usage";
import type { TalorysAgent } from "../src/agent/talorys-agent";

/** Clears items and semantic state and returns an enabled context searched with the fixture embedder. */
function setup(a: TalorysAgent) {
  const s = a.services;
  dropSemanticData(s.db);
  deleteSemanticConfig(s.settings);
  invalidateSemanticCache(s);
  s.memories.clear();
  for (const table of ["tal_tasks", "tal_notes", "tal_automations"]) s.db.run(`DELETE FROM ${table}`);
  ensureSemanticSchema(s.db);
  const embedder = new FixtureEmbedder();
  const sem: SemanticContext = { db: s.db, services: s, embedder, config: fixtureConfig(), queryVectors: new Map() };
  return { s, sem, embedder };
}

const reminder = (a: TalorysAgent, name: string) =>
  a.services.automationsRepo.create({ name, kind: "reminder", message: name, schedule: { type: "daily", time: "08:00" }, enabled: true });

describe("per-turn item recall", () => {
  it("HUB-d: reuses the turn's message vector without another embed or item reservation", async () => {
    await inAgent(async (a) => {
      const { s, sem, embedder } = setup(a);
      s.memories.create({ content: "Prefers morning meetings", category: "preference" });
      const water = s.tasks.create({ title: "Water the plants" });
      await runIndexer(sem, { maxEmbed: 50 });
      await runItemPass(sem, { maxEmbed: 500 });
      embedder.calls.length = 0;
      const day = UsageService.day();

      const message = "any tasks about botany?";
      await selectSemanticMemories(sem, message);
      expect(embedder.calls).toEqual([[message]]);
      const before = itemUsageToday(s.db, day);
      const lines = selectSemanticItems(sem, message);

      expect(lines).toEqual([`- [task] Water the plants (id ${water.id})`]);
      expect(embedder.calls).toEqual([[message]]);
      expect(itemUsageToday(s.db, day)).toEqual(before);
      expect(selectSemanticItems(sem, "a message never embedded")).toEqual([]);
      expect(embedder.calls).toEqual([[message]]);
    });
  });

  it("HUB-e: leaves out done tasks, completed automations and items deleted since indexing", async () => {
    await inAgent(async (a) => {
      const { s, sem } = setup(a);
      const water = s.tasks.create({ title: "Water the plants" });
      const fern = s.tasks.create({ title: "Repot the fern" });
      const bins = reminder(a, "Put the bins out");
      const lake = s.notes.create({ title: "Lake house", content: "Router in the attic" });
      await runItemPass(sem, { maxEmbed: 500 });
      s.tasks.complete(water.id);
      s.automationsRepo.update(bins.id, { status: "completed", enabled: false });
      s.notes.delete(lake.id);
      expect(s.db.one(`SELECT item_id FROM tal_semantic_item_vectors WHERE item_id = ?`, lake.id)).not.toBeNull();

      for (const q of ["botany", "garbage day", "get online at the cottage"]) await queryVector(sem, q);
      expect(selectSemanticItems(sem, "botany")).toEqual([`- [task] Repot the fern (id ${fern.id})`]);
      expect(selectSemanticItems(sem, "garbage day")).toEqual([]);
      expect(selectSemanticItems(sem, "get online at the cottage")).toEqual([]);
    });
  });

  it("line format: task, note and reminder lines carry type and id, at most three, best first", async () => {
    await inAgent(async (a) => {
      const { s, sem } = setup(a);
      const due = "2026-10-20T16:00:00.000Z";
      const water = s.tasks.create({ title: "Water the plants", due_at: due });
      const fern = s.tasks.create({ title: "Repot the fern" });
      const memo = s.notes.create({ title: "Budget memo", content: `Q3   numbers\n\nlook ${"fine ".repeat(60)}` });
      const lineA = s.notes.create({ title: "Budget line A", content: "" });
      const lineB = s.notes.create({ title: "Budget line B", content: "Rent and food" });
      s.notes.create({ title: "Budget recap", content: "Done" });
      s.notes.create({ title: "Budget line C", content: "Misc" });
      const bins = reminder(a, "Put the bins out");
      const digest = s.automationsRepo.create({
        name: "Morning digest",
        kind: "task_digest",
        message: "Morning digest",
        schedule: { type: "daily", time: "07:00" },
        enabled: true,
      });
      await runItemPass(sem, { maxEmbed: 500 });
      for (const q of ["botany", "budget", "garbage day"]) await queryVector(sem, q);
      const tz = s.settings.get().timezone;

      expect(selectSemanticItems(sem, "botany")).toEqual([
        `- [task] Water the plants (due ${formatLocal(due, tz)}; id ${water.id})`,
        `- [task] Repot the fern (id ${fern.id})`,
      ]);

      const budget = selectSemanticItems(sem, "budget");
      expect(budget).toHaveLength(MAX_RECALLED_ITEMS);
      const excerpt = `Q3 numbers look ${"fine ".repeat(60)}`.slice(0, 160).trim();
      expect(budget).toEqual([
        `- [note] Budget line A (id ${lineA.id})`,
        `- [note] Budget line B: Rent and food (id ${lineB.id})`,
        `- [note] Budget memo: ${excerpt} (id ${memo.id})`,
      ]);

      expect(selectSemanticItems(sem, "garbage day")).toEqual([`- [reminder] ${bins.schedule_description}: Put the bins out (id ${bins.id})`]);

      // Any kind but a reminder is labelled as an automation.
      expect(automationLine(digest)).toBe(`- [automation] ${digest.schedule_description}: Morning digest (id ${digest.id})`);
    });
  });
});
