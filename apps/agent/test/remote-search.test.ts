import type { RemoteScope } from "@talorys/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bearer, inAgent, loggedIn, type Client } from "./helpers";
import { invalidateSemanticCache } from "../src/semantic";
import { type SemanticConfigPatch, deleteSemanticConfig, writeSemanticConfig } from "../src/semantic/config";
import { embeddingsToday } from "../src/semantic/embeddings";
import { itemUsageToday } from "../src/semantic/itemIndex";
import { dropSemanticData } from "../src/semantic/migrations";
import { UsageService } from "../src/services/usage";
import type { Services } from "../src/services/container";

type Hit = { type?: string; id: string; title?: string; content?: string; cosine: number | null; fused: number; match?: string };

function reset(s: Services) {
  dropSemanticData(s.db);
  deleteSemanticConfig(s.settings);
  invalidateSemanticCache(s);
  s.memories.clear();
  for (const table of ["tal_tasks", "tal_notes", "tal_automations"]) s.db.run(`DELETE FROM ${table}`);
}

async function mint(scope: RemoteScope): Promise<string> {
  return inAgent(async (agent) => {
    agent.services.remote.setEnabled(true);
    return (await agent.services.remote.create({ name: scope, scope })).token;
  });
}

/** Turns the feature on without the PUT route, so no background backfill starts. */
async function enableQuietly(patch: SemanticConfigPatch = {}) {
  await inAgent((agent) => {
    const s = agent.services;
    writeSemanticConfig(s.settings, { enabled: true, ...patch }, s.db);
    invalidateSemanticCache(s);
  });
}

/**
 * Seeds a memory, a done task and a note with Bearer writes while the feature is off, then turns
 * it on and embeds everything with a cookie reindex (the reindex route is not open to tokens).
 */
async function seed(b: Client, patch: SemanticConfigPatch = {}) {
  const memory = (await b.json("/api/memories", { method: "POST", body: { content: "Keeps a fern on the windowsill" } })).memory;
  const task = (await b.json("/api/tasks", { method: "POST", body: { title: "Water the plants" } })).task;
  expect((await b.json(`/api/tasks/${task.id}`, { method: "PATCH", body: { status: "done" } })).task.status).toBe("done");
  const note = (await b.json("/api/notes", { method: "POST", body: { title: "Greenhouse layout", content: "Tomatoes by the door" } })).note;
  await enableQuietly(patch);
  expect((await (await loggedIn()).call("/api/semantic/reindex", { method: "POST" })).status).toBe(200);
  return { memoryId: memory.id as string, taskId: task.id as string, noteId: note.id as string };
}

function usage() {
  return inAgent((agent) => {
    const day = UsageService.day();
    return { memory: embeddingsToday(agent.services.db, day), item: itemUsageToday(agent.services.db, day).requests };
  });
}

beforeEach(async () => {
  await inAgent((agent) => {
    reset(agent.services);
    agent.services.remote.revokeAll();
    agent.services.remote.setEnabled(false);
  });
});

afterEach(async () => {
  await inAgent((agent) => reset(agent.services));
});

describe("remote semantic search", () => {
  it("disabled 409: Bearer search is a conflict while semantic recall is off", async () => {
    for (const scope of ["read", "write"] as const) {
      const res = await bearer(await mint(scope)).call("/api/semantic/search?q=plants");
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("CONFLICT");
    }
    const cookie = await (await loggedIn()).call("/api/semantic/search?q=plants");
    expect(cookie.status).toBe(409);
  });

  it("search to fetch: memories only by default, typed hits fetched by id with the same token", async () => {
    const w = bearer(await mint("write"));
    const { memoryId, taskId, noteId } = await seed(w);
    const r = bearer(await mint("read"));

    for (const b of [w, r]) {
      const plain = (await b.json("/api/semantic/search?q=botany")) as { hits: Hit[] };
      expect(plain.hits.map((h) => h.id)).toEqual([memoryId]);
      expect(plain.hits[0]).not.toHaveProperty("type");
      expect((await b.json(`/api/memories/${memoryId}`)).memory.content).toBe("Keeps a fern on the windowsill");
    }

    const typed = (await r.json("/api/semantic/search?q=botany&types=task,note&limit=1")) as { hits: Hit[] };
    expect(typed.hits.filter((h) => h.type === "task")).toHaveLength(1);
    expect(typed.hits.filter((h) => h.type === "note").length).toBeLessThanOrEqual(1);
    expect(typed.hits.every((h) => h.type === "task" || h.type === "note")).toBe(true);
    const task = typed.hits.find((h) => h.type === "task")!;
    // Done tasks are not filtered out of search.
    expect(task).toMatchObject({ id: taskId, title: "Water the plants" });
    expect((await r.json(`/api/tasks/${task.id}`)).task.status).toBe("done");

    const notes = (await r.json("/api/semantic/search?q=greenhouse&types=note")) as { hits: Hit[] };
    const note = notes.hits.find((h) => h.id === noteId)!;
    expect(note.type).toBe("note");
    expect((await r.json(`/api/notes/${note.id}`)).note.title).toBe("Greenhouse layout");

    const clamped = await r.call("/api/semantic/search?q=plants&limit=999");
    expect(clamped.status).toBe(200);
    const bad = await r.call("/api/semantic/search?q=plants&types=project");
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR");
  });

  it("caps parity: Bearer and cookie searches draw on the same counters", async () => {
    const b = bearer(await mint("read"));
    await seed(bearer(await mint("write")));
    const cookie = await loggedIn();

    // A memory search pays the memory cap; an item-only search pays the item cap.
    for (const [types, paid] of [["memory,task", "memory"], ["task,note", "item"]] as const) {
      const path = `/api/semantic/search?q=botany&types=${types}`;
      const before = await usage();
      expect((await cookie.call(path)).status).toBe(200);
      const afterCookie = await usage();
      expect((await b.call(path)).status).toBe(200);
      const afterBearer = await usage();
      const cookieDelta = { memory: afterCookie.memory - before.memory, item: afterCookie.item - before.item };
      const bearerDelta = { memory: afterBearer.memory - afterCookie.memory, item: afterBearer.item - afterCookie.item };
      expect(cookieDelta[paid], types).toBeGreaterThan(0);
      expect(bearerDelta, types).toEqual(cookieDelta);
    }
  });

  it("caps parity: spent embedding caps degrade Bearer search to keyword hits", async () => {
    const w = bearer(await mint("write"));
    const { taskId } = await seed(w);
    // On main, a zero memory cap still turns item embedding off (independent caps land in a
    // follow-up). Drive both counters to zero so search must fall back to keyword.
    await enableQuietly({ maxEmbeddingsPerDay: 0, maxItemEmbeddingsPerDay: 0 });
    const keyword = (await w.json("/api/semantic/search?q=plants&types=memory,task")) as { hits: Hit[] };
    expect(keyword.hits.find((h) => h.id === taskId)).toMatchObject({ type: "task", cosine: null, match: "keyword" });
  });
});
