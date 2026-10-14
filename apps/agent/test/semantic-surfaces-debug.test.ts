import { describe, expect, it } from "vitest";
import { inAgent, loggedIn } from "./helpers";
import { invalidateSemanticCache } from "../src/semantic";
import { deleteSemanticConfig, writeSemanticConfig } from "../src/semantic/config";
import { dropSemanticData } from "../src/semantic/migrations";
import type { Services } from "../src/services/container";

type Hit = { type?: string; id: string; title?: string; cosine: number | null; fused: number; match?: string };

function reset(s: Services) {
  dropSemanticData(s.db);
  deleteSemanticConfig(s.settings);
  invalidateSemanticCache(s);
  s.memories.clear();
  for (const table of ["tal_tasks", "tal_notes", "tal_automations"]) s.db.run(`DELETE FROM ${table}`);
}

/**
 * Seeds a memory and the "Water the plants" task, turns the feature on without a background
 * backfill, and embeds both with a reindex.
 */
async function seed(): Promise<{ taskId: string; memoryId: string }> {
  const ids = await inAgent((agent) => {
    const s = agent.services;
    reset(s);
    const memory = s.memories.create({ content: "Keeps a fern on the windowsill" });
    const task = s.tasks.create({ title: "Water the plants" });
    writeSemanticConfig(s.settings, { enabled: true }, s.db);
    invalidateSemanticCache(s);
    return { taskId: task.id, memoryId: memory.id };
  });
  const c = await loggedIn();
  expect((await c.call("/api/semantic/reindex", { method: "POST" })).status).toBe(200);
  return ids;
}

async function cleanup() {
  await inAgent((agent) => reset(agent.services));
}

describe("semantic debug search with item types", () => {
  it("DBG-types: types=task returns the task found by meaning with its cosine", async () => {
    const { taskId } = await seed();
    const c = await loggedIn();
    const { hits } = (await c.json("/api/semantic/search?q=botany&types=task")) as { hits: Hit[] };
    const hit = hits.find((h) => h.id === taskId);
    expect(hit).toMatchObject({ type: "task", title: "Water the plants", cosine: expect.any(Number), fused: expect.any(Number) });
    expect(["meaning", "both"]).toContain(hit!.match);
    expect(hits.every((h) => h.type === "task")).toBe(true);

    // A keyword hit for the same task is tagged both; spaces and duplicates in types are accepted.
    const both = (await c.json("/api/semantic/search?q=plants&types=%20task%2Ctask%20")) as { hits: Hit[] };
    expect(both.hits.find((h) => h.id === taskId)).toMatchObject({ type: "task", match: "both" });

    // Mixed types: memory hits carry type "memory" and come first.
    const mixed = (await c.json("/api/semantic/search?q=botany&types=memory,task")) as { hits: Hit[] };
    expect(mixed.hits.map((h) => h.type)).toEqual(expect.arrayContaining(["memory", "task"]));
    expect(mixed.hits[0]!.type).toBe("memory");

    // A deleted task is skipped even before its vector is purged.
    await inAgent((agent) => agent.services.db.run(`DELETE FROM tal_tasks WHERE id = ?`, taskId));
    const gone = (await c.json("/api/semantic/search?q=botany&types=task")) as { hits: Hit[] };
    expect(gone.hits.find((h) => h.id === taskId)).toBeUndefined();
    await cleanup();
  });

  it("DBG-default: without types the response keeps the memory-only shape", async () => {
    const { memoryId, taskId } = await seed();
    const c = await loggedIn();
    const { hits } = (await c.json("/api/semantic/search?q=botany")) as { hits: Hit[] };
    expect(hits.find((h) => h.id === memoryId)).toBeDefined();
    expect(hits.find((h) => h.id === taskId)).toBeUndefined();
    for (const h of hits) expect(Object.keys(h).sort()).toEqual(["category", "content", "cosine", "fused", "id", "saved"]);
    await cleanup();
  });

  it("DBG-invalid: an unknown type is a 400 validation error", async () => {
    await seed();
    const c = await loggedIn();
    for (const types of ["bogus", "task,bogus", ","]) {
      const res = await c.call(`/api/semantic/search?q=botany&types=${encodeURIComponent(types)}`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR");
    }
    await cleanup();
  });
});
