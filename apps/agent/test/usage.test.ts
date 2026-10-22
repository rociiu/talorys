import { beforeEach, describe, expect, it } from "vitest";
import type { Usage } from "../src/ai/provider";
import { migrate } from "../src/db/migrations";
import { ensureSemanticSchema } from "../src/semantic/migrations";
import { WorkersAiEmbedder, recordEmbeddingCall } from "../src/semantic/embeddings";
import { inAgent, loggedIn } from "./helpers";
import { UsageService } from "../src/services/usage";

const qwen = "@cf/qwen/qwen3-30b-a3b-fp8";
const usage = (model = qwen): Usage => ({
  model, billable: true, cachedInputTokens: 0,
  inputTokens: { reported: 1000, estimated: 0 },
  outputTokens: { reported: 0, estimated: 100 },
});

beforeEach(async () => {
  await inAgent((a) => {
    a.services.db.run("DELETE FROM tal_usage_daily");
    a.services.db.run("DELETE FROM tal_model_usage_daily");
  });
});

describe("local model consumption", () => {
  it("keeps provenance distinct and sums call-time prices across model changes", async () => {
    await inAgent((a) => {
      const { usage: ledger, settings } = a.services;
      ledger.record(usage());
      const first = ledger.today();
      expect(first).toMatchObject({ input_tokens_reported: 1000, output_tokens_estimated: 100,
        input_tokens_estimated: 0, output_tokens_reported: 0, priced_calls: 1 });
      expect(first.neurons_estimate).toBeCloseTo(7.6725, 8);
      expect(first.cost_usd_estimate).toBeCloseTo(0.0000843975, 12);
      const original = settings.get().model;
      try {
        settings.update({ model: "@cf/openai/gpt-oss-20b" });
        expect(ledger.today().neurons_estimate).toBe(first.neurons_estimate);
        ledger.record(usage(settings.get().model));
        expect(ledger.today().neurons_estimate).toBeCloseTo(7.6725 + 20.9093, 8);
      } finally {
        settings.update({ model: original });
      }
    });
  });

  it("prices cache reads at their model rate, without discounting unreported cache usage", async () => {
    await inAgent((a) => {
      const metered = usage("@cf/moonshotai/kimi-k2.5");
      metered.cachedInputTokens = 800;
      a.services.usage.record(metered);
      expect(a.services.usage.today().neurons_estimate).toBeCloseTo(45.4545, 8);
      metered.cachedInputTokens = 0;
      a.services.usage.record(metered);
      expect(a.services.usage.today().neurons_estimate).toBeCloseTo(45.4545 + 81.8177, 8);
    });
  });

  it("does not turn unknown-model or mock calls into priced zero usage", async () => {
    await inAgent((a) => {
      const ledger = a.services.usage;
      ledger.record(usage("@cf/unknown/model"));
      expect(ledger.today()).toMatchObject({ unpriced_calls: 1, priced_calls: 0, neurons_estimate: null, cost_usd_estimate: null });
      const mock = usage("mock");
      mock.billable = false;
      mock.inputTokens = { reported: 0, estimated: 1000 };
      ledger.record(mock);
      expect(ledger.today()).toMatchObject({ mock_calls: 1, unpriced_calls: 1, neurons_estimate: null });
      ledger.record(usage());
      expect(ledger.today()).toMatchObject({ priced_calls: 1, unpriced_calls: 1, mock_calls: 1 });
      expect(ledger.today().neurons_estimate).toBeCloseTo(7.6725, 8);
    });
  });

  it("distinguishes priced zero from no data and keeps UTC date ranges bounded", async () => {
    await inAgent((a) => {
      const ledger = a.services.usage;
      expect(ledger.today().neurons_estimate).toBeNull();
      const zero = usage();
      zero.inputTokens.reported = 0;
      zero.outputTokens.estimated = 0;
      ledger.record(zero);
      expect(ledger.today()).toMatchObject({ neurons_estimate: 0, cost_usd_estimate: 0, priced_calls: 1 });
      const sixDaysAgo = new Date();
      sixDaysAgo.setUTCDate(sixDaysAgo.getUTCDate() - 6);
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 7);
      ledger.record(usage(), UsageService.day(sixDaysAgo));
      ledger.record(usage("@cf/openai/gpt-oss-20b"), UsageService.day(sevenDaysAgo));
      expect(ledger.today().input_tokens_reported).toBe(0);
      expect(ledger.lastDays(7).input_tokens_reported).toBe(1000);
      expect(ledger.lastDays(7).neurons_estimate).toBeCloseTo(7.6725, 8);
    });
  });

  it("requires capacity in both daily budgets before a scheduled model run", async () => {
    await inAgent((a) => {
      const limits = { ...a.services.settings.get().limits, maxAiRequestsPerDay: 2, maxScheduledAiRunsPerDay: 3 };
      expect(a.services.usage.canRunScheduledAi(limits)).toBe(true);
      a.services.usage.increment({ ai_requests: 1, scheduled_ai_runs: 2 });
      expect(a.services.usage.canRunScheduledAi(limits)).toBe(true);
      a.services.usage.increment({ scheduled_ai_runs: 1 });
      expect(a.services.usage.canRunScheduledAi(limits)).toBe(false);
      a.services.db.run("DELETE FROM tal_usage_daily");
      a.services.usage.increment({ ai_requests: 2 });
      expect(a.services.usage.canRunScheduledAi(limits)).toBe(false);
    });
  });

  it("preserves mixed legacy chat and known-estimated legacy embedding history on migration", async () => {
    await inAgent((a) => {
      const { db, usage: ledger } = a.services;
      const day = new Date().toISOString().slice(0, 10);
      ensureSemanticSchema(db);
      db.run("DELETE FROM tal_semantic_usage");
      db.run("INSERT INTO tal_semantic_usage (day, embedding_requests, embedded_tokens_estimate) VALUES (?, 2, 50)", day);
      db.run("INSERT INTO tal_usage_daily (day, ai_requests, input_tokens, output_tokens) VALUES (?, 3, 120, 20)", day);
      db.run("DROP TABLE tal_model_usage_daily");
      // Roll back past migrations 7-11: drop tables those versions create so migrate can recreate them.
      db.run("DROP TABLE IF EXISTS tal_remote_auth_failures");
      db.run("DROP TABLE IF EXISTS tal_remote_tokens");
      db.run("DROP TABLE IF EXISTS tal_remote_auth_failure_days");
      db.run("DROP TABLE IF EXISTS tal_remote_write_days");
      db.run("DROP TABLE IF EXISTS tal_task_plan_drafts");
      db.run("UPDATE tal_schema SET version = 6 WHERE id = 1");
      migrate(db);
      migrate(db);
      // Old embedding estimates are legacy (unknown model and provenance), not current estimates or unpriced calls.
      expect(ledger.today()).toMatchObject({ ai_requests: 3, input_tokens_legacy: 170, output_tokens_legacy: 20,
        input_tokens_reported: 0, input_tokens_estimated: 0, embedding_requests: 2,
        unpriced_calls: 0, neurons_estimate: null });
      expect(db.one<{ input_tokens: number }>("SELECT input_tokens FROM tal_usage_daily WHERE day = ?", day)?.input_tokens).toBe(120);
      expect(db.one<{ embedding_requests: number }>("SELECT embedding_requests FROM tal_semantic_usage WHERE day = ?", day)?.embedding_requests).toBe(2);
    });
  });

  it("meters embedding response counts separately from the chat request budget", async () => {
    await inAgent(async (a) => {
      ensureSemanticSchema(a.services.db);
      const model = "@cf/baai/bge-m3";
      const ai = { run: async () => ({ data: [Array(1024).fill(0.1)], usage: { prompt_tokens: 200 } }) } as unknown as Ai;
      const embedder = new WorkersAiEmbedder(ai, model);
      let measured: Usage | undefined;
      await embedder.embed(["one memory"], (reported) => { measured = reported; });
      recordEmbeddingCall(a.services.db, new Date().toISOString().slice(0, 10), embedder, ["one memory"], measured);
      expect(a.services.usage.today()).toMatchObject({ ai_requests: 0, embedding_requests: 1,
        input_tokens_reported: 200, input_tokens_estimated: 0, priced_calls: 1 });
      expect(a.services.usage.today().neurons_estimate).toBeCloseTo(0.215, 8);
    });
  });

  it("falls back for missing embedding counts without misclassifying a reported zero", async () => {
    await inAgent(async (a) => {
      ensureSemanticSchema(a.services.db);
      const model = "@cf/baai/bge-m3";
      const day = new Date().toISOString().slice(0, 10);
      const texts = ["abcdefgh"];
      for (const metadata of [{ prompt_tokens: 0 }, undefined]) {
        const ai = { run: async () => ({ data: [Array(1024).fill(0.1)], usage: metadata }) } as unknown as Ai;
        const embedder = new WorkersAiEmbedder(ai, model);
        let measured: Usage | undefined;
        await embedder.embed(texts, (reported) => { measured = reported; });
        recordEmbeddingCall(a.services.db, day, embedder, texts, measured);
        if (metadata) expect(a.services.usage.today()).toMatchObject({
          input_tokens_reported: 0, input_tokens_estimated: 0, neurons_estimate: 0, priced_calls: 1,
        });
      }
      expect(a.services.usage.today()).toMatchObject({ input_tokens_reported: 0, input_tokens_estimated: 2,
        embedding_requests: 2, priced_calls: 2 });
      expect(a.services.usage.today().neurons_estimate).toBeCloseTo(0.00215, 10);
    });
  });

  it("exposes both provenance and priced coverage through the authenticated usage API", async () => {
    const c = await loggedIn();
    await inAgent((a) => {
      a.services.usage.record(usage());
      a.services.usage.record(usage("@cf/unknown/model"));
    });
    const report = await c.json("/api/usage");
    expect(report.today).toMatchObject({ input_tokens_reported: 2000, output_tokens_estimated: 200,
      priced_calls: 1, unpriced_calls: 1 });
    expect(report.today.neurons_estimate).toBeCloseTo(7.6725, 8);
    expect(report.last_7_days.input_tokens_reported).toBe(2000);
  });
});
