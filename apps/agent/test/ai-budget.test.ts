import { describe, expect, it } from "vitest";
import { inAgent } from "./helpers";
import { AgentRunner } from "../src/agent/runner";
import type { AgentEvent, AIProvider, GenerateRequest, ToolRequest } from "../src/ai/provider";
import type { Services } from "../src/services/container";

/** Counts model calls. Each turn asks for up to `extraSteps` more steps, as a tool loop would. */
class CountingProvider implements AIProvider {
  readonly id = "counting";
  generateCalls = 0;
  turnCalls = 0;
  stepsGranted = 0;
  constructor(private readonly extraSteps = 0) {}
  async generate(_req: GenerateRequest) {
    this.generateCalls++;
    return { text: "summary", usage: { inputTokens: 1, outputTokens: 1 } };
  }
  async *stream(req: GenerateRequest): AsyncIterable<AgentEvent> {
    yield* this.generateWithTools({ ...req, tools: [], maxIterations: 1, toolBudgetExhausted: () => true });
  }
  async *generateWithTools(req: ToolRequest): AsyncIterable<AgentEvent> {
    this.turnCalls++;
    for (let i = 0; i < this.extraSteps && req.reserveNextStep?.(); i++) this.stepsGranted++;
    yield { type: "text", delta: "ok" };
  }
}

/** A conversation long enough that a turn wants to summarize its overflow first. */
function longConversation(s: Services): string {
  const conv = s.conversations.create("long");
  for (let i = 0; i < 24; i++) s.conversations.addMessage({ conversation_id: conv.id, role: i % 2 ? "assistant" : "user", content: "x".repeat(2000) });
  return conv.id;
}

async function turn(s: Services, provider: AIProvider, conversationId?: string) {
  const events = [];
  for await (const e of new AgentRunner(s, provider).chat({ conversationId, message: "hi", signal: new AbortController().signal })) events.push(e);
  return events;
}

/** Runs `fn` with exactly `n` AI requests left today, restoring the limits afterwards. */
async function withRemaining(n: number, fn: (s: Services) => Promise<void>) {
  await inAgent(async (a) => {
    const s = a.services;
    const original = s.settings.get().limits;
    s.settings.update({ limits: { maxAiRequestsPerDay: s.usage.today().ai_requests + n, maxContextTokens: 1000 } });
    try {
      await fn(s);
    } finally {
      s.settings.update({ limits: original });
    }
  });
}

describe("daily AI budget", () => {
  it("counts the summary call and skips it when only the reply fits", async () => {
    // Positive control: with room for both, the turn summarizes and then replies, and both are counted.
    await withRemaining(3, async (s) => {
      const roomy = new CountingProvider();
      const used = s.usage.today().ai_requests;
      await turn(s, roomy, longConversation(s));
      expect([roomy.generateCalls, roomy.turnCalls]).toEqual([1, 1]);
      expect(s.usage.today().ai_requests).toBe(used + 2);
    });
    // One call left: the summary is skipped so the reply cannot overrun the budget.
    await withRemaining(1, async (s) => {
      const tight = new CountingProvider();
      const used = s.usage.today().ai_requests;
      await turn(s, tight, longConversation(s));
      expect([tight.generateCalls, tight.turnCalls]).toEqual([0, 1]);
      expect(s.usage.today().ai_requests).toBe(used + 1);
      // Budget spent: no model call at all.
      const events = await turn(s, tight, longConversation(s));
      expect(events.find((e) => e.type === "error")).toMatchObject({ code: "AI_LIMIT_REACHED" });
      expect(tight.turnCalls).toBe(1);
    });
  });

  it("counts every tool-loop step and ends the turn when the budget is spent", async () => {
    await withRemaining(3, async (s) => {
      const looping = new CountingProvider(10);
      const used = s.usage.today().ai_requests;
      const events = await turn(s, looping);
      // The first call plus two more steps fill the budget of three; the remaining steps are refused.
      expect(looping.stepsGranted).toBe(2);
      expect(s.usage.today().ai_requests).toBe(used + 3);
      expect(events.at(-1)).toMatchObject({ type: "done", message: { status: "complete", content: "ok" } });
    });
  });

  it("checks the budget again before scheduled steps", async () => {
    await withRemaining(2, async (s) => {
      const looping = new CountingProvider(10);
      await new AgentRunner(s, looping).runScheduledPrompt("check in");
      expect(looping.stepsGranted).toBe(1);
      expect(s.usage.canUseAi(s.settings.get().limits)).toBe(false);
    });
  });
});
