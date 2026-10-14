import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { TalorysAgent } from "../src/agent/talorys-agent";
import { AgentRunner } from "../src/agent/runner";
import type { AgentEvent, AIProvider, GenerateRequest, ToolRequest } from "../src/ai/provider";
import { Database } from "../src/db/database";
import { MIGRATIONS, migrate, schemaVersion } from "../src/db/migrations";
import type { ClefRequest } from "../src/memory/conflict";
import type { Env } from "../src/env";
import { invalidateSemanticCache, semanticExtensions } from "../src/semantic";
import { readSemanticConfig, writeSemanticConfig } from "../src/semantic/config";
import { embeddingsToday } from "../src/semantic/embeddings";
import { runIndexer } from "../src/semantic/indexer";
import { createSemanticContext, hybridSearch, selectSemanticMemories } from "../src/semantic/recall";
import { countVectors } from "../src/semantic/vectorStore";
import { exportData, importData } from "../src/services/backup";
import { UsageService } from "../src/services/usage";
import { BASE, fakeAi, inAgent, loggedIn } from "./helpers";

const ns = () => (env as unknown as { TalorysAgent: DurableObjectNamespace<TalorysAgent> }).TalorysAgent;

/** A Clef-shaped response: one choice answer per older memory, in order. */
function clefReply(...answers: [string, number][]) {
  return { answers: Object.fromEntries(answers.map(([choice, p], i) => [`older_${i + 1}`, { type: "choice", choice, probabilities: { [choice]: p }, confidence: p }])) };
}

/** Each test gets its own Durable Object (and so its own empty database). */
function freshAgent() {
  const name = `memory-history-${crypto.randomUUID()}`;
  return async <R>(fn: (agent: TalorysAgent, state: DurableObjectState) => R | Promise<R>): Promise<R> =>
    runInDurableObject(await getAgentByName(ns(), name), async (agent: TalorysAgent, state: DurableObjectState) => fn(agent, state));
}

class RecordingProvider implements AIProvider {
  readonly id = "recording";
  systems: string[] = [];
  async generate(_req: GenerateRequest) {
    return { text: "summary", usage: { inputTokens: 1, outputTokens: 1 } };
  }
  async *stream(req: GenerateRequest): AsyncIterable<AgentEvent> {
    yield* this.generateWithTools({ ...req, tools: [], maxIterations: 1, toolBudgetExhausted: () => true });
  }
  async *generateWithTools(req: ToolRequest): AsyncIterable<AgentEvent> {
    this.systems.push(req.system);
    yield { type: "text", delta: "ok" };
    yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

/** One chat turn; with `semantic` the runner gets the semantic module's extensions, as in production. */
async function chatOnce(agent: TalorysAgent, message: string, semantic = false) {
  const provider = new RecordingProvider();
  const ext = semantic ? semanticExtensions(agent.services, env as unknown as Env) : undefined;
  const runner = new AgentRunner(agent.services, provider, ext);
  const events = [];
  for await (const e of runner.chat({ message, signal: new AbortController().signal })) events.push(e);
  return { system: provider.systems[0] ?? "", done: events.at(-1) as { type: string; message: { status: string } } };
}

function enableSemantic(agent: TalorysAgent) {
  const s = agent.services;
  writeSemanticConfig(s.settings, { enabled: true, maxEmbeddingsPerDay: 10_000 }, s.db);
  invalidateSemanticCache(s);
  return createSemanticContext(s, env as unknown as Env, readSemanticConfig(s.settings, s.db)!);
}

describe("temporal memory", () => {
  it("keeps the replaced fact as history; present questions get the current fact, past questions get both", async () => {
    const run = freshAgent();
    await run(async (agent) => {
      // Clef runs only with real Workers AI; with the fake AI the memory-history AI check has no runner.
      expect(agent.clefRun() === null).toBe(fakeAi());
      const s = agent.services;
      const { memory: vw } = await s.memoryHistory.create({ content: "I own a Volkswagen.", category: "fact" });
      const { memory: tesla, superseded, reviews } = await s.memoryHistory.create({ content: "I sold it and bought a Tesla.", category: "fact" });
      // The rules alone never retire a memory: the replacement waits for the owner's review.
      expect(superseded).toHaveLength(0);
      expect(reviews.map((r) => [r.other_id, r.relationship])).toEqual([[vw.id, "possible_update"]]);
      expect(s.memories.get(vw.id)?.status).toBe("active");
      s.memoryHistory.resolveReview(reviews[0]!.id, "mark_historical");
      expect(s.memories.get(vw.id)).toMatchObject({ status: "historical", superseded_by: tesla.id, valid_until: null });
      expect(s.memories.get(tesla.id)?.status).toBe("active");

      // Keyword recall (semantic off): the past fact stays out of present-tense questions.
      const present = await chatOnce(agent, "Is my Volkswagen or Tesla due for service?");
      expect(present.system).toContain("I sold it and bought a Tesla.");
      expect(present.system).not.toContain("I own a Volkswagen.");
      const past = await chatOnce(agent, "Which Volkswagen did I have before?");
      expect(past.system).toMatch(/Historical context[^\n]*\n- \[fact\] I own a Volkswagen\. \(replaced by “I sold it and bought a Tesla\.”/);

      const history = s.memoryHistory.lifecycle.history(tesla.id);
      expect(history.previous.map((m) => m.id)).toEqual([vw.id]);
      expect(s.memoryHistory.lifecycle.history(vw.id).next.map((m) => m.id)).toEqual([tesla.id]);
    });
  });

  it("uses only explicitly stated dates", async () => {
    const run = freshAgent();
    await run(async (agent) => {
      const s = agent.services;
      const { memory: london } = await s.memoryHistory.create({ content: "I live in London" });
      const { memory: paris, superseded, reviews } = await s.memoryHistory.create({ content: "I moved to Paris in March 2025" });
      expect(paris.valid_from).toBe("2025-03");
      expect(superseded).toHaveLength(0);
      expect(reviews.map((r) => [r.other_id, r.relationship])).toEqual([[london.id, "possible_update"]]);
      expect(s.memories.get(london.id)?.status).toBe("active");
      const { memory: plain } = await s.memoryHistory.create({ content: "Prefers window seats" });
      expect(plain.valid_from).toBeNull();
    });
  });

  it("mark historical ends the older memory when the newer one starts", async () => {
    const run = freshAgent();
    await run(async (agent) => {
      const s = agent.services;
      const { memory: london } = await s.memoryHistory.create({ content: "I live in London" });
      const { memory: paris, reviews } = await s.memoryHistory.create({ content: "I moved to Paris in March 2025" });
      expect(reviews.map((r) => [r.other_id, r.relationship])).toEqual([[london.id, "possible_update"]]);
      s.memoryHistory.resolveReview(reviews[0]!.id, "mark_historical");
      expect(s.memories.get(london.id)).toMatchObject({ status: "historical", superseded_by: paris.id, valid_until: "2025-03" });
      expect(s.memories.get(paris.id)).toMatchObject({ status: "active", valid_from: "2025-03" });
    });

    // Without a stated date nothing is invented: the older memory keeps no end date.
    await freshAgent()(async (agent) => {
      const s = agent.services;
      const { memory: berlin } = await s.memoryHistory.create({ content: "I live in Berlin" });
      const { memory: rome, reviews: romeReviews } = await s.memoryHistory.create({ content: "I moved to Rome" });
      expect(romeReviews.map((r) => [r.other_id, r.relationship])).toEqual([[berlin.id, "possible_update"]]);
      s.memoryHistory.resolveReview(romeReviews[0]!.id, "mark_historical");
      expect(s.memories.get(berlin.id)).toMatchObject({ status: "historical", superseded_by: rome.id, valid_until: null });
      expect(s.memories.get(rome.id)?.valid_from).toBeNull();
    });
  });
});

describe("with semantic recall (#9) on", () => {
  it("leaves past facts out of present questions and brings them in for questions about the past", async () => {
    const run = freshAgent();
    await run(async (agent) => {
      const s = agent.services;
      const ctx = enableSemantic(agent);
      const { memory: bug } = await s.memoryHistory.create({ content: "I drive a VW Bug" });
      const { memory: tesla, reviews } = await s.memoryHistory.create({ content: "I sold the VW Bug and bought a Tesla" });
      expect(s.memories.get(bug.id)?.status).toBe("active");
      expect(reviews.map((r) => [r.other_id, r.relationship])).toEqual([[bug.id, "possible_update"]]);
      s.memoryHistory.resolveReview(reviews[0]!.id, "mark_historical");
      expect(s.memories.get(bug.id)?.status).toBe("historical");
      await runIndexer(ctx);

      const presentHits = await hybridSearch(ctx, "What car do I drive?", { limit: 8 });
      expect(presentHits.map((h) => h.memory.id)).toContain(tesla.id);
      expect(presentHits.map((h) => h.memory.id)).not.toContain(bug.id);
      const present = (await selectSemanticMemories(ctx, "What car do I drive?")).map((m) => m.id);
      expect(present).not.toContain(bug.id);

      const past = (await selectSemanticMemories(ctx, "What car did I drive before?")).map((m) => m.id);
      expect(past).toEqual(expect.arrayContaining([bug.id, tesla.id]));
      const explicit = await hybridSearch(ctx, "What car do I drive?", { limit: 8, includeHistorical: true });
      expect(explicit.map((h) => h.memory.id)).toContain(bug.id);

      const chat = await chatOnce(agent, "What car do I drive?", true);
      expect(chat.done.message.status).toBe("complete");
      expect(chat.system).toContain("bought a Tesla");
      expect(chat.system).not.toContain("I drive a VW Bug");
      const chatPast = await chatOnce(agent, "What car did I drive before?", true);
      expect(chatPast.system).toMatch(/Historical context[^\n]*\n- \[other\] \(saved [^)]+\) I drive a VW Bug \(replaced by “I sold the VW Bug/);
    });
  });

  it("removes vectors when memories are deleted through reviews, forget and clear", async () => {
    const run = freshAgent();
    await run(async (agent) => {
      const s = agent.services;
      const ctx = enableSemantic(agent);
      await s.memoryHistory.create({ content: "I live in Oslo" });
      const { memory: rome, reviews } = await s.memoryHistory.create({ content: "I live in Rome" });
      await s.memoryHistory.create({ content: "Likes jazz" });
      await runIndexer(ctx);
      const model = ctx.embedder!.model;
      expect(countVectors(s.db, model)).toBe(3);

      s.memoryHistory.resolveReview(reviews[0]!.id, "replace");
      expect(countVectors(s.db, model)).toBe(2);
      s.memoryHistory.delete(rome.id);
      expect(countVectors(s.db, model)).toBe(1);
      s.memoryHistory.clear();
      expect(countVectors(s.db, model)).toBe(0);
    });
  });
});

describe("conflict detection", () => {
  it("distinguishes visits, permanent moves and ambiguous statements", async () => {
    const run = freshAgent();
    await run(async (agent) => {
      const s = agent.services;
      const { memory: london } = await s.memoryHistory.create({ content: "I live in London." });
      const visit = await s.memoryHistory.create({ content: "I visited Paris." });
      expect(visit.superseded).toHaveLength(0);
      expect(visit.reviews).toHaveLength(0);
      expect(s.memories.get(london.id)?.status).toBe("active");

      const ambiguous = await s.memoryHistory.create({ content: "I live in Paris." });
      expect(ambiguous.superseded).toHaveLength(0);
      expect(ambiguous.reviews).toHaveLength(1);
      expect(s.memories.get(london.id)?.status).toBe("active");
      expect(s.memories.list({ status: "review" }).map((m) => m.id).sort()).toEqual([london.id, ambiguous.memory.id].sort());

      const moved = await s.memoryHistory.create({ content: "I moved permanently to Berlin." });
      expect(moved.superseded).toHaveLength(0);
      expect(moved.reviews.map((r) => r.other_id)).toContain(london.id);
      expect(s.memories.get(london.id)?.status).toBe("active");
    });
  });

  it("lets the owner resolve reviews: keep both, mark historical, replace or cancel", async () => {
    const run = freshAgent();
    await run(async (agent) => {
      const s = agent.services;
      const make = async (old: string, next: string) => {
        const { memory: a } = await s.memoryHistory.create({ content: old });
        const { memory: b, reviews } = await s.memoryHistory.create({ content: next });
        expect(reviews).toHaveLength(1);
        return { a, b, review: reviews[0]! };
      };
      let c = await make("I work at Acme as an engineer", "I work at Globex as a designer");
      s.memoryHistory.resolveReview(c.review.id, "keep_both");
      expect([s.memories.get(c.a.id)?.status, s.memories.get(c.b.id)?.status]).toEqual(["active", "active"]);

      c = await make("I live in Oslo", "I live in Rome");
      s.memoryHistory.resolveReview(c.review.id, "mark_historical");
      expect(s.memories.get(c.a.id)).toMatchObject({ status: "historical", superseded_by: c.b.id });

      c = await make("I'm married to Sam", "I'm dating Alex");
      s.memoryHistory.resolveReview(c.review.id, "replace");
      expect(s.memories.get(c.a.id)).toBeNull();
      expect(s.memories.get(c.b.id)).not.toBeNull();

      c = await make("I'm vegan", "I'm pescatarian");
      s.memoryHistory.resolveReview(c.review.id, "cancel");
      expect(s.memories.get(c.b.id)).toBeNull();
      expect(s.memories.get(c.a.id)?.status).toBe("active");
      expect(s.memories.reviewCount()).toBe(0);
      expect(() => s.memoryHistory.resolveReview(c.review.id, "keep_both")).toThrow(/no longer exists/);
    });
  });

  it("with the AI check on, rules only nominate and one Clef call per save decides", async () => {
    const run = freshAgent();
    await run(async (agent) => {
      const s = agent.services;
      s.settings.update({ memoryHistory: { aiConflictCheck: true } });
      let reply: unknown = null;
      let fail = false;
      let calls = 0;
      const used = s.usage.today().ai_requests;
      s.memoryHistory.hooks.clef = () => async () => {
        calls++;
        if (fail) throw new Error("AI unavailable");
        return reply;
      };

      // A confident "supersedes" replaces the older memory.
      const { memory: lisbon } = await s.memoryHistory.create({ content: "I live in Lisbon" });
      reply = clefReply(["supersedes", 0.93]);
      const r1 = await s.memoryHistory.create({ content: "I live in Porto" });
      expect(r1.superseded.map((m) => m.id)).toEqual([lisbon.id]);
      expect(s.memories.get(lisbon.id)?.status).toBe("historical");

      // A rule-confident supersede Clef calls unrelated is not dropped: the owner reviews it
      // (it used to vanish), and nothing is superseded.
      const { memory: peanuts } = await s.memoryHistory.create({ content: "I'm allergic to peanuts" });
      reply = clefReply(["unrelated", 0.74]);
      const r2 = await s.memoryHistory.create({ content: "I stopped buying peanut butter for the kids." });
      expect(r2.superseded).toHaveLength(0);
      expect(r2.reviews.map((r) => [r.other_id, r.relationship])).toEqual([[peanuts.id, "possible_update"]]);
      expect(s.memories.get(peanuts.id)?.status).toBe("active");

      // A doubtful "supersedes" waits for review instead of replacing anything.
      reply = clefReply(["supersedes", 0.62]);
      const r3 = await s.memoryHistory.create({ content: "I live in Faro" });
      expect(r3.superseded).toHaveLength(0);
      expect(r3.reviews.map((r) => r.other_id)).toEqual([r1.memory.id]);
      expect(r3.reviews[0]!.reason).toContain("62% sure");

      // No usable answer (error, or a response that isn't Clef's shape): as with the AI check off,
      // the rules' confident supersede becomes a review instead of retiring the older memory.
      fail = true;
      const { memory: vw } = await s.memoryHistory.create({ content: "I own a Volkswagen." });
      const r4 = await s.memoryHistory.create({ content: "I sold it and bought a Tesla." });
      expect(r4.superseded).toHaveLength(0);
      expect(r4.reviews.map((r) => [r.other_id, r.relationship])).toEqual([[vw.id, "possible_update"]]);
      expect(s.memories.get(vw.id)?.status).toBe("active");

      fail = false;
      reply = { answers: { older_1: { choice: "delete_everything", probabilities: { delete_everything: 1 } } } };
      const { memory: bike } = await s.memoryHistory.create({ content: "I ride a red bike" });
      const r5 = await s.memoryHistory.create({ content: "I sold my red bike" });
      expect(r5.superseded).toHaveLength(0);
      expect(r5.reviews.map((r) => [r.other_id, r.relationship])).toEqual([[bike.id, "possible_update"]]);
      expect(s.memories.get(bike.id)?.status).toBe("active");
      expect(calls).toBe(5);

      // Each Clef call reserves one AI request; with the day's budget spent Clef isn't called and
      // the rules decide as with the AI check off (their confident supersede becomes a review).
      expect(s.usage.today().ai_requests).toBe(used + 5);
      s.settings.update({ limits: { ...s.settings.get().limits, maxAiRequestsPerDay: s.usage.today().ai_requests } });
      const { memory: scooter } = await s.memoryHistory.create({ content: "I ride a green scooter" });
      const r6 = await s.memoryHistory.create({ content: "I sold my green scooter" });
      expect(calls).toBe(5);
      expect(r6.superseded).toHaveLength(0);
      expect(r6.reviews.map((r) => [r.other_id, r.relationship])).toEqual([[scooter.id, "possible_update"]]);
      expect(s.memories.get(scooter.id)?.status).toBe("active");
    });
  });

  it("sends at most three similar memories above the cosine floor to the AI check", async () => {
    const run = freshAgent();
    await run(async (agent) => {
      const s = agent.services;
      s.settings.update({ memoryHistory: { aiConflictCheck: true } });
      const olds: { id: string }[] = [];
      for (const content of ["Alpha kayaks", "Beta gardens", "Gamma pianos", "Delta violins", "Epsilon tulips"]) {
        olds.push((await s.memoryHistory.create({ content })).memory);
      }
      const requests: ClefRequest[] = [];
      s.memoryHistory.hooks.clef = () => async (request) => {
        requests.push(request);
        return clefReply(["supersedes", 0.9], ["unrelated", 0.8], ["complements", 0.7]);
      };
      // Cosines 0.9, 0.8, 0.7, 0.6, 0.5: four clear the floor, the cap keeps three.
      s.memoryHistory.hooks.neighbors = async () => olds.map((m, i) => ({ id: m.id, cosine: 0.9 - i * 0.1 }));
      const r = await s.memoryHistory.create({ content: "Zeta harmonicas" });
      expect(requests).toHaveLength(1);
      expect(Object.keys(requests[0]!.questions)).toEqual(["older_1", "older_2", "older_3"]);
      expect(requests[0]!.state.older.map((o) => o.content)).toEqual(["Alpha kayaks", "Beta gardens", "Gamma pianos"]);
      expect(r.superseded.map((m) => m.id)).toEqual([olds[0]!.id]);
    });
  });

  it("does nothing extra when conflict review is off", async () => {
    const run = freshAgent();
    await run(async (agent) => {
      const s = agent.services;
      expect(s.settings.get().memoryHistory).toEqual({ conflictReview: true, aiConflictCheck: false });
      s.settings.update({ memoryHistory: { conflictReview: false } });
      const { memory: a } = await s.memoryHistory.create({ content: "I own a Volkswagen." });
      const r = await s.memoryHistory.create({ content: "I sold it and bought a Tesla." });
      expect(r.superseded).toHaveLength(0);
      expect(s.memories.get(a.id)?.status).toBe("active");
    });
  });
});

describe("memory lifecycle", () => {
  it("prevents cycles and self-references, restores history, and deletes completely", async () => {
    const run = freshAgent();
    await run(async (agent) => {
      const s = agent.services;
      const lc = s.memoryHistory.lifecycle;
      const { memory: a } = await s.memoryHistory.create({ content: "Alpha fact about kayaks" });
      const { memory: b } = await s.memoryHistory.create({ content: "Beta fact about gardens" });
      const { memory: c } = await s.memoryHistory.create({ content: "Gamma fact about pianos" });
      lc.supersede(a.id, b.id);
      lc.supersede(b.id, c.id);
      expect(() => lc.supersede(c.id, a.id)).toThrow(/replace itself/);
      expect(() => lc.supersede(a.id, a.id)).toThrow();
      expect(lc.history(c.id).previous.map((m) => m.id)).toEqual([a.id, b.id]);

      expect(lc.setStatus(b.id, "active")).toMatchObject({ status: "active", superseded_by: null });
      expect(lc.setStatus(b.id, "uncertain").status).toBe("uncertain");
      expect(lc.setStatus(b.id, "historical").status).toBe("historical");

      // Deleting a memory leaves no dangling links and no full-text entry.
      s.memoryHistory.delete(b.id);
      expect(s.memories.get(a.id)).toMatchObject({ status: "historical", superseded_by: null });
      expect(s.db.one(`SELECT count(*) AS n FROM tal_memories_fts WHERE tal_memories_fts MATCH 'gardens'`)).toEqual({ n: 0 });
      expect(s.memoryHistory.clear()).toBe(2);
    });
  });

  it("keeps the prompt's memory block within its token budget", async () => {
    const run = freshAgent();
    await run(async (agent) => {
      const s = agent.services;
      const many = [];
      for (let i = 0; i < 6; i++) many.push((await s.memoryHistory.create({ content: `Long memory ${i} ${"x".repeat(200)}` })).memory);
      expect(s.memoryHistory.promptMemories(many, 10_000)).toHaveLength(6);
      expect(s.memoryHistory.promptMemories(many, 130)).toHaveLength(2);
      expect(s.memoryHistory.promptMemories(many, 5)).toHaveLength(0);
    });
  });
});

describe("migration from the previous schema", () => {
  it("upgrades a v3 database without losing memories; existing memories stay current", async () => {
    const run = freshAgent();
    await run((agent, state) => {
      const db = new Database(state.storage);
      // Rebuild the exact v3 shape: remove everything migration 4 added.
      for (const idx of ["tal_memories_status", "tal_memories_superseded_by"]) db.run(`DROP INDEX IF EXISTS ${idx}`);
      db.run(`DROP TABLE IF EXISTS tal_memory_reviews`);
      for (const col of ["status", "superseded_by", "valid_from", "valid_until"]) db.run(`ALTER TABLE tal_memories DROP COLUMN ${col}`);
      // ...and what later migrations added.
      for (const col of ["target_version", "payload", "preview"]) db.run(`ALTER TABLE tal_pending_actions DROP COLUMN ${col}`);
      db.run(`UPDATE tal_schema SET version = 3`);
      db.run(
        `INSERT INTO tal_memories (id, content, category, source, created_at, updated_at) VALUES ('legacy-1', 'Legacy memory about sailing', 'fact', 'manual', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
      );
      expect(schemaVersion(db)).toBe(3);

      expect(migrate(db)).toBe(MIGRATIONS.at(-1)!.version);
      expect(migrate(db)).toBe(MIGRATIONS.at(-1)!.version);
      const m = db.one(`SELECT * FROM tal_memories WHERE id = 'legacy-1'`);
      expect(m).toMatchObject({ content: "Legacy memory about sailing", status: "active", superseded_by: null, valid_from: null, valid_until: null });
      expect(agent.services.memories.search("sailing").map((x) => x.id)).toEqual(["legacy-1"]);
      for (const s of MIGRATIONS.filter((m) => m.version > 3).flatMap((m) => m.statements)) expect(s).not.toMatch(/\bDROP\b/i);
    });
  });
});

describe("backup and restore", () => {
  it("round-trips lifecycle relationships", async () => {
    const source = freshAgent();
    const backup = await source(async (agent) => {
      const s = agent.services;
      await s.memoryHistory.create({ content: "I own a Volkswagen." });
      const { reviews } = await s.memoryHistory.create({ content: "I sold it and bought a Tesla." });
      s.memoryHistory.resolveReview(reviews[0]!.id, "mark_historical");
      return JSON.parse(JSON.stringify(exportData(s)));
    });
    expect(backup.version).toBe(1);
    const vw = backup.data.memories.find((m: any) => m.content === "I own a Volkswagen.");
    const tesla = backup.data.memories.find((m: any) => m.content.includes("Tesla"));
    expect(vw).toMatchObject({ status: "historical", superseded_by: tesla.id });

    const target = freshAgent();
    await target(async (agent) => {
      const s = agent.services;
      for (let i = 0; i < 2; i++) await importData(s, backup);
      expect(s.memories.count()).toBe(2);
      expect(s.memories.get(vw.id)).toMatchObject({ status: "historical", superseded_by: tesla.id, source: "import" });
      expect(s.memories.search("Tesla").map((m) => m.id)).toEqual([tesla.id]);
    });
  });

  it("imports old backups, rejects invalid or cyclic links, and keeps newer local edits", async () => {
    const run = freshAgent();
    await run(async (agent) => {
      const s = agent.services;
      const t = "2026-01-01T00:00:00.000Z";
      const v1 = {
        format: "talorys-backup",
        version: 1,
        exported_at: t,
        data: { memories: [{ id: "old-1", content: "Pre-history fact about chess", category: "fact", created_at: t, updated_at: t }] },
      };
      await importData(s, v1);
      expect(s.memories.get("old-1")).toMatchObject({ status: "active", superseded_by: null });

      const cyclic = {
        ...v1,
        data: {
          memories: [
            { id: "c-1", content: "Cycle one", category: "fact", status: "historical", superseded_by: "c-2", created_at: t, updated_at: t },
            { id: "c-2", content: "Cycle two", category: "fact", status: "historical", superseded_by: "c-1", created_at: t, updated_at: t },
            { id: "c-3", content: "Self link", category: "fact", status: "historical", superseded_by: "c-3", created_at: t, updated_at: t },
            { id: "c-4", content: "Dangling", category: "fact", status: "bogus", superseded_by: "missing", valid_from: "yesterday", created_at: t, updated_at: t },
          ],
        },
      };
      await importData(s, cyclic);
      const links = ["c-1", "c-2"].map((id) => s.memories.get(id)!.superseded_by);
      expect(links.filter(Boolean)).toHaveLength(1);
      expect(s.memories.get("c-3")!.superseded_by).toBeNull();
      expect(s.memories.get("c-4")).toMatchObject({ status: "active", superseded_by: null, valid_from: null });

      // A newer local edit is not overwritten by an older backup copy.
      await s.memoryHistory.update("old-1", { content: "Edited locally: chess and go" });
      await importData(s, v1);
      expect(s.memories.get("old-1")!.content).toBe("Edited locally: chess and go");
    });
  });
});

describe("memory history API", () => {
  it("exposes lifecycle, history, reviews and corrections", async () => {
    const c = await loggedIn();
    const tag = crypto.randomUUID().slice(0, 8);
    const { memory: oldCar } = await c.json("/api/memories", { method: "POST", body: { content: `I drive a Volkswagen ${tag}` } });
    const created = await c.json("/api/memories", { method: "POST", body: { content: `I sold my Volkswagen ${tag} and bought a Tesla` } });
    // The replacement waits for review; marking the old car historical is the owner's call.
    expect(created.superseded).toEqual([]);
    expect(created.reviews).toBe(1);
    const pending = (await c.json("/api/memories/reviews")).reviews.find((r: any) => r.memory.id === created.memory.id);
    expect(pending.other.id).toBe(oldCar.id);
    await c.json(`/api/memories/reviews/${pending.id}`, { method: "POST", body: { action: "mark_historical" } });

    const historical = await c.json(`/api/memories?status=historical&q=${tag}`);
    expect(historical.memories.map((m: any) => m.id)).toEqual([oldCar.id]);
    expect(historical.counts.historical).toBeGreaterThan(0);
    const history = await c.json(`/api/memories/${created.memory.id}/history`);
    expect(history.previous.map((m: any) => m.id)).toEqual([oldCar.id]);

    const restored = await c.json(`/api/memories/${oldCar.id}/status`, { method: "POST", body: { status: "active" } });
    expect(restored.memory).toMatchObject({ status: "active", superseded_by: null });
    expect((await c.call(`/api/memories/${oldCar.id}/status`, { method: "POST", body: { status: "deleted" } })).status).toBe(400);

    const corrected = await c.json(`/api/memories/${oldCar.id}/correct`, { method: "POST", body: { content: `I drive a Rivian ${tag}` } });
    expect(corrected.superseded.map((m: any) => m.id)).toContain(oldCar.id);

    await c.json("/api/memories", { method: "POST", body: { content: `I live in Lima ${tag}` } });
    const conflict = await c.json("/api/memories", { method: "POST", body: { content: `I live in Quito ${tag}` } });
    expect(conflict.reviews).toBe(1);
    const { reviews } = await c.json("/api/memories/reviews");
    const review = reviews.find((r: any) => r.memory.id === conflict.memory.id);
    expect(review.other.content).toBe(`I live in Lima ${tag}`);
    expect((await c.call(`/api/memories/reviews/${review.id}`, { method: "POST", body: { action: "explode" } })).status).toBe(400);
    expect((await c.json(`/api/memories/reviews/${review.id}`, { method: "POST", body: { action: "mark_historical" } })).kept).toHaveLength(2);

    expect((await c.call("/api/settings", { method: "PATCH", body: { memoryHistory: { conflictReview: "yes" } } })).status).toBe(400);
    for (const m of (await c.json(`/api/memories?q=${tag}`)).memories) await c.call(`/api/memories/${m.id}`, { method: "DELETE" });
  });
});

describe("PR #22 review", () => {
  const LONDON = "I live in London";
  const MOVED = "I moved to Paris";

  function aiOn(agent: TalorysAgent) {
    agent.services.settings.update({ memoryHistory: { aiConflictCheck: true } });
    return agent.services;
  }

  it("#2 a rule-confident supersede becomes a review when Clef cannot answer", async () => {
    const cases: [string, (s: TalorysAgent["services"]) => void][] = [
      ["no Clef", (s) => (s.memoryHistory.hooks.clef = () => null)],
      [
        "budget spent",
        (s) => {
          s.memoryHistory.hooks.clef = () => async () => clefReply(["supersedes", 0.95]);
          // A fresh agent has used nothing yet and the limit must be at least 1.
          s.usage.increment({ ai_requests: 1 });
          s.settings.update({ limits: { ...s.settings.get().limits, maxAiRequestsPerDay: s.usage.today().ai_requests } });
        },
      ],
      [
        "Clef error",
        (s) =>
          (s.memoryHistory.hooks.clef = () => async () => {
            throw new Error("AI unavailable");
          }),
      ],
    ];
    for (const [, setup] of cases) {
      await freshAgent()(async (agent) => {
        const s = aiOn(agent);
        s.memoryHistory.hooks.neighbors = async () => [];
        const { memory: london } = await s.memoryHistory.create({ content: LONDON });
        setup(s);
        const r = await s.memoryHistory.create({ content: MOVED });
        expect(s.memories.get(london.id)?.status).toBe("active");
        expect(r.superseded).toHaveLength(0);
        expect(r.reviews.map((v) => [v.other_id, v.relationship])).toEqual([[london.id, "possible_update"]]);
      });
    }
  });

  it("#3 a rule-confident supersede Clef calls unrelated is kept for review, not dropped", async () => {
    await freshAgent()(async (agent) => {
      const s = aiOn(agent);
      s.memoryHistory.hooks.neighbors = async () => [];
      const { memory: london } = await s.memoryHistory.create({ content: LONDON });
      s.memoryHistory.hooks.clef = () => async () => clefReply(["unrelated", 0.3]);
      const r = await s.memoryHistory.create({ content: MOVED });
      expect(r.reviews.some((v) => v.relationship === "possible_update" && v.other_id === london.id)).toBe(true);
      expect(r.superseded).toHaveLength(0);
      expect(s.memories.get(london.id)?.status).toBe("active");
    });
  });

  const LIMA = "I live in Lima";
  const QUITO = "I live in Quito";

  /** Saves Lima then Quito with the AI check on and Clef giving `answer` for Lima. */
  async function limaThenQuito(answer: [string, number]) {
    return freshAgent()(async (agent) => {
      const s = aiOn(agent);
      s.memoryHistory.hooks.neighbors = async () => [];
      const { memory: lima } = await s.memoryHistory.create({ content: LIMA });
      s.memoryHistory.hooks.clef = () => async () => clefReply(answer);
      const r = await s.memoryHistory.create({ content: QUITO });
      return { lima, r, limaStatus: s.memories.get(lima.id)?.status };
    });
  }

  it("#1 a weak Clef answer keeps the rule review", async () => {
    const offRelationship = await freshAgent()(async (agent) => {
      const s = agent.services;
      await s.memoryHistory.create({ content: LIMA });
      const r = await s.memoryHistory.create({ content: QUITO });
      expect(r.reviews).toHaveLength(1);
      return r.reviews[0]!.relationship;
    });
    for (const answer of [["unrelated", 0.3], ["refines", 0.3], ["complements", 0.79]] as [string, number][]) {
      const { lima, r, limaStatus } = await limaThenQuito(answer);
      expect(r.reviews, answer.join(" ")).toHaveLength(1);
      expect(r.reviews[0]).toMatchObject({ other_id: lima.id, relationship: offRelationship });
      expect(r.superseded).toHaveLength(0);
      expect(limaStatus).toBe("active");
    }
  });

  it("#1 a confident Clef answer dismisses the rule review", async () => {
    for (const answer of [["unrelated", 0.8], ["unrelated", 0.95]] as [string, number][]) {
      const { r, limaStatus } = await limaThenQuito(answer);
      expect(r.reviews, answer.join(" ")).toHaveLength(0);
      expect(r.superseded).toHaveLength(0);
      expect(limaStatus).toBe("active");
    }
  });

  it("#4 a cancelled save is not counted as an AI error", async () => {
    await freshAgent()(async (agent) => {
      const s = aiOn(agent);
      s.memoryHistory.hooks.neighbors = async () => [];
      await s.memoryHistory.create({ content: LONDON });
      const controller = new AbortController();
      s.memoryHistory.hooks.clef = () => async () => {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      };
      const errors = s.usage.today().ai_errors;
      await s.memoryHistory.create({ content: MOVED }, { signal: controller.signal });
      expect(s.usage.today().ai_errors).toBe(errors);

      s.memoryHistory.hooks.clef = () => async () => {
        throw new Error("AI unavailable");
      };
      await s.memoryHistory.create({ content: "I moved to Rome" });
      expect(s.usage.today().ai_errors).toBe(errors + 1);
    });
  });

  it("#5 a cancelled save stops waiting for Clef and falls back to the rules", async () => {
    await freshAgent()(async (agent) => {
      const s = aiOn(agent);
      s.memoryHistory.hooks.neighbors = async () => [];
      const { memory: london } = await s.memoryHistory.create({ content: LONDON });
      s.memoryHistory.hooks.clef = () => () => new Promise(() => {});
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50);
      const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1000));
      const result = await Promise.race([s.memoryHistory.create({ content: MOVED }, { signal: controller.signal }), timeout]);
      expect(result).not.toBe("timeout");
      expect(s.memories.get(london.id)?.status).toBe("active");
      expect((result as Exclude<typeof result, "timeout">).reviews.map((v) => [v.other_id, v.relationship])).toContainEqual([london.id, "possible_update"]);
    });
  });

  it("#5 an HTTP save passes its request signal to the conflict check", async () => {
    const c = await loggedIn();
    const tag = crypto.randomUUID().slice(0, 8);
    await inAgent(async (agent) => {
      const s = agent.services;
      const { hooks } = s.memoryHistory;
      const before = s.settings.get().memoryHistory;
      try {
        aiOn(agent);
        s.memoryHistory.hooks = { ...hooks, neighbors: async () => [] };
        const { memory: london } = await s.memoryHistory.create({ content: `${LONDON} ${tag}` });
        let calls = 0;
        s.memoryHistory.hooks.clef = () => () => {
          calls++;
          return new Promise(() => {});
        };
        const errors = s.usage.today().ai_errors;
        const controller = new AbortController();
        controller.abort();
        const request = new Request(`${BASE}/api/memories`, {
          method: "POST",
          signal: controller.signal,
          headers: { "cf-connecting-ip": c.ip, "x-talorys-request": "1", origin: BASE, "content-type": "application/json", cookie: c.cookie! },
          body: JSON.stringify({ content: `${MOVED} ${tag}` }),
        });
        const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1000));
        const res = await Promise.race([agent.fetch(request), timeout]);
        expect(res).not.toBe("timeout");
        expect((res as Response).status).toBe(201);
        expect(calls).toBe(0);
        expect(s.memories.get(london.id)?.status).toBe("active");
        expect((await (res as Response).json<{ reviews: number }>()).reviews).toBe(1);
        expect(s.usage.today().ai_errors).toBe(errors);
      } finally {
        s.memoryHistory.hooks = hooks;
        s.settings.update({ memoryHistory: before });
      }
    });
  });

  it("#6 nothing is embedded when Clef cannot run", async () => {
    const cases: ((s: TalorysAgent["services"]) => void)[] = [
      (s) => (s.memoryHistory.hooks.clef = () => null),
      (s) => {
        s.memoryHistory.hooks.clef = () => async () => clefReply(["unrelated", 0.9]);
        s.usage.increment({ ai_requests: 1 });
        s.settings.update({ limits: { ...s.settings.get().limits, maxAiRequestsPerDay: s.usage.today().ai_requests } });
      },
    ];
    for (const setup of cases) {
      await freshAgent()(async (agent) => {
        const s = aiOn(agent);
        enableSemantic(agent);
        await s.memoryHistory.create({ content: "My knee hurts on long hikes" });
        const wired = s.memoryHistory.hooks.neighbors!;
        let calls = 0;
        s.memoryHistory.hooks.neighbors = (memory, opts) => {
          calls++;
          return wired(memory, opts);
        };
        setup(s);
        const day = UsageService.day();
        const before = embeddingsToday(s.db, day);
        await s.memoryHistory.create({ content: "I enjoy hiking in the mountains" });
        expect(calls).toBe(0);
        expect(embeddingsToday(s.db, day)).toBe(before);
      });
    }
  });

  it("#8 asks for neighbors above the floor and keeps their order", async () => {
    await freshAgent()(async (agent) => {
      const s = aiOn(agent);
      s.memoryHistory.hooks.neighbors = async () => [];
      const { memory: a } = await s.memoryHistory.create({ content: "Alpha kayaks" });
      const { memory: b } = await s.memoryHistory.create({ content: "Beta gardens" });
      const calls: unknown[][] = [];
      s.memoryHistory.hooks.neighbors = async (memory, opts) => {
        calls.push([memory, opts]);
        return [
          { id: a.id, cosine: 0.7 },
          { id: b.id, cosine: 0.9 },
        ];
      };
      const requests: ClefRequest[] = [];
      s.memoryHistory.hooks.clef = () => async (request) => {
        requests.push(request);
        return clefReply(["unrelated", 0.9], ["unrelated", 0.9]);
      };
      await s.memoryHistory.create({ content: "Zeta harmonicas" });
      expect(calls[0]![1]).toEqual({ minCosine: 0.6, limit: 3, exclude: new Set() });
      expect(requests[0]!.state.older.map((o) => o.content)).toEqual(["Alpha kayaks", "Beta gardens"]);
    });
  });

  it("#9 with Clef unavailable, the AI check on behaves as the AI check off", async () => {
    const outcome = async (older: string, newer: string, ai: boolean) =>
      freshAgent()(async (agent) => {
        const s = agent.services;
        if (ai) {
          aiOn(agent);
          s.memoryHistory.hooks.clef = () => null;
          s.memoryHistory.hooks.neighbors = async () => [];
        }
        await s.memoryHistory.create({ content: older });
        const seen = new Set(s.activity.list(1000).map((e) => e.id));
        const r = await s.memoryHistory.create({ content: newer });
        return {
          superseded: r.superseded.map((m) => m.content),
          reviews: r.reviews.map((v) => v.relationship),
          activity: s.activity
            .list(1000)
            .filter((e) => !seen.has(e.id))
            .map((e) => e.type)
            .sort(),
        };
      });
    for (const [older, newer] of [
      [LONDON, MOVED],
      [LONDON, "I live in Paris"],
    ] as const) {
      expect(await outcome(older, newer, true)).toEqual(await outcome(older, newer, false));
    }
  });

  it("correct() takes { source, signal }", async () => {
    await freshAgent()(async (agent) => {
      const s = aiOn(agent);
      s.memoryHistory.hooks.neighbors = async () => [];
      const { memory: locker } = await s.memoryHistory.create({ content: "My locker is number 12" });
      const manual = await s.memoryHistory.correct(locker.id, "My locker is number 14");
      expect(manual.memory.source).toBe("manual");
      const byAgent = await s.memoryHistory.correct(manual.memory.id, "My locker is number 16", undefined, { source: "agent" });
      expect(byAgent.memory.source).toBe("agent");

      // A cancelled correction stops waiting for Clef and falls back to the rules, like create():
      // the rule replacement of London becomes a review.
      const { memory: london } = await s.memoryHistory.create({ content: LONDON });
      const { memory: desk } = await s.memoryHistory.create({ content: "My desk is by the window" });
      s.memoryHistory.hooks.clef = () => () => new Promise(() => {});
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50);
      const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1000));
      const result = await Promise.race([s.memoryHistory.correct(desk.id, MOVED, undefined, { signal: controller.signal }), timeout]);
      expect(result).not.toBe("timeout");
      expect(s.memories.get(london.id)?.status).toBe("active");
      expect((result as Exclude<typeof result, "timeout">).reviews.map((v) => [v.other_id, v.relationship])).toContainEqual([london.id, "possible_update"]);
    });
  });
});

describe("PR #22 hardening", () => {
  const LONDON = "I live in London";
  const MOVED = "I moved to Paris";
  const OLDER = "Alpha kayaks on weekends";
  const NEWER = "Beta gardens every evening";

  function aiOn(agent: TalorysAgent) {
    agent.services.settings.update({ memoryHistory: { aiConflictCheck: true } });
    return agent.services;
  }

  /** Saves OLDER then NEWER, with OLDER offered to Clef only as a close semantic neighbor. */
  const semanticOnly = (clef: TalorysAgent["services"]["memoryHistory"]["hooks"]["clef"]) =>
    freshAgent()(async (agent) => {
      const s = aiOn(agent);
      s.memoryHistory.hooks.neighbors = async () => [];
      const { memory: older } = await s.memoryHistory.create({ content: OLDER });
      s.memoryHistory.hooks.neighbors = async () => [{ id: older.id, cosine: 0.9 }];
      s.memoryHistory.hooks.clef = clef;
      const r = await s.memoryHistory.create({ content: NEWER });
      return { older, reviews: r.reviews };
    });

  it("H1 a save with no signal stops waiting for a stalled Clef and counts an AI error", async () => {
    await freshAgent()(async (agent) => {
      const s = aiOn(agent);
      s.memoryHistory.hooks.clefTimeoutMs = 50;
      s.memoryHistory.hooks.neighbors = async () => [];
      const { memory: london } = await s.memoryHistory.create({ content: LONDON });
      s.memoryHistory.hooks.clef = () => () => new Promise(() => {});
      const errors = s.usage.today().ai_errors;
      const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1000));
      const result = await Promise.race([s.memoryHistory.create({ content: MOVED }), timeout]);
      expect(result).not.toBe("timeout");
      expect(s.memories.get(london.id)?.status).toBe("active");
      expect((result as Exclude<typeof result, "timeout">).reviews.map((v) => [v.other_id, v.relationship])).toContainEqual([london.id, "possible_update"]);
      expect(s.usage.today().ai_errors).toBe(errors + 1);
    });
  });

  it("H1 a save cancelled before the Clef timeout is not counted as an AI error", async () => {
    await freshAgent()(async (agent) => {
      const s = aiOn(agent);
      s.memoryHistory.hooks.clefTimeoutMs = 1000;
      s.memoryHistory.hooks.neighbors = async () => [];
      const { memory: london } = await s.memoryHistory.create({ content: LONDON });
      s.memoryHistory.hooks.clef = () => () => new Promise(() => {});
      const errors = s.usage.today().ai_errors;
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 20);
      const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1500));
      const result = await Promise.race([s.memoryHistory.create({ content: MOVED }, { signal: controller.signal }), timeout]);
      expect(result).not.toBe("timeout");
      expect(s.memories.get(london.id)?.status).toBe("active");
      expect((result as Exclude<typeof result, "timeout">).reviews.map((v) => [v.other_id, v.relationship])).toContainEqual([london.id, "possible_update"]);
      expect(s.usage.today().ai_errors).toBe(errors);
    });
  });

  it("H3 a weak contradiction from a semantic neighbor alone makes no review", async () => {
    expect((await semanticOnly(() => null)).reviews).toHaveLength(0);
    expect((await semanticOnly(() => async () => clefReply(["contradicts", 0.55]))).reviews).toHaveLength(0);
  });

  it("H3 a strong contradiction from a semantic neighbor alone makes one review", async () => {
    expect((await semanticOnly(() => null)).reviews).toHaveLength(0);
    const { older, reviews } = await semanticOnly(() => async () => clefReply(["contradicts", 0.9]));
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ other_id: older.id, relationship: "contradiction" });
  });

  it("H3 a weak contradiction on a rule-nominated memory still makes a review", async () => {
    await freshAgent()(async (agent) => {
      const s = aiOn(agent);
      s.memoryHistory.hooks.neighbors = async () => [];
      const { memory: london } = await s.memoryHistory.create({ content: LONDON });
      s.memoryHistory.hooks.clef = () => async () => clefReply(["contradicts", 0.55]);
      const r = await s.memoryHistory.create({ content: MOVED });
      expect(r.reviews.some((v) => v.other_id === london.id)).toBe(true);
    });
  });
});
