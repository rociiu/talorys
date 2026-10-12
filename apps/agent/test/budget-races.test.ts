import type { Memory } from "@talorys/shared";
import { describe, expect, it } from "vitest";
import { inAgent } from "./helpers";
import { AgentRunner } from "../src/agent/runner";
import type { AgentEvent, AIProvider, ToolRequest } from "../src/ai/provider";
import { DEFAULT_SEMANTIC_CONFIG } from "../src/semantic/config";
import { MockEmbedder, embeddingsToday } from "../src/semantic/embeddings";
import { ensureSemanticSchema } from "../src/semantic/migrations";
import { hybridSearch } from "../src/semantic/recall";
import { ALL_TOOLS } from "../src/tools";
import { UsageService } from "../src/services/usage";

/** Holds every call until `release()`, so concurrent callers are all in flight together. */
function gate() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => (release = resolve));
  return { opened, release };
}

class SlowEmbedder extends MockEmbedder {
  calls = 0;
  constructor(private readonly wait: Promise<void>) {
    super();
  }
  override async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls++;
    await this.wait;
    return super.embed(texts);
  }
}

class CountingProvider implements AIProvider {
  readonly id = "counting";
  turnCalls = 0;
  async generate() {
    return { text: "", usage: { inputTokens: 0, outputTokens: 0 } };
  }
  async *stream(): AsyncIterable<AgentEvent> {}
  async *generateWithTools(_req: ToolRequest): AsyncIterable<AgentEvent> {
    this.turnCalls++;
    yield { type: "text", delta: "done" };
  }
}

describe("caps hold under concurrent calls", () => {
  it("concurrent query embeddings cannot pass the daily embedding cap", async () => {
    await inAgent(async (a) => {
      const s = a.services;
      ensureSemanticSchema(s.db);
      const day = UsageService.day();
      const { opened, release } = gate();
      const embedder = new SlowEmbedder(opened);
      const ctx = { db: s.db, services: s, embedder, config: { ...DEFAULT_SEMANTIC_CONFIG, enabled: true, maxEmbeddingsPerDay: embeddingsToday(s.db, day) + 1 } };
      const searches = Array.from({ length: 8 }, (_, i) => hybridSearch(ctx, `kayak ${i}`, { limit: 4 }));
      release();
      await Promise.all(searches);
      expect(embedder.calls).toBe(1);
      expect(embeddingsToday(s.db, day)).toBe(ctx.config.maxEmbeddingsPerDay);
    });
  });

  it("a scheduled run that waited on recall cannot start after the budget is spent", async () => {
    await inAgent(async (a) => {
      const s = a.services;
      const original = s.settings.get().limits;
      const used = s.usage.today();
      // Room for exactly one scheduled AI run today.
      s.settings.update({ limits: { maxAiRequestsPerDay: used.ai_requests + 1, maxScheduledAiRunsPerDay: used.scheduled_ai_runs + 1 } });
      try {
        const { opened, release } = gate();
        const provider = new CountingProvider();
        const selectMemories = async (): Promise<Memory[]> => {
          await opened;
          return [];
        };
        const runner = new AgentRunner(s, provider, { tools: ALL_TOOLS, selectMemories });
        const runs = [runner.runScheduledPrompt("digest"), runner.runScheduledPrompt("digest")];
        release();
        const results = await Promise.allSettled(runs);
        expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
        expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "AI_LIMIT_REACHED" } });
        expect(provider.turnCalls).toBe(1);
        expect(s.usage.today().ai_requests).toBe(used.ai_requests + 1);
      } finally {
        s.settings.update({ limits: original });
      }
    });
  });
});
