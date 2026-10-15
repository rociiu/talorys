import { describe, expect, it } from "vitest";
import { inAgent, loggedIn } from "./helpers";
import { FixtureEmbedder, fixtureConfig } from "./fixture-embedder";
import { AgentRunner } from "../src/agent/runner";
import type { AgentEvent, AIProvider, GenerateRequest, ToolRequest } from "../src/ai/provider";
import { invalidateSemanticCache, semanticItemSelector, type RunnerExtensions } from "../src/semantic";
import { deleteSemanticConfig, writeSemanticConfig } from "../src/semantic/config";
import { ITEM_SECTION_HEADING } from "../src/semantic/itemRecall";
import { dropSemanticData, ensureSemanticSchema } from "../src/semantic/migrations";
import { type SemanticContext, selectSemanticMemories } from "../src/semantic/recall";
import { pendingItems } from "../src/semantic/itemIndex";
import { semanticTools } from "../src/semantic/tools";
import type { Services } from "../src/services/container";

/** A stubbed chat model that records each request and replies with fixed text. */
class RecordingProvider implements AIProvider {
  readonly id = "recording";
  readonly model = "mock";
  readonly billable = false;
  calls: ToolRequest[] = [];
  async generate(_req: GenerateRequest) {
    return { text: "summary", usage: { model: this.model, billable: this.billable, inputTokens: { reported: 1, estimated: 0 }, outputTokens: { reported: 1, estimated: 0 }, cachedInputTokens: 0 } };
  }
  async *stream(req: GenerateRequest): AsyncIterable<AgentEvent> {
    yield* this.generateWithTools({ ...req, tools: [], maxIterations: 1, toolBudgetExhausted: () => true });
  }
  async *generateWithTools(req: ToolRequest): AsyncIterable<AgentEvent> {
    this.calls.push(req);
    yield { type: "text", delta: "Noted." };
    yield { type: "usage", usage: { model: this.model, billable: this.billable, inputTokens: { reported: 10, estimated: 0 }, outputTokens: { reported: 5, estimated: 0 }, cachedInputTokens: 0 } };
  }
}

const QUESTION = "food plans next 3 days?";

/** One chat turn in a new conversation with the fixture embedder; returns the items section, or "" without one. */
async function ask(s: Services): Promise<string> {
  const sem: SemanticContext = { db: s.db, services: s, embedder: new FixtureEmbedder(), config: fixtureConfig(), queryVectors: new Map() };
  const ext: RunnerExtensions = { selectMemories: (q) => selectSemanticMemories(sem, q), selectItems: semanticItemSelector(sem), tools: semanticTools(sem) };
  const provider = new RecordingProvider();
  for await (const _ of new AgentRunner(s, provider, ext).chat({ message: QUESTION, signal: new AbortController().signal })) {
    // drain
  }
  const system = provider.calls[0]!.system;
  const at = system.indexOf(ITEM_SECTION_HEADING);
  return at < 0 ? "" : system.slice(at).split("\n\n")[0]!;
}

const itemVectors = (s: Services) => s.db.one<{ n: number }>(`SELECT COUNT(*) AS n FROM tal_semantic_item_vectors`)!.n;
const pending = async (s: Services) => (await pendingItems(s.db, "fixture-64", 64)).pending.length;

describe("interleaved saves and questions", () => {
  it("each new chat lists the item saved since the last one, keeps the earlier ones, and nothing embeds at save time", async () => {
    await inAgent((a) => {
      const s = a.services;
      dropSemanticData(s.db);
      deleteSemanticConfig(s.settings);
      s.memories.clear();
      for (const table of ["tal_tasks", "tal_notes", "tal_automations"]) s.db.run(`DELETE FROM ${table}`);
      writeSemanticConfig(s.settings, { enabled: true }, s.db);
      invalidateSemanticCache(s);
      ensureSemanticSchema(s.db);
    });
    const c = await loggedIn();

    // 1. Nothing saved yet: no items section.
    expect(await inAgent((a) => ask(a.services))).toBe("");

    // 2. A note saved in the app stays pending; the next new chat embeds and lists it.
    const noteRes = await c.call("/api/notes", { method: "POST", body: { title: "Boiled eggs for breakfast", content: "" } });
    expect(noteRes.status).toBe(201);
    const note = ((await noteRes.json()) as { note: { id: string } }).note.id;
    await inAgent(async (a) => {
      expect(itemVectors(a.services)).toBe(0);
      expect(await pending(a.services)).toBeGreaterThan(0);
      const section = await ask(a.services);
      expect(section).toContain(`(id ${note})`);
      expect(await pending(a.services)).toBe(0);
    });

    // 3. A task: pending after the save, then listed alongside the note.
    const taskRes = await c.call("/api/tasks", { method: "POST", body: { title: "Make a salad for lunch tomorrow" } });
    expect(taskRes.status).toBe(201);
    const task = ((await taskRes.json()) as { task: { id: string } }).task.id;
    await inAgent(async (a) => {
      const before = itemVectors(a.services);
      expect(await pending(a.services)).toBe(1);
      const section = await ask(a.services);
      expect(section).toContain(`(id ${task})`);
      expect(section).toContain(`(id ${note})`);
      expect(itemVectors(a.services)).toBe(before + 1);
    });

    // 4. A reminder: pending after the save, then listed with the task and the note.
    const remRes = await c.call("/api/automations", {
      method: "POST",
      body: { name: "Pick up steaks for Friday dinner", kind: "reminder", message: "Pick up steaks for Friday dinner", schedule: { type: "once", at: "2099-01-01T17:00" } },
    });
    expect(remRes.status).toBe(201);
    const reminder = ((await remRes.json()) as { automation: { id: string } }).automation.id;
    await inAgent(async (a) => {
      expect(await pending(a.services)).toBe(1);
      const section = await ask(a.services);
      const lines = section.split("\n").slice(1);
      expect(lines).toHaveLength(3);
      for (const id of [reminder, task, note]) expect(section).toContain(`(id ${id})`);
      expect(await pending(a.services)).toBe(0);

      const s = a.services;
      dropSemanticData(s.db);
      deleteSemanticConfig(s.settings);
      invalidateSemanticCache(s);
      for (const table of ["tal_tasks", "tal_notes", "tal_automations"]) s.db.run(`DELETE FROM ${table}`);
    });
  });
});
