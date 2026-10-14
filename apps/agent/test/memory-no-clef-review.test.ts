import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { TalorysAgent } from "../src/agent/talorys-agent";
import { invalidateSemanticCache } from "../src/semantic";
import { readSemanticConfig, writeSemanticConfig } from "../src/semantic/config";
import { embeddingsToday } from "../src/semantic/embeddings";
import { createSemanticContext } from "../src/semantic/recall";
import { UsageService } from "../src/services/usage";
import type { Env } from "../src/env";

const ns = () => (env as unknown as { TalorysAgent: DurableObjectNamespace<TalorysAgent> }).TalorysAgent;

/** A Clef-shaped response: one choice answer per older memory, in order. */
function clefReply(...answers: [string, number][]) {
  return { answers: Object.fromEntries(answers.map(([choice, p], i) => [`older_${i + 1}`, { type: "choice", choice, probabilities: { [choice]: p }, confidence: p }])) };
}

/** Each test gets its own Durable Object (and so its own empty database). */
function freshAgent() {
  const name = `memory-no-clef-${crypto.randomUUID()}`;
  return async <R>(fn: (agent: TalorysAgent, state: DurableObjectState) => R | Promise<R>): Promise<R> =>
    runInDurableObject(await getAgentByName(ns(), name), async (agent: TalorysAgent, state: DurableObjectState) => fn(agent, state));
}

function enableSemantic(agent: TalorysAgent) {
  const s = agent.services;
  writeSemanticConfig(s.settings, { enabled: true, maxEmbeddingsPerDay: 10_000 }, s.db);
  invalidateSemanticCache(s);
  return createSemanticContext(s, env as unknown as Env, readSemanticConfig(s.settings, s.db)!);
}

function aiOn(agent: TalorysAgent) {
  agent.services.settings.update({ memoryHistory: { aiConflictCheck: true } });
  return agent.services;
}

const LIMA = "I live in Lima";
const MOVED = "I moved to Quito";
const QUITO = "I live in Quito";

const pairs = (r: { reviews: { other_id: string; relationship: string }[] }) => r.reviews.map((v) => [v.other_id, v.relationship]);

describe("without Clef deciding, rules never retire a memory", () => {
  it("peanut, AI check off", async () => {
    await freshAgent()(async (agent) => {
      const s = agent.services;
      const { memory: allergy } = await s.memoryHistory.create({ content: "I'm allergic to peanuts" });
      const r = await s.memoryHistory.create({ content: "I stopped buying peanut butter for the kids" });
      expect(s.memories.get(allergy.id)?.status).toBe("active");
      expect(r.superseded).toHaveLength(0);
      expect(pairs(r)).toEqual([[allergy.id, "possible_update"]]);
    });
  });

  it("clear replacement, AI check off", async () => {
    await freshAgent()(async (agent) => {
      const s = agent.services;
      const { memory: lima } = await s.memoryHistory.create({ content: LIMA });
      const r = await s.memoryHistory.create({ content: MOVED });
      expect(s.memories.get(lima.id)?.status).toBe("active");
      expect(s.memories.get(r.memory.id)?.status).toBe("active");
      expect(r.superseded).toHaveLength(0);
      expect(pairs(r)).toEqual([[lima.id, "possible_update"]]);
    });
  });

  it("AI check on, no Clef hook", async () => {
    await freshAgent()(async (agent) => {
      const s = aiOn(agent);
      s.memoryHistory.hooks.clef = () => null;
      s.memoryHistory.hooks.neighbors = async () => [];
      const { memory: lima } = await s.memoryHistory.create({ content: LIMA });
      const used = s.usage.today().ai_requests;
      const r = await s.memoryHistory.create({ content: MOVED });
      expect(s.memories.get(lima.id)?.status).toBe("active");
      expect(r.superseded).toHaveLength(0);
      expect(pairs(r)).toEqual([[lima.id, "possible_update"]]);
      expect(s.usage.today().ai_requests).toBe(used);
    });
  });

  it("AI check on, budget spent", async () => {
    await freshAgent()(async (agent) => {
      const s = aiOn(agent);
      enableSemantic(agent);
      const { memory: lima } = await s.memoryHistory.create({ content: LIMA });
      const wired = s.memoryHistory.hooks.neighbors!;
      let neighborCalls = 0;
      s.memoryHistory.hooks.neighbors = (memory, opts) => {
        neighborCalls++;
        return wired(memory, opts);
      };
      s.memoryHistory.hooks.clef = () => async () => clefReply(["supersedes", 0.95]);
      // A fresh agent has used nothing yet and the limit must be at least 1.
      s.usage.increment({ ai_requests: 1 });
      s.settings.update({ limits: { ...s.settings.get().limits, maxAiRequestsPerDay: s.usage.today().ai_requests } });
      const day = UsageService.day();
      const embedded = embeddingsToday(s.db, day);
      const r = await s.memoryHistory.create({ content: MOVED });
      expect(s.memories.get(lima.id)?.status).toBe("active");
      expect(r.superseded).toHaveLength(0);
      expect(pairs(r)).toEqual([[lima.id, "possible_update"]]);
      expect(neighborCalls).toBe(0);
      expect(embeddingsToday(s.db, day)).toBe(embedded);
    });
  });

  it(
    "AI check on, Clef gives no usable answer",
    async () => {
      const failures: [string, () => () => Promise<unknown>][] = [
        [
          "Clef error",
          () => async () => {
            throw new Error("AI unavailable");
          },
        ],
        ["Clef timeout", () => () => new Promise(() => {})],
      ];
      for (const [label, clef] of failures) {
        await freshAgent()(async (agent) => {
          const s = aiOn(agent);
          s.memoryHistory.hooks.neighbors = async () => [];
          const { memory: lima } = await s.memoryHistory.create({ content: LIMA });
          s.memoryHistory.hooks.clef = clef;
          const r = await s.memoryHistory.create({ content: MOVED });
          expect(s.memories.get(lima.id)?.status, label).toBe("active");
          expect(r.superseded, label).toHaveLength(0);
          expect(pairs(r), label).toEqual([[lima.id, "possible_update"]]);
        });
      }
    },
    10_000,
  );

  it("AI check on, signal already aborted", async () => {
    await freshAgent()(async (agent) => {
      const s = aiOn(agent);
      s.memoryHistory.hooks.neighbors = async () => [];
      const { memory: lima } = await s.memoryHistory.create({ content: LIMA });
      let clefCalls = 0;
      s.memoryHistory.hooks.clef = () => async () => {
        clefCalls++;
        return clefReply(["supersedes", 0.95]);
      };
      const controller = new AbortController();
      controller.abort();
      const r = await s.memoryHistory.create({ content: MOVED }, { signal: controller.signal });
      expect(s.memories.get(r.memory.id)?.content).toBe(MOVED);
      expect(s.memories.get(lima.id)?.status).toBe("active");
      expect(r.superseded).toHaveLength(0);
      expect(pairs(r)).toEqual([[lima.id, "possible_update"]]);
      expect(clefCalls).toBe(0);
    });
  });
});

describe("with Clef deciding, and for explicit corrections, behavior is unchanged", () => {
  /** Saves Lima then `newer` with the AI check on and Clef giving `answer` for Lima. */
  async function withClef(newer: string, answer: [string, number]) {
    return freshAgent()(async (agent) => {
      const s = aiOn(agent);
      s.memoryHistory.hooks.neighbors = async () => [];
      const { memory: lima } = await s.memoryHistory.create({ content: LIMA });
      s.memoryHistory.hooks.clef = () => async () => clefReply(answer);
      const r = await s.memoryHistory.create({ content: newer });
      return { lima, r, limaStatus: s.memories.get(lima.id)?.status };
    });
  }

  it("a confident Clef supersedes retires the older memory", async () => {
    const { lima, r, limaStatus } = await withClef(MOVED, ["supersedes", 0.9]);
    expect(limaStatus).toBe("historical");
    expect(r.superseded.map((m) => m.id)).toEqual([lima.id]);
    expect(r.reviews).toHaveLength(0);
  });

  it("a Clef supersedes below the threshold leaves a review", async () => {
    const { lima, r, limaStatus } = await withClef(MOVED, ["supersedes", 0.79]);
    expect(limaStatus).toBe("active");
    expect(r.superseded).toHaveLength(0);
    expect(pairs(r)).toEqual([[lima.id, "possible_update"]]);
  });

  it("a confident Clef unrelated dismisses the rule review", async () => {
    const { r, limaStatus } = await withClef(QUITO, ["unrelated", 0.8]);
    expect(limaStatus).toBe("active");
    expect(r.superseded).toHaveLength(0);
    expect(r.reviews).toHaveLength(0);
  });

  it("a weak Clef unrelated keeps the rule review", async () => {
    const { lima, r, limaStatus } = await withClef(QUITO, ["unrelated", 0.79]);
    expect(limaStatus).toBe("active");
    expect(r.superseded).toHaveLength(0);
    expect(r.reviews).toHaveLength(1);
    expect(r.reviews[0]!.other_id).toBe(lima.id);
  });

  it("correct() still keeps the old memory as a past fact", async () => {
    await freshAgent()(async (agent) => {
      const s = agent.services;
      const { memory: lima } = await s.memoryHistory.create({ content: LIMA });
      const r = await s.memoryHistory.correct(lima.id, QUITO);
      expect(r.superseded.map((m) => m.id)).toContain(lima.id);
      expect(s.memories.get(lima.id)).toMatchObject({ status: "historical", superseded_by: r.memory.id });
    });
  });
});
