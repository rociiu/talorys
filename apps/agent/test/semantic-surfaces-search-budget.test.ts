import { describe, expect, it } from "vitest";
import { inAgent } from "./helpers";
import { invalidateSemanticCache } from "../src/semantic";
import { DEFAULT_SEMANTIC_CONFIG, deleteSemanticConfig } from "../src/semantic/config";
import { MockEmbedder } from "../src/semantic/embeddings";
import { dropSemanticData } from "../src/semantic/migrations";
import type { SemanticContext } from "../src/semantic/recall";
import { itemPassRunning, pendingItems, runItemPass } from "../src/semantic/itemIndex";
import { SEARCH_REEMBED_MAX, prepareSurfaceSearch } from "../src/semantic/itemSearch";
import type { TalorysAgent } from "../src/agent/talorys-agent";

const QUERY = "where did I put the passport";

/** Mock embedder that records the item texts it embeds and can hold item embeds until released. */
class GatedEmbedder extends MockEmbedder {
  readonly itemTexts: string[] = [];
  gate: Promise<void> | null = null;

  override async embed(texts: string[], onUsage?: Parameters<MockEmbedder["embed"]>[1]): Promise<Float32Array[]> {
    const items = texts.filter((t) => t !== QUERY);
    if (items.length > 0) {
      if (this.gate) await this.gate;
      this.itemTexts.push(...items);
    }
    return super.embed(texts, onUsage);
  }
}

/** Clears items and semantic state, seeds `n` unindexed tasks and returns a context capturing waitUntil. */
function pendingTasks(a: TalorysAgent, n: number) {
  const s = a.services;
  dropSemanticData(s.db);
  deleteSemanticConfig(s.settings);
  invalidateSemanticCache(s);
  for (const table of ["tal_tasks", "tal_notes", "tal_automations"]) s.db.run(`DELETE FROM ${table}`);
  for (let i = 0; i < n; i++) s.tasks.create({ title: `Task number ${i}` });
  const embedder = new GatedEmbedder();
  const background: Promise<unknown>[] = [];
  const sem: SemanticContext = {
    db: s.db,
    services: s,
    embedder,
    config: { ...DEFAULT_SEMANTIC_CONFIG, enabled: true, maxEmbeddingsPerDay: 10_000 },
    queryVectors: new Map(),
    waitUntil: (work) => background.push(work),
  };
  const pending = async () => (await pendingItems(s.db, embedder.model, embedder.dims)).pending.length;
  return { sem, embedder, background, pending };
}

describe("item pass before a search", () => {
  it("FU1-b: embeds at most 8 parts before returning and leaves the rest to the background backfill", async () => {
    await inAgent(async (a) => {
      const { sem, embedder, background, pending } = pendingTasks(a, 200);
      expect(await pending()).toBe(200);

      const vector = await prepareSurfaceSearch(sem, QUERY);
      expect(vector).not.toBeNull();
      expect(embedder.itemTexts.length).toBeLessThanOrEqual(SEARCH_REEMBED_MAX);
      expect(background).toHaveLength(1);

      await Promise.all(background);
      expect(embedder.itemTexts).toHaveLength(200);
      expect(await pending()).toBe(0);
    });
  });

  it("does not wait for an item pass that is already running", async () => {
    await inAgent(async (a) => {
      const { sem, embedder, background, pending } = pendingTasks(a, 20);
      let release!: () => void;
      embedder.gate = new Promise((resolve) => (release = resolve));
      const running = runItemPass(sem);
      expect(itemPassRunning(sem.db)).toBe(true);

      const vector = await prepareSurfaceSearch(sem, QUERY);
      expect(vector).not.toBeNull();
      expect(embedder.itemTexts).toHaveLength(0);
      expect(background).toHaveLength(1);

      embedder.gate = null;
      release();
      await running;
      await Promise.all(background);
      expect(await pending()).toBe(0);
      expect(itemPassRunning(sem.db)).toBe(false);
    });
  });

  it("queues no background work when nothing is pending", async () => {
    await inAgent(async (a) => {
      const { sem, background } = pendingTasks(a, 3);
      await prepareSurfaceSearch(sem, QUERY);
      expect(background).toHaveLength(0);
    });
  });
});
