import { describe, expect, it } from "vitest";
import { inAgent } from "./helpers";
import { FixtureEmbedder, fixtureConfig } from "./fixture-embedder";
import { invalidateSemanticCache } from "../src/semantic";
import { deleteSemanticConfig } from "../src/semantic/config";
import { dropSemanticData } from "../src/semantic/migrations";
import { type SemanticContext, queryVector } from "../src/semantic/recall";
import {
  automationAdditions,
  automationKeywordHits,
  noteAdditions,
  prepareSurfaceSearch,
} from "../src/semantic/itemSearch";
import {
  runItemPass,
} from "../src/semantic/itemIndex";
import {
  scanItemVectors,
  taskAdditions,
} from "../src/semantic/itemSearch";
import type { TalorysAgent } from "../src/agent/talorys-agent";

/** Clears items and semantic state and returns an enabled context searched with the fixture embedder. */
function setup(a: TalorysAgent) {
  const s = a.services;
  dropSemanticData(s.db);
  deleteSemanticConfig(s.settings);
  invalidateSemanticCache(s);
  for (const table of ["tal_tasks", "tal_notes", "tal_automations"]) s.db.run(`DELETE FROM ${table}`);
  const sem: SemanticContext = { db: s.db, services: s, embedder: new FixtureEmbedder(), config: fixtureConfig(), queryVectors: new Map() };
  return { s, sem };
}

const reminder = (a: TalorysAgent, name: string, enabled = true) =>
  a.services.automationsRepo.create({ name, kind: "reminder", message: name, schedule: { type: "daily", time: "08:00" }, enabled });

/** A paragraph of about 1,100 characters that only `phrase` gives a fixture key. */
const paragraph = (phrase: string) => `${phrase}. ${"lorem ipsum dolor sit amet ".repeat(40)}`.slice(0, 1100).trim();

const titles = (rows: { title: string }[]) => rows.map((r) => r.title);

describe("semantic surface search", () => {
  it("SS-floor: keeps hits above the floor and adds nothing below it", async () => {
    await inAgent(async (a) => {
      const { s, sem } = setup(a);
      const water = s.tasks.create({ title: "Water the plants" });
      s.tasks.create({ title: "Buy milk and eggs" });
      s.tasks.create({ title: "Call the bank" });

      const botany = await prepareSurfaceSearch(sem, "botany");
      const hits = scanItemVectors(sem, "task", botany!);
      expect(hits).toHaveLength(1);
      expect(hits[0]!.id).toBe(water.id);
      expect(hits[0]!.cosine).toBeCloseTo(0.62, 5);
      expect(titles(taskAdditions(sem, [botany!], { keywordIds: [] }))).toEqual(["Water the plants"]);

      const hello = await prepareSurfaceSearch(sem, "hello");
      expect(scanItemVectors(sem, "task", hello!)).toEqual([]);
      expect(taskAdditions(sem, [hello!], { keywordIds: [] })).toEqual([]);
    });
  });

  it("SS-window: drops a hit more than the relative window below the best", async () => {
    await inAgent(async (a) => {
      const { s, sem } = setup(a);
      s.notes.create({ title: "Budget line A", content: "" });
      s.notes.create({ title: "Budget draft", content: "" });

      const vector = await prepareSurfaceSearch(sem, "budget");
      expect(titles(noteAdditions(sem, [vector!], [], 200))).toEqual(["Budget line A"]);
    });
  });

  it("CH-once: returns a long note once, with its best chunk as the excerpt", async () => {
    await inAgent(async (a) => {
      const { s, sem } = setup(a);
      const content = ["budget line a", "budget line b", "budget line c", "closing remarks"].map(paragraph).join("\n\n");
      expect(content.length).toBeGreaterThan(4000);
      s.notes.create({ title: "Quarterly plan", content });
      s.notes.create({ title: "Budget memo", content: "Spending is on track." });
      s.notes.create({ title: "Budget recap", content: "Last quarter in numbers." });

      const vector = await prepareSurfaceSearch(sem, "budget");
      const added = noteAdditions(sem, [vector!], [], 200);
      expect(titles(added)).toEqual(["Quarterly plan", "Budget memo", "Budget recap"]);
      expect(added[0]!.excerpt).toBe(paragraph("budget line a").slice(0, 200));
      expect(added[1]!.excerpt).toBe("Spending is on track.");
    });
  });

  it("SS-done: leaves done tasks out except in the completed view", async () => {
    await inAgent(async (a) => {
      const { s, sem } = setup(a);
      const task = s.tasks.create({ title: "Book a physical" });
      s.tasks.complete(task.id);

      const vector = await prepareSurfaceSearch(sem, "doc appt soon");
      expect(scanItemVectors(sem, "task", vector!)[0]!.cosine).toBeCloseTo(0.66, 5);
      expect(taskAdditions(sem, [vector!], { keywordIds: [] })).toEqual([]);
      expect(titles(taskAdditions(sem, [vector!], { keywordIds: [], completedView: true }))).toEqual(["Book a physical"]);
    });
  });

  it("SS-fired: leaves completed automations out and keeps paused ones", async () => {
    await inAgent(async (a) => {
      const { s, sem } = setup(a);
      const fired = reminder(a, "Put the bins out");
      s.automationsRepo.update(fired.id, { status: "completed", enabled: false });
      const paused = reminder(a, "Put the bins out", false);
      expect(paused.status).toBe("paused");

      const vector = await prepareSurfaceSearch(sem, "garbage day");
      expect(scanItemVectors(sem, "automation", vector!).map((h) => h.cosine)).toEqual([
        expect.closeTo(0.63, 5),
        expect.closeTo(0.63, 5),
      ]);
      expect(automationAdditions(sem, [vector!], []).map((x) => x.id)).toEqual([paused.id]);
    });
  });

  it("SS-deleted: never returns a task deleted after indexing", async () => {
    await inAgent(async (a) => {
      const { s, sem } = setup(a);
      const task = s.tasks.create({ title: "Water the plants" });
      await runItemPass(sem);
      s.tasks.delete(task.id);
      expect(s.db.one(`SELECT item_id FROM tal_semantic_item_vectors WHERE item_id = ?`, task.id)).not.toBeNull();

      const vector = await queryVector(sem, "botany");
      expect(scanItemVectors(sem, "task", vector!)).toEqual([]);
      expect(taskAdditions(sem, [vector!], { keywordIds: [] })).toEqual([]);
    });
  });

  it("SS-keyword-auto: matches automation names and messages by keyword terms", async () => {
    await inAgent(async (a) => {
      const { s, sem } = setup(a);
      const rent = reminder(a, "Pay rent");
      const deposit = reminder(a, "Pay rent deposit");
      s.automationsRepo.update(deposit.id, { status: "completed", enabled: false });
      reminder(a, "Stretch");

      expect(automationKeywordHits(sem, "rent").map((x) => x.id)).toEqual([rent.id]);
      expect(automationKeywordHits(sem, "the")).toEqual([]);
    });
  });

  it("SS-null: every additions function returns nothing without query vectors", async () => {
    await inAgent(async (a) => {
      const { s, sem } = setup(a);
      s.tasks.create({ title: "Water the plants" });
      s.notes.create({ title: "Budget memo", content: "" });
      reminder(a, "Pay rent");
      await runItemPass(sem);

      expect(taskAdditions(sem, [], { keywordIds: [] })).toEqual([]);
      expect(taskAdditions(sem, [], { keywordIds: [], completedView: true })).toEqual([]);
      expect(noteAdditions(sem, [], [], 200)).toEqual([]);
      expect(automationAdditions(sem, [], [])).toEqual([]);
    });
  });
});
