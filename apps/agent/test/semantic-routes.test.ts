import { describe, expect, it } from "vitest";
import { client, inAgent, loggedIn, proposeAction } from "./helpers";
import { MockEmbedder, embeddingsToday } from "../src/semantic/embeddings";
import { runIndexer } from "../src/semantic/indexer";
import { UsageService } from "../src/services/usage";
import { invalidateSemanticCache } from "../src/semantic";
import {
  DEFAULT_SEMANTIC_CONFIG,
  SEMANTIC_CONFIG_KEY,
  type SemanticConfigPatch,
  deleteSemanticConfig,
  readSemanticConfig,
  writeSemanticConfig,
} from "../src/semantic/config";
import { dropSemanticData, semanticTableNames } from "../src/semantic/migrations";
import type { Services } from "../src/services/container";
import type { SemanticContext } from "../src/semantic/recall";
import { semanticTools } from "../src/semantic/tools";
import { ToolExecutor } from "../src/tools";
import type { TalorysAgent } from "../src/agent/talorys-agent";

function reset(s: Services) {
  dropSemanticData(s.db);
  deleteSemanticConfig(s.settings);
  invalidateSemanticCache(s);
}

/** Turns the feature on without the PUT route, so no background backfill starts. */
async function enableQuietly(patch: SemanticConfigPatch = {}) {
  await inAgent((agent) => {
    const s = agent.services;
    writeSemanticConfig(s.settings, { enabled: true, ...patch }, s.db);
    invalidateSemanticCache(s);
  });
}

type Status = { vectors: number; pending: number; embeddings_today: number };

/** Polls the status until three reads in a row agree, i.e. background indexing has stopped. */
async function settledStatus(c: Awaited<ReturnType<typeof loggedIn>>): Promise<Status> {
  let last = (await c.json("/api/semantic/status")) as Status;
  let same = 0;
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 25));
    const next = (await c.json("/api/semantic/status")) as Status;
    same = next.vectors === last.vectors && next.embeddings_today === last.embeddings_today ? same + 1 : 0;
    if (same === 2) return next;
    last = next;
  }
  throw new Error("background indexing did not settle");
}

/** Gives every memory a vector of another model, so all of them are pending for the mock embedder. */
function staleVectors(s: Services) {
  s.db.run(
    `INSERT INTO tal_semantic_vectors (memory_id, model, dims, content_hash, vector, updated_at)
     SELECT id, ?, 384, 'stale', '', ? FROM tal_memories`,
    "@cf/baai/bge-small-en-v1.5", new Date().toISOString(),
  );
}

describe("semantic routes", () => {
  it("require a session", async () => {
    const anon = client();
    const calls: [string, string, unknown?][] = [
      ["GET", "/api/semantic/config"],
      ["PUT", "/api/semantic/config", { enabled: true }],
      ["GET", "/api/semantic/status"],
      ["DELETE", "/api/semantic/data", { confirm: "DELETE" }],
      ["GET", "/api/semantic/search?q=car"],
      ["POST", "/api/semantic/reindex"],
    ];
    for (const [method, path, body] of calls) {
      const res = await anon.call(path, { method, ...(body !== undefined ? { body } : {}) });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
    await inAgent((agent) => expect(agent.services.settings.getJson(SEMANTIC_CONFIG_KEY)).toBeNull());
  });

  it("status never embeds and creates no table when never enabled", async () => {
    await inAgent((agent) => {
      reset(agent.services);
      agent.services.memories.create({ content: "Likes hiking", category: "preference" });
    });
    const c = await loggedIn();
    expect(await c.json("/api/semantic/status")).toEqual({
      enabled: false,
      ever_enabled: false,
      schema: null,
      embedder: "mock",
      vectors: 0,
      pending: 0,
      embeddings_today: 0,
      cap: DEFAULT_SEMANTIC_CONFIG.maxEmbeddingsPerDay,
    });
    await inAgent((agent) => {
      expect(semanticTableNames(agent.services.db)).toEqual([]);
      expect(agent.services.settings.getJson(SEMANTIC_CONFIG_KEY)).toBeNull();
    });
  });

  it("status reports the schema and pending memories once enabled", async () => {
    await inAgent((agent) => reset(agent.services));
    const c = await loggedIn();
    await enableQuietly({ maxEmbeddingsPerDay: 42 });
    const count = await inAgent((agent) => agent.services.memories.count());
    expect(count).toBeGreaterThan(0);
    expect(await c.json("/api/semantic/status")).toEqual({
      enabled: true,
      ever_enabled: true,
      schema: { track: "slim", version: 2 },
      embedder: "mock",
      vectors: 0,
      pending: count,
      embeddings_today: 0,
      cap: 42,
    });

    await c.call("/api/semantic/config", { method: "PUT", body: { enabled: false } });
    const off = await c.json("/api/semantic/status");
    expect(off).toMatchObject({ enabled: false, ever_enabled: true, schema: { track: "slim", version: 2 }, pending: 0 });
    await inAgent((agent) => reset(agent.services));
  });

  it("status counts only vectors of the current model", async () => {
    await inAgent((agent) => reset(agent.services));
    const c = await loggedIn();
    await c.call("/api/semantic/config", { method: "PUT", body: { enabled: true } });
    const count = await inAgent(async (agent) => {
      const s = agent.services;
      const config = readSemanticConfig(s.settings, s.db)!;
      await runIndexer({ db: s.db, embedder: new MockEmbedder(), config: { ...config, maxEmbeddingsPerDay: 10_000 } }, { maxEmbed: 10_000 });
      const extra = s.memories.create({ content: "Stored under an older model", category: "fact" });
      s.db.run(
        `INSERT INTO tal_semantic_vectors (memory_id, model, dims, content_hash, vector, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
        extra.id, "@cf/baai/bge-small-en-v1.5", 384, "stale", "", new Date().toISOString(),
      );
      return s.memories.count();
    });
    expect(await c.json("/api/semantic/status")).toMatchObject({ embedder: "mock", vectors: count - 1, pending: 1 });
    await inAgent((agent) => reset(agent.services));
  });

  it("Delete semantic data requires confirm DELETE", async () => {
    await inAgent((agent) => reset(agent.services));
    const c = await loggedIn();
    await c.call("/api/semantic/config", { method: "PUT", body: { enabled: true } });
    for (const body of [undefined, {}, { confirm: "delete" }, { confirm: true }]) {
      const res = await c.call("/api/semantic/data", { method: "DELETE", ...(body !== undefined ? { body } : {}) });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR");
    }
    await inAgent((agent) => expect(semanticTableNames(agent.services.db).length).toBeGreaterThan(0));

    const res = await c.call("/api/semantic/data", { method: "DELETE", body: { confirm: "DELETE" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    await inAgent((agent) => {
      expect(semanticTableNames(agent.services.db)).toEqual([]);
      expect(agent.services.settings.getJson(SEMANTIC_CONFIG_KEY)).toBeNull();
    });
  });

  it("memory routes still work through the pass-through middleware", async () => {
    const c = await loggedIn();
    const created = await c.call("/api/memories", { method: "POST", body: { content: "Owns a red kayak", category: "fact" } });
    expect(created.status).toBe(201);
    const { memory } = (await created.json()) as { memory: { id: string } };
    const patched = await c.call(`/api/memories/${memory.id}`, { method: "PATCH", body: { content: "Owns a blue kayak" } });
    expect(patched.status).toBe(200);
    expect((await c.call(`/api/memories/${memory.id}`, { method: "DELETE" })).status).toBe(200);
  });

  it("search and reindex return 409 while the feature is off", async () => {
    await inAgent((agent) => reset(agent.services));
    const c = await loggedIn();
    for (const [method, path] of [
      ["GET", "/api/semantic/search?q=car"],
      ["POST", "/api/semantic/reindex"],
    ] as const) {
      const res = await c.call(path, { method });
      expect(res.status, `${method} ${path} never enabled`).toBe(409);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("CONFLICT");
    }
    await c.call("/api/semantic/config", { method: "PUT", body: { enabled: false } });
    expect((await c.call("/api/semantic/search?q=car")).status).toBe(409);
    expect((await c.call("/api/semantic/reindex", { method: "POST" })).status).toBe(409);
    await inAgent((agent) => reset(agent.services));
  });

  it("reindex re-embeds every memory and search returns hybrid hits", async () => {
    await inAgent((agent) => {
      reset(agent.services);
      agent.services.memories.clear();
      for (let i = 0; i < 60; i++) agent.services.memories.create({ content: `Kayak trip number ${i}` });
    });
    const c = await loggedIn();
    const { memory } = await c.json("/api/memories", { method: "POST", body: { content: "Drives a Tesla Model 3", category: "fact" } });
    await enableQuietly();

    const reindex = await c.call("/api/semantic/reindex", { method: "POST" });
    expect(reindex.status).toBe(200);
    expect(await reindex.json()).toEqual({ embedded: 61, pending: 0, capped: false });
    expect(await c.json("/api/semantic/status")).toMatchObject({ vectors: 61, pending: 0, embeddings_today: 2 });

    // A second reindex drops the vectors and embeds them all again.
    expect(await c.json("/api/semantic/reindex", { method: "POST" })).toEqual({ embedded: 61, pending: 0, capped: false });

    const { hits } = await c.json("/api/semantic/search?q=my%20vehicle");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: memory.id, content: "Drives a Tesla Model 3", category: "fact", cosine: expect.any(Number) });
    expect(Object.keys(hits[0]).sort()).toEqual(["category", "content", "cosine", "fused", "id", "saved"]);
    expect(hits[0].saved).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);

    expect((await c.json("/api/semantic/search?q=kayak")).hits).toHaveLength(10);
    expect((await c.json("/api/semantic/search?q=kayak&limit=3")).hits).toHaveLength(3);
    expect((await c.json("/api/semantic/search?q=kayak&limit=500")).hits).toHaveLength(50);
    expect((await c.call("/api/semantic/search")).status).toBe(400);
    await inAgent((agent) => {
      reset(agent.services);
      agent.services.memories.clear();
    });
  });

  it("reindex during an in-flight pass waits for a pass that starts after the delete", async () => {
    await inAgent((agent) => {
      reset(agent.services);
      agent.services.memories.clear();
      for (let i = 0; i < 5; i++) agent.services.memories.create({ content: `Kayak trip number ${i}` });
    });
    const c = await loggedIn();
    await c.call("/api/semantic/config", { method: "PUT", body: { enabled: true, maxEmbeddingsPerDay: 10_000 } });
    expect(await c.json("/api/semantic/reindex", { method: "POST" })).toEqual({ embedded: 5, pending: 0, capped: false });

    let entered!: () => void;
    let release!: () => void;
    const inEmbed = new Promise<void>((r) => (entered = r));
    const gate = new Promise<void>((r) => (release = r));
    // A pass that has listed only the newest memory and is still embedding it.
    await inAgent((agent) => {
      const s = agent.services;
      s.memories.create({ content: "Drives a Tesla Model 3", category: "fact" });
      const mock = new MockEmbedder();
      const slow = {
        model: mock.model,
        dims: mock.dims,
        embed: async (texts: string[]) => {
          entered();
          await gate;
          return mock.embed(texts);
        },
      };
      void runIndexer({ db: s.db, config: readSemanticConfig(s.settings)!, embedder: slow });
    });
    await inEmbed;

    const reindex = c.call("/api/semantic/reindex", { method: "POST" });
    await new Promise((r) => setTimeout(r, 50));
    release();
    const res = await reindex;
    expect(res.status).toBe(200);
    // The stale pass writes the newest memory; the follow-up re-embeds the other five.
    expect(await res.json()).toEqual({ embedded: 5, pending: 0, capped: false });
    expect(await c.json("/api/semantic/status")).toMatchObject({ vectors: 6, pending: 0 });
    await inAgent((agent) => {
      reset(agent.services);
      agent.services.memories.clear();
    });
  });

  it("reindex and search respect the daily embedding cap", async () => {
    await inAgent((agent) => {
      reset(agent.services);
      agent.services.memories.clear();
      for (let i = 0; i < 60; i++) agent.services.memories.create({ content: `Kayak trip number ${i}` });
    });
    const c = await loggedIn();
    // `reset` dropped the usage table, so today's count starts at zero.
    await enableQuietly({ maxEmbeddingsPerDay: 1 });

    expect(await c.json("/api/semantic/reindex", { method: "POST" })).toEqual({ embedded: 50, pending: 10, capped: true });
    const search = await c.call("/api/semantic/search?q=kayak");
    expect(search.status).toBe(200);
    const { hits } = (await search.json()) as { hits: { cosine: number | null }[] };
    expect(hits).toHaveLength(10);
    expect(hits.every((h) => h.cosine === null)).toBe(true);
    await inAgent((agent) => {
      expect(embeddingsToday(agent.services.db, UsageService.day())).toBe(1);
      reset(agent.services);
      agent.services.memories.clear();
    });
  });

  it("a model change re-embeds every memory in the background, up to the daily cap", async () => {
    await inAgent((agent) => {
      reset(agent.services);
      agent.services.memories.clear();
      for (let i = 0; i < 120; i++) agent.services.memories.create({ content: `Kayak trip number ${i}` });
    });
    await enableQuietly({ maxEmbeddingsPerDay: 10_000 });
    await inAgent((agent) => staleVectors(agent.services));
    const c = await loggedIn();
    expect(await c.json("/api/semantic/status")).toMatchObject({ vectors: 0, pending: 120 });

    const put = await c.call("/api/semantic/config", { method: "PUT", body: { model: "@cf/baai/bge-small-en-v1.5" } });
    expect(put.status).toBe(200);
    expect(await settledStatus(c)).toMatchObject({ vectors: 120, pending: 0, embeddings_today: 3 });

    // The same model again starts no indexing.
    await inAgent((agent) => {
      agent.services.db.run(`DELETE FROM tal_semantic_vectors`);
      staleVectors(agent.services);
    });
    await c.call("/api/semantic/config", { method: "PUT", body: { model: "@cf/baai/bge-small-en-v1.5" } });
    expect(await settledStatus(c)).toMatchObject({ vectors: 0, pending: 120, embeddings_today: 3 });

    // The cap stops the backfill; the rest stays pending.
    await c.call("/api/semantic/config", { method: "PUT", body: { maxEmbeddingsPerDay: 4 } });
    await c.call("/api/semantic/config", { method: "PUT", body: { model: "@cf/baai/bge-m3" } });
    expect(await settledStatus(c)).toMatchObject({ vectors: 50, pending: 70, embeddings_today: 4 });
    await inAgent((agent) => {
      reset(agent.services);
      agent.services.memories.clear();
    });
  });

  it("turning the feature on embeds every pending memory in the background", async () => {
    await inAgent((agent) => {
      reset(agent.services);
      agent.services.memories.clear();
      for (let i = 0; i < 60; i++) agent.services.memories.create({ content: `Kayak trip number ${i}` });
    });
    const c = await loggedIn();
    await c.call("/api/semantic/config", { method: "PUT", body: { enabled: true } });
    expect(await settledStatus(c)).toMatchObject({ vectors: 60, pending: 0, embeddings_today: 2 });
    await inAgent((agent) => {
      reset(agent.services);
      agent.services.memories.clear();
    });
  });
});

function resetAll(s: Services) {
  dropSemanticData(s.db);
  deleteSemanticConfig(s.settings);
  invalidateSemanticCache(s);
  s.memories.clear();
}

const vectorIds = (s: Services) =>
  s.db.all<{ memory_id: string }>(`SELECT memory_id FROM tal_semantic_vectors ORDER BY memory_id`).map((r) => r.memory_id);

/** Enables the feature, saves memories and embeds them directly, bypassing on-save hooks. */
async function seeded(a: TalorysAgent, contents: string[]) {
  const s = a.services;
  resetAll(s);
  const config = writeSemanticConfig(s.settings, { enabled: true, maxEmbeddingsPerDay: 10_000 }, s.db);
  invalidateSemanticCache(s);
  const ids = contents.map((content) => s.memories.create({ content, category: "fact" }).id);
  const sem: SemanticContext = { db: s.db, services: s, embedder: new MockEmbedder(), config: { ...DEFAULT_SEMANTIC_CONFIG, ...config } };
  await runIndexer(sem);
  expect(vectorIds(s)).toEqual([...ids].sort());
  return { s, ids, sem };
}

describe("semantic forget purge", () => {
  it("single delete removes that memory's vector in the same request", async () => {
    const ids = await inAgent(async (a) => (await seeded(a, ["Owns a red kayak", "Plays the cello"])).ids);
    const c = await loggedIn();
    const res = await c.call(`/api/memories/${ids[0]}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    await inAgent((a) => {
      expect(vectorIds(a.services)).toEqual([ids[1]]);
      resetAll(a.services);
    });
  });

  it("Clear all removes every vector in the same request", async () => {
    await inAgent((a) => seeded(a, ["Owns a red kayak", "Plays the cello"]));
    const c = await loggedIn();
    const res = await c.call("/api/memories", { method: "DELETE", body: { confirm: "DELETE" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: expect.any(Number) });
    await inAgent((a) => {
      expect(vectorIds(a.services)).toEqual([]);
      resetAll(a.services);
    });
  });

  it("a rejected Clear all keeps the vectors", async () => {
    await inAgent((a) => seeded(a, ["Owns a red kayak"]));
    const c = await loggedIn();
    expect((await c.call("/api/memories", { method: "DELETE", body: { confirm: "nope" } })).status).toBe(400);
    await inAgent((a) => {
      expect(vectorIds(a.services)).toHaveLength(1);
      resetAll(a.services);
    });
  });

  it("still purges after the feature is turned off", async () => {
    const ids = await inAgent(async (a) => {
      const { s, ids } = await seeded(a, ["Owns a red kayak", "Plays the cello"]);
      writeSemanticConfig(s.settings, { enabled: false }, s.db);
      invalidateSemanticCache(s);
      return ids;
    });
    const c = await loggedIn();
    expect((await c.call(`/api/memories/${ids[1]}`, { method: "DELETE" })).status).toBe(200);
    await inAgent((a) => {
      expect(vectorIds(a.services)).toEqual([ids[0]]);
      resetAll(a.services);
    });
  });

  it("forget_memory only proposes: the memory and its vector stay until the owner approves", async () => {
    await inAgent(async (a) => {
      const { s, ids, sem } = await seeded(a, ["Owns a red kayak", "Plays the cello"]);
      const conversation = s.conversations.create();
      const executor = new ToolExecutor(semanticTools(sem), { services: s, timezone: "UTC", mode: "chat", conversationId: conversation.id }, { maxToolCalls: 4 });
      expect(await executor.execute("forget_memory", { id: ids[0] }, "call-1")).toMatchObject({ status: "awaiting_owner_approval" });
      expect(executor.approvalFor("call-1")).toMatchObject({ status: "pending" });
      expect(s.memories.get(ids[0]!)).not.toBeNull();
      expect(vectorIds(s)).toEqual([...ids].sort());
      resetAll(s);
    });
  });

  it("an approved forget_memory deletes the memory and its vector in the same request", async () => {
    const { ids, actionId } = await inAgent(async (a) => {
      const { s, ids } = await seeded(a, ["Owns a red kayak", "Plays the cello"]);
      return { ids, actionId: await proposeAction(s, "forget_memory", { id: ids[0] }) };
    });
    const c = await loggedIn();
    const approved = await c.json(`/api/actions/${actionId}/approve`, { method: "POST", body: {} });
    expect(approved.action.status).toBe("approved");
    await inAgent((a) => {
      expect(a.services.memories.get(ids[0]!)).toBeNull();
      expect(vectorIds(a.services)).toEqual([ids[1]]);
    });
    // Approving again is a conflict and changes nothing.
    expect((await c.call(`/api/actions/${actionId}/approve`, { method: "POST", body: {} })).status).toBe(409);
    await inAgent((a) => {
      expect(vectorIds(a.services)).toEqual([ids[1]]);
      resetAll(a.services);
    });
  });

  it("an approved forget purges the vector even while the feature is off", async () => {
    const { ids, actionId } = await inAgent(async (a) => {
      const { s, ids } = await seeded(a, ["Owns a red kayak", "Plays the cello"]);
      writeSemanticConfig(s.settings, { enabled: false }, s.db);
      invalidateSemanticCache(s);
      return { ids, actionId: await proposeAction(s, "forget_memory", { id: ids[1] }) };
    });
    const c = await loggedIn();
    expect((await c.json(`/api/actions/${actionId}/approve`, { method: "POST", body: {} })).action.status).toBe("approved");
    await inAgent((a) => {
      expect(vectorIds(a.services)).toEqual([ids[0]]);
      resetAll(a.services);
    });
  });

  it("keeps the vector when the approved forget fails, and ignores other approved actions", async () => {
    const { ids, failId, taskActionId } = await inAgent(async (a) => {
      const { s, ids } = await seeded(a, ["Owns a red kayak", "Plays the cello"]);
      // A memory that is gone by approval time: upstream marks the action failed.
      const doomed = s.memories.create({ content: "Owns a canoe", category: "fact", source: "manual" });
      const failId = await proposeAction(s, "forget_memory", { id: doomed.id });
      s.memories.delete(doomed.id);
      const task = s.tasks.create({ title: "Wax the kayak" });
      return { ids, failId, taskActionId: await proposeAction(s, "delete_task", { task: task.id }) };
    });
    const c = await loggedIn();
    expect((await c.json(`/api/actions/${failId}/approve`, { method: "POST", body: {} })).action.status).toBe("failed");
    expect((await c.json(`/api/actions/${taskActionId}/approve`, { method: "POST", body: {} })).action.status).toBe("approved");
    await inAgent((a) => {
      expect(vectorIds(a.services)).toEqual([...ids].sort());
      resetAll(a.services);
    });
  });
});
