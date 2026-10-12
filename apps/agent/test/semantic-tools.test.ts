import { describe, expect, it } from "vitest";
import { inAgent } from "./helpers";
import { invalidateSemanticCache } from "../src/semantic";
import { DEFAULT_SEMANTIC_CONFIG, deleteSemanticConfig } from "../src/semantic/config";
import { MockEmbedder } from "../src/semantic/embeddings";
import { runIndexer } from "../src/semantic/indexer";
import { dropSemanticData } from "../src/semantic/migrations";
import type { SemanticContext } from "../src/semantic/recall";
import { semanticTools } from "../src/semantic/tools";
import { ALL_TOOLS, type ToolContext, type ToolDefinition } from "../src/tools";
import type { ImmediateTool } from "../src/tools/registry";
import type { TalorysAgent } from "../src/agent/talorys-agent";

function setup(a: TalorysAgent) {
  const s = a.services;
  dropSemanticData(s.db);
  deleteSemanticConfig(s.settings);
  invalidateSemanticCache(s);
  s.memories.clear();
  const sem: SemanticContext = {
    db: s.db,
    services: s,
    embedder: new MockEmbedder(),
    config: { ...DEFAULT_SEMANTIC_CONFIG, enabled: true, maxEmbeddingsPerDay: 10_000 },
  };
  const toolCtx: ToolContext = { services: s, timezone: "UTC", mode: "chat" };
  const tool = (tools: ToolDefinition[], name: string) => tools.find((t) => t.name === name)! as ImmediateTool;
  return { s, sem, toolCtx, tool };
}

// forget_memory stays upstream's: it only proposes; the approve route purges the vector (semantic-forget.test.ts).
const WRAPPED = ["search_memories", "search", "remember", "update_memory"];

describe("semantic tools", () => {
  it("keep every upstream tool and replace only the four wrappers' execute", async () => {
    await inAgent((a) => {
      const { sem } = setup(a);
      const tools = semanticTools(sem);
      expect(tools.map((t) => t.name)).toEqual(ALL_TOOLS.map((t) => t.name));
      tools.forEach((t, i) => {
        const base = ALL_TOOLS[i]!;
        expect(t.description).toBe(base.description);
        expect(t.input).toBe(base.input);
        expect(t.permission).toBe(base.permission);
        expect(t.maxCallsPerTurn).toBe(base.maxCallsPerTurn);
        expect(t.label).toBe(base.label);
        if (WRAPPED.includes(t.name)) expect((t as ImmediateTool).execute).not.toBe((base as ImmediateTool).execute);
        else expect(t).toBe(base);
      });
    });
  });

  it("search_memories returns hybrid hits with a saved date", async () => {
    await inAgent(async (a) => {
      const { s, sem, toolCtx, tool } = setup(a);
      const tesla = s.memories.create({ content: "Drives a Tesla Model 3", category: "fact" });
      s.db.run(`UPDATE tal_memories SET updated_at = ? WHERE id = ?`, "2026-10-05T10:00:00Z", tesla.id);
      s.memories.create({ content: "Capital of France is Paris", category: "fact" });
      await runIndexer(sem);

      const upstream = await tool(ALL_TOOLS, "search_memories").execute({ query: "my vehicle" }, toolCtx);
      expect(upstream).toEqual({ memories: [] });
      const result = await tool(semanticTools(sem), "search_memories").execute({ query: "my vehicle" }, toolCtx);
      expect(result).toEqual({
        memories: [{ id: tesla.id, content: "Drives a Tesla Model 3", category: "fact", saved: "2026-10-05 10:00 UTC" }],
      });
    });
  });

  it("search_memories returns at most ten hits", async () => {
    await inAgent(async (a) => {
      const { s, sem, toolCtx, tool } = setup(a);
      for (let i = 0; i < 14; i++) s.memories.create({ content: `Kayak trip number ${i}`, category: "fact" });
      const result = (await tool(semanticTools(sem), "search_memories").execute({ query: "kayak" }, toolCtx)) as {
        memories: unknown[];
      };
      expect(result.memories).toHaveLength(10);
    });
  });

  it("search keeps upstream sections and replaces memories with five hybrid hits", async () => {
    await inAgent(async (a) => {
      const { s, sem, toolCtx, tool } = setup(a);
      for (let i = 0; i < 7; i++) s.memories.create({ content: `Kayak trip number ${i}`, category: "fact" });
      const task = s.tasks.create({ title: "Wax the kayak" });
      const upstream = (await tool(ALL_TOOLS, "search").execute({ query: "kayak" }, toolCtx)) as Record<string, unknown>;
      const result = (await tool(semanticTools(sem), "search").execute({ query: "kayak" }, toolCtx)) as Record<string, unknown> & {
        memories: { id: string; content: string; saved: string }[];
      };
      expect(Object.keys(result).sort()).toEqual(["conversations", "memories", "notes", "tasks"]);
      expect(result.tasks).toEqual(upstream.tasks);
      expect(result.notes).toEqual(upstream.notes);
      expect(result.conversations).toEqual(upstream.conversations);
      expect(result.memories).toHaveLength(5);
      for (const m of result.memories) {
        expect(Object.keys(m).sort()).toEqual(["content", "id", "saved"]);
        expect(m.saved).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
      }
      s.tasks.delete(task.id);
    });
  });

  it("wraps exactly the four upstream tools", async () => {
    await inAgent((a) => {
      const { sem } = setup(a);
      const tools = semanticTools(sem);
      expect(tools.filter((t, i) => t !== ALL_TOOLS[i]).map((t) => t.name).sort()).toEqual([...WRAPPED].sort());
    });
  });

  it("remember and update_memory return upstream results and index in the background", async () => {
    await inAgent(async (a) => {
      const { s, sem, toolCtx, tool } = setup(a);
      const tools = semanticTools(sem);
      const vectors = () => s.db.all<{ memory_id: string; content_hash: string }>(`SELECT memory_id, content_hash FROM tal_semantic_vectors`);
      const saved = (await tool(tools, "remember").execute({ content: "Owns a red kayak", category: "fact" }, toolCtx)) as {
        remembered: { id: string; content: string; category: string };
      };
      expect(saved.remembered).toMatchObject({ content: "Owns a red kayak", category: "fact" });
      await runIndexer(sem);
      expect(vectors().map((v) => v.memory_id)).toEqual([saved.remembered.id]);
      const before = vectors()[0]!.content_hash;

      const updated = (await tool(tools, "update_memory").execute({ id: saved.remembered.id, content: "Owns a blue kayak" }, toolCtx)) as {
        updated: { id: string; content: string };
      };
      // The new wording is a new memory; the old one stays as history.
      expect(updated).toEqual({ updated: { id: expect.any(String), content: "Owns a blue kayak" }, previous_kept_as_history: saved.remembered.id });
      await runIndexer(sem);
      const fresh = vectors().find((v) => v.memory_id === updated.updated.id);
      expect(fresh?.content_hash).toBeDefined();
      expect(fresh?.content_hash).not.toBe(before);
      await expect(tool(tools, "update_memory").execute({ id: "missing", content: "Nothing here" }, toolCtx)).rejects.toThrow("Memory not found.");
    });
  });
});
