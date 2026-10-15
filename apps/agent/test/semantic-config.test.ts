import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { inAgent, loggedIn } from "./helpers";
import { invalidateSemanticCache, semanticExtensions } from "../src/semantic";
import {
  DEFAULT_SEMANTIC_CONFIG,
  LEGACY_DEFAULT_MODEL,
  MODEL_FLOOR_DEFAULTS,
  floorDefaultsFor,
  SEMANTIC_CONFIG_KEY,
  deleteSemanticConfig,
  readSemanticConfig,
  writeSemanticConfig,
} from "../src/semantic/config";
import { dropSemanticData, semanticTableNames } from "../src/semantic/migrations";
import { ValidationError } from "../src/api/errors";
import type { Services } from "../src/services/container";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { ALL_TOOLS } from "../src/tools";
import { AgentRunner } from "../src/agent/runner";
import type { AgentEvent, AIProvider, GenerateRequest, ToolRequest } from "../src/ai/provider";
import { NEWER_WINS_NOTE } from "../src/semantic/recall";
import type { Env } from "../src/env";

function reset(s: Services) {
  dropSemanticData(s.db);
  deleteSemanticConfig(s.settings);
  invalidateSemanticCache(s);
}

/** Stores a raw (possibly corrupt) value under the config key. */
function storeRaw(s: Services, value: string) {
  s.db.run(
    `INSERT INTO tal_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    SEMANTIC_CONFIG_KEY,
    value,
    new Date().toISOString(),
  );
}

const storedKeys = (s: Services) => Object.keys(s.settings.getJson<Record<string, unknown>>(SEMANTIC_CONFIG_KEY) ?? {}).sort();

describe("semantic config", () => {
  it("absent key reads as null", async () => {
    await inAgent((agent) => {
      const s = agent.services;
      reset(s);
      expect(readSemanticConfig(s.settings, s.db)).toBeNull();
      expect(readSemanticConfig(s.settings)).toBeNull();
    });
  });

  it("ignores unknown fields in the stored value", async () => {
    await inAgent((agent) => {
      const s = agent.services;
      reset(s);
      s.settings.setJson(SEMANTIC_CONFIG_KEY, {
        enabled: true,
        model: "@cf/baai/bge-small-en-v1.5",
        maxEmbeddingsPerDay: 300,
        vectorFloor: { absolute: 0.6, relative: 0.2 },
        pastWeight: 0.5,
        maxPastInContext: 3,
      });
      expect(readSemanticConfig(s.settings, s.db)).toEqual({
        enabled: true,
        model: "@cf/baai/bge-small-en-v1.5",
        maxEmbeddingsPerDay: 300,
        maxItemEmbeddingsPerDay: 50,
        vectorFloor: { absolute: 0.6, relative: 0.2, backstop: 0.35 },
      });
    });
  });

  it("defaults to bge-m3 and reads an untouched legacy bge-small default as the new defaults", async () => {
    expect(DEFAULT_SEMANTIC_CONFIG.model).toBe("@cf/baai/bge-m3");
    expect(DEFAULT_SEMANTIC_CONFIG.vectorFloor).toEqual({ absolute: 0.55, relative: 0.1, backstop: 0.4 });
    await inAgent((agent) => {
      const s = agent.services;
      reset(s);
      const legacy = { enabled: true, model: LEGACY_DEFAULT_MODEL, maxEmbeddingsPerDay: 300, vectorFloor: { absolute: 0.5, relative: 0.1 } };
      s.settings.setJson(SEMANTIC_CONFIG_KEY, legacy);
      expect(readSemanticConfig(s.settings, s.db)).toEqual({ ...DEFAULT_SEMANTIC_CONFIG, enabled: true, maxEmbeddingsPerDay: 300 });
      expect(s.settings.getJson(SEMANTIC_CONFIG_KEY)).toEqual(legacy);

      s.settings.setJson(SEMANTIC_CONFIG_KEY, { enabled: true, model: LEGACY_DEFAULT_MODEL });
      expect(readSemanticConfig(s.settings, s.db)).toEqual({ ...DEFAULT_SEMANTIC_CONFIG, enabled: true });

      const tuned = { ...legacy, vectorFloor: { absolute: 0.6, relative: 0.1 } };
      s.settings.setJson(SEMANTIC_CONFIG_KEY, tuned);
      expect(readSemanticConfig(s.settings, s.db)).toEqual({ ...tuned, maxItemEmbeddingsPerDay: 50, vectorFloor: { ...tuned.vectorFloor, backstop: 0.35 } });
      reset(s);
    });
  });

  it("fills missing fields from the defaults", async () => {
    await inAgent((agent) => {
      const s = agent.services;
      reset(s);
      s.settings.setJson(SEMANTIC_CONFIG_KEY, { enabled: true, vectorFloor: { absolute: 0.7 } });
      expect(readSemanticConfig(s.settings, s.db)).toEqual({
        ...DEFAULT_SEMANTIC_CONFIG,
        enabled: true,
        vectorFloor: { ...DEFAULT_SEMANTIC_CONFIG.vectorFloor, absolute: 0.7 },
      });
    });
  });

  it("vectorFloor.backstop defaults to 0.4, reads tolerantly, patches, and never exceeds absolute", async () => {
    await inAgent((agent) => {
      const s = agent.services;
      reset(s);
      expect(DEFAULT_SEMANTIC_CONFIG.vectorFloor.backstop).toBe(0.4);

      s.settings.setJson(SEMANTIC_CONFIG_KEY, { enabled: true, model: "@cf/baai/bge-m3", vectorFloor: { absolute: 0.6, relative: 0.1 } });
      expect(readSemanticConfig(s.settings, s.db)!.vectorFloor).toEqual({ absolute: 0.6, relative: 0.1, backstop: 0.4 });

      const legacy = { enabled: true, model: LEGACY_DEFAULT_MODEL, maxEmbeddingsPerDay: 300, vectorFloor: { absolute: 0.5, relative: 0.1 } };
      s.settings.setJson(SEMANTIC_CONFIG_KEY, legacy);
      expect(readSemanticConfig(s.settings, s.db)!.vectorFloor).toEqual(DEFAULT_SEMANTIC_CONFIG.vectorFloor);

      // A pre-backstop store with an absolute floor under 0.4 lowers the backstop to it.
      s.settings.setJson(SEMANTIC_CONFIG_KEY, { enabled: true, vectorFloor: { absolute: 0.3, relative: 0.1 } });
      expect(readSemanticConfig(s.settings, s.db)!.vectorFloor).toEqual({ absolute: 0.3, relative: 0.1, backstop: 0.3 });

      reset(s);
      const next = writeSemanticConfig(s.settings, { vectorFloor: { backstop: 0.35 } }, s.db);
      expect(next.vectorFloor).toEqual({ ...DEFAULT_SEMANTIC_CONFIG.vectorFloor, backstop: 0.35 });
      expect(readSemanticConfig(s.settings, s.db)!.vectorFloor.backstop).toBe(0.35);

      expect(() => writeSemanticConfig(s.settings, { vectorFloor: { backstop: 0.6 } }, s.db)).toThrow(ValidationError);
      expect(() => writeSemanticConfig(s.settings, { vectorFloor: { absolute: 0.3 } }, s.db)).toThrow(ValidationError);
      expect(readSemanticConfig(s.settings, s.db)!.vectorFloor.backstop).toBe(0.35);
      reset(s);
    });
  });

  it("model floor defaults follow the model unless the floors are custom", async () => {
    const small = "@cf/baai/bge-small-en-v1.5";
    expect(floorDefaultsFor("@cf/baai/bge-m3")).toEqual({ absolute: 0.55, relative: 0.1, backstop: 0.4 });
    for (const m of [small, "@cf/baai/bge-base-en-v1.5", "@cf/baai/bge-large-en-v1.5"]) {
      expect(floorDefaultsFor(m)).toEqual({ absolute: 0.5, relative: 0.1, backstop: 0.35 });
    }
    expect(floorDefaultsFor("@cf/qwen/qwen3-embedding-0.6b")).toEqual(MODEL_FLOOR_DEFAULTS["@cf/baai/bge-m3"]);
    floorDefaultsFor(small).absolute = 0.9;
    expect(floorDefaultsFor(small).absolute).toBe(0.5);

    await inAgent((agent) => {
      const s = agent.services;
      reset(s);
      writeSemanticConfig(s.settings, { enabled: true }, s.db);
      expect(writeSemanticConfig(s.settings, { model: small }, s.db).vectorFloor).toEqual({ absolute: 0.5, relative: 0.1, backstop: 0.35 });
      expect(readSemanticConfig(s.settings, s.db)!.vectorFloor).toEqual({ absolute: 0.5, relative: 0.1, backstop: 0.35 });
      expect(writeSemanticConfig(s.settings, { model: small }, s.db).vectorFloor).toEqual(floorDefaultsFor(small));
      expect(writeSemanticConfig(s.settings, { model: "@cf/baai/bge-m3" }, s.db).vectorFloor).toEqual(DEFAULT_SEMANTIC_CONFIG.vectorFloor);

      writeSemanticConfig(s.settings, { vectorFloor: { absolute: 0.6 } }, s.db);
      expect(writeSemanticConfig(s.settings, { model: small }, s.db).vectorFloor).toEqual({ absolute: 0.6, relative: 0.1, backstop: 0.4 });
      expect(writeSemanticConfig(s.settings, { model: "@cf/baai/bge-m3", vectorFloor: { absolute: 0.7 } }, s.db).vectorFloor.absolute).toBe(0.7);

      s.settings.setJson(SEMANTIC_CONFIG_KEY, { enabled: true, model: small, vectorFloor: { absolute: 0.6, relative: 0.1 } });
      expect(readSemanticConfig(s.settings, s.db)!.vectorFloor).toEqual({ absolute: 0.6, relative: 0.1, backstop: 0.35 });
      reset(s);
    });
  });

  it("an invalid stored model reads as the default model, keeping the other fields", async () => {
    await inAgent((agent) => {
      const s = agent.services;
      reset(s);
      s.settings.setJson(SEMANTIC_CONFIG_KEY, { enabled: true, model: "bge-small", maxEmbeddingsPerDay: 300 });
      expect(readSemanticConfig(s.settings, s.db)).toEqual({ ...DEFAULT_SEMANTIC_CONFIG, enabled: true, maxEmbeddingsPerDay: 300 });
      reset(s);
    });
  });

  it("invalid values read as the defaults, keeping a boolean enabled", async () => {
    await inAgent((agent) => {
      const s = agent.services;
      reset(s);
      s.settings.setJson(SEMANTIC_CONFIG_KEY, { enabled: true, maxEmbeddingsPerDay: -5, vectorFloor: { absolute: 7 } });
      expect(readSemanticConfig(s.settings, s.db)).toEqual({ ...DEFAULT_SEMANTIC_CONFIG, enabled: true });

      s.settings.setJson(SEMANTIC_CONFIG_KEY, { enabled: "yes", model: "" });
      expect(readSemanticConfig(s.settings, s.db)).toEqual({ ...DEFAULT_SEMANTIC_CONFIG, enabled: false });

      s.settings.setJson(SEMANTIC_CONFIG_KEY, [1, 2]);
      expect(readSemanticConfig(s.settings, s.db)).toEqual({ ...DEFAULT_SEMANTIC_CONFIG, enabled: false });

      s.settings.setJson(SEMANTIC_CONFIG_KEY, { enabled: true, vectorFloor: "high" });
      expect(readSemanticConfig(s.settings, s.db)).toEqual({ ...DEFAULT_SEMANTIC_CONFIG, enabled: true });
    });
  });

  it("corrupt JSON is present, not absent", async () => {
    await inAgent((agent) => {
      const s = agent.services;
      reset(s);
      storeRaw(s, "{not json");
      expect(readSemanticConfig(s.settings, s.db)).toEqual({ ...DEFAULT_SEMANTIC_CONFIG, enabled: false });
      reset(s);
    });
  });

  it("writeSemanticConfig rejects invalid values and stores only the config fields", async () => {
    await inAgent((agent) => {
      const s = agent.services;
      reset(s);
      expect(() => writeSemanticConfig(s.settings, { maxEmbeddingsPerDay: -1 })).toThrow();
      expect(s.settings.getJson(SEMANTIC_CONFIG_KEY)).toBeNull();
      s.settings.setJson(SEMANTIC_CONFIG_KEY, { enabled: false, pastWeight: 0.5, maxPastInContext: 3 });
      const next = writeSemanticConfig(s.settings, { vectorFloor: { relative: 0.3 } }, s.db);
      expect(next).toEqual({
        ...DEFAULT_SEMANTIC_CONFIG,
        vectorFloor: { ...DEFAULT_SEMANTIC_CONFIG.vectorFloor, relative: 0.3 },
      });
      expect(storedKeys(s)).toEqual(["enabled", "maxEmbeddingsPerDay", "maxItemEmbeddingsPerDay", "model", "vectorFloor"]);
      reset(s);
    });
  });

  it("PUT /api/semantic/config writes only the config fields", async () => {
    await inAgent((agent) => reset(agent.services));
    const c = await loggedIn();
    expect(await c.json("/api/semantic/config")).toEqual({ config: null, ever_enabled: false });

    const res = await c.call("/api/semantic/config", {
      method: "PUT",
      body: { maxEmbeddingsPerDay: 200, pastWeight: 0, maxPastInContext: 1, extra: "x" },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { config: unknown }).config).toEqual({ ...DEFAULT_SEMANTIC_CONFIG, maxEmbeddingsPerDay: 200 });
    await inAgent((agent) => {
      const s = agent.services;
      expect(storedKeys(s)).toEqual(["enabled", "maxEmbeddingsPerDay", "maxItemEmbeddingsPerDay", "model", "vectorFloor"]);
      expect(s.settings.getJson(SEMANTIC_CONFIG_KEY)).toEqual({ ...DEFAULT_SEMANTIC_CONFIG, maxEmbeddingsPerDay: 200 });
    });
    expect(await c.json("/api/semantic/config")).toEqual({
      config: { ...DEFAULT_SEMANTIC_CONFIG, maxEmbeddingsPerDay: 200 },
      ever_enabled: true,
    });

    const bads = [{ enabled: "yes" }, { vectorFloor: { absolute: 2 } }, { vectorFloor: { backstop: 0.9 } }, { model: "" }, { model: "bge-small" }, { maxEmbeddingsPerDay: 1.5 }];
    for (const bad of bads) {
      const r = await c.call("/api/semantic/config", { method: "PUT", body: bad });
      expect(r.status).toBe(400);
    }
    const small = await c.json("/api/semantic/config", { method: "PUT", body: { model: " @cf/baai/bge-small-en-v1.5 " } });
    expect(small.config).toMatchObject({ model: "@cf/baai/bge-small-en-v1.5", vectorFloor: { absolute: 0.5, relative: 0.1, backstop: 0.35 } });
    await inAgent((agent) => reset(agent.services));
  });
});

/** A provider that records each request and replies with fixed text. */
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
    yield { type: "text", delta: "Hello." };
    yield { type: "usage", usage: { model: this.model, billable: this.billable, inputTokens: { reported: 10, estimated: 0 }, outputTokens: { reported: 5, estimated: 0 }, cachedInputTokens: 0 } };
  }
}

const workerEnv = env as unknown as Env;

const toolShape = (req: ToolRequest) => req.tools.map((t) => ({ name: t.name, schema: z.toJSONSchema(t.inputSchema) }));

function resetSemantic(s: Services) {
  dropSemanticData(s.db);
  deleteSemanticConfig(s.settings);
  invalidateSemanticCache(s);
}

async function chatOnce(runner: AgentRunner, message: string) {
  for await (const _ of runner.chat({ message, signal: new AbortController().signal })) {
    // drain
  }
}

/** Runs the same chat turn and scheduled prompt through an upstream runner and a hooked one. */
async function compareRunners(s: Services, ext: ReturnType<typeof semanticExtensions>) {
  const upstream = new RecordingProvider();
  const hooked = new RecordingProvider();
  await chatOnce(new AgentRunner(s, upstream), "what tea do I like");
  await chatOnce(new AgentRunner(s, hooked, ext), "what tea do I like");
  await new AgentRunner(s, upstream).runScheduledPrompt("summarise my tea habits");
  await new AgentRunner(s, hooked, ext).runScheduledPrompt("summarise my tea habits");
  expect(hooked.calls).toHaveLength(2);
  for (const i of [0, 1]) {
    expect(hooked.calls[i]!.system).toBe(upstream.calls[i]!.system);
    expect(toolShape(hooked.calls[i]!)).toEqual(toolShape(upstream.calls[i]!));
  }
  expect(toolShape(hooked.calls[0]!).map((t) => t.name)).toEqual(ALL_TOOLS.map((t) => t.name));
  expect(upstream.calls[0]!.system).toContain("Prefers green tea in the morning");
}

async function memoriesEqualUpstream() {
  const counts = (m: Services["memories"]) => ({ active: m.count("active"), historical: m.count("historical"), review: m.count("review") });
  const expected = await inAgent((agent) => ({ memories: agent.services.memories.list({}), total: agent.services.memories.count(), counts: counts(agent.services.memories) }));
  const c = await loggedIn();
  expect(await c.json("/api/memories")).toEqual(expected);
  const q = await inAgent((agent) => ({
    memories: agent.services.memories.list({ q: "tea" }),
    total: agent.services.memories.count(),
    counts: counts(agent.services.memories),
  }));
  expect(await c.json("/api/memories?q=tea")).toEqual(q);
}


describe("semantic recall off", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-04T10:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("off equals upstream for prompts, tools and /api/memories", async () => {
    await inAgent(async (agent) => {
      const s = agent.services;
      resetSemantic(s);
      s.memories.create({ content: "Prefers green tea in the morning", category: "preference" });
      const ext = semanticExtensions(s, workerEnv);
      expect(ext).toBeUndefined();
      await compareRunners(s, ext);
      expect(semanticTableNames(s.db)).toEqual([]);
    });
    await memoriesEqualUpstream();
    await inAgent((agent) => expect(semanticTableNames(agent.services.db)).toEqual([]));
  });

  it("explicitly disabled is off", async () => {
    await inAgent((agent) => {
      const s = agent.services;
      resetSemantic(s);
      writeSemanticConfig(s.settings, { enabled: false }, s.db);
      invalidateSemanticCache(s);
      expect(semanticExtensions(s, workerEnv)).toBeUndefined();
    });
  });

  it("enabled keeps upstream tool shapes and only dates the memory lines", async () => {
    await inAgent(async (agent) => {
      const s = agent.services;
      resetSemantic(s);
      s.memories.clear();
      s.memories.create({ content: "Prefers green tea in the morning", category: "preference" });
      writeSemanticConfig(s.settings, { enabled: true }, s.db);
      invalidateSemanticCache(s);
      const ext = semanticExtensions(s, workerEnv);
      expect(ext).toBeDefined();
      expect(ext!.tools).not.toBe(ALL_TOOLS);

      const upstream = new RecordingProvider();
      const hooked = new RecordingProvider();
      await chatOnce(new AgentRunner(s, upstream), "what tea do I like");
      await chatOnce(new AgentRunner(s, hooked, ext), "what tea do I like");
      await new AgentRunner(s, upstream).runScheduledPrompt("summarise my tea habits");
      await new AgentRunner(s, hooked, ext).runScheduledPrompt("summarise my tea habits");
      expect(hooked.calls).toHaveLength(2);
      for (const i of [0, 1]) {
        expect(toolShape(hooked.calls[i]!)).toEqual(toolShape(upstream.calls[i]!));
        expect(hooked.calls[i]!.system).toBe(
          upstream.calls[i]!.system.replace("Prefers green tea", "(saved 2026-03-04 10:00 UTC) Prefers green tea"),
        );
      }
      expect(upstream.calls[0]!.system).toContain("- [preference] Prefers green tea in the morning");
    });
    await memoriesEqualUpstream();
    await inAgent((agent) => resetSemantic(agent.services));
  });

  it("adds the newer-wins note after two or more memories only when enabled", async () => {
    await inAgent(async (agent) => {
      const s = agent.services;
      resetSemantic(s);
      s.memories.clear();
      s.memories.create({ content: "Prefers green tea in the morning", category: "preference" });
      s.memories.create({ content: "Prefers oolong tea after lunch", category: "preference" });
      const off = semanticExtensions(s, workerEnv);
      expect(off).toBeUndefined();
      const upstream = new RecordingProvider();
      const unhooked = new RecordingProvider();
      await chatOnce(new AgentRunner(s, upstream), "what tea do I like");
      await chatOnce(new AgentRunner(s, unhooked, off), "what tea do I like");
      expect(unhooked.calls[0]!.system).toBe(upstream.calls[0]!.system);
      expect(upstream.calls[0]!.system).not.toContain(NEWER_WINS_NOTE);

      writeSemanticConfig(s.settings, { enabled: true }, s.db);
      invalidateSemanticCache(s);
      const hooked = new RecordingProvider();
      await chatOnce(new AgentRunner(s, hooked, semanticExtensions(s, workerEnv)), "what tea do I like");
      const lines = hooked.calls[0]!.system.split("\n").filter((l) => l.startsWith("- ["));
      expect(lines).toHaveLength(3);
      expect(lines.at(-1)).toBe(`- [other] ${NEWER_WINS_NOTE}`);
    });
    await inAgent((agent) => resetSemantic(agent.services));
  });

  it("falls back to undefined when the extensions throw", async () => {
    await inAgent((agent) => {
      const s = agent.services;
      resetSemantic(s);
      const spy = vi.spyOn(s.settings, "getJson").mockImplementation(() => {
        throw new Error("boom");
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(semanticExtensions(s, workerEnv)).toBeUndefined();
      } finally {
        spy.mockRestore();
        warn.mockRestore();
        invalidateSemanticCache(s);
      }
    });
  });
});
