import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { inAgent, loggedIn } from "./helpers";
import { FixtureEmbedder, fixtureConfig } from "./fixture-embedder";
import { invalidateSemanticCache, semanticExtensions } from "../src/semantic";
import { deleteSemanticConfig, writeSemanticConfig } from "../src/semantic/config";
import { dropSemanticData, tableExists } from "../src/semantic/migrations";
import type { SemanticContext } from "../src/semantic/recall";
import { runItemPass } from "../src/semantic/itemIndex";
import { SEARCH_DESCRIPTION, SEARCH_MEMORIES_DESCRIPTION, SEARCH_NOTES_DESCRIPTION, semanticTools } from "../src/semantic/tools";
import { ALL_TOOLS, type ToolContext, type ToolDefinition } from "../src/tools";
import type { ImmediateTool } from "../src/tools/registry";
import type { Services } from "../src/services/container";
import type { Env } from "../src/env";

const workerEnv = env as unknown as Env;
const ITEM_TABLE = "tal_semantic_item_vectors";

/** Clears items and semantic state, as if the feature had never been enabled. */
function reset(s: Services) {
  dropSemanticData(s.db);
  deleteSemanticConfig(s.settings);
  invalidateSemanticCache(s);
  for (const table of ["tal_tasks", "tal_notes", "tal_automations"]) s.db.run(`DELETE FROM ${table}`);
}

/** The surface fixture: tasks, notes and reminders that keyword and meaning searches both reach. */
async function seed(s: Services) {
  s.tasks.create({ title: "Water the plants" });
  s.tasks.create({ title: "Pay rent" });
  s.tasks.create({ title: "Book a physical", status: "done" });
  s.notes.create({ title: "Lisbon itinerary", content: "Day 1: Alfama walk, Day 2: Belem and Sintra" });
  s.notes.create({ title: "Lake house", content: "Wifi Loon5G, password maple-4417" });
  for (const name of ["Take Lipitor", "Pay rent"]) {
    s.automationsRepo.create({ name, kind: "reminder", message: name, schedule: { type: "daily", time: "08:00" }, enabled: true });
  }
  // Rows created in the same millisecond tie on the routes' timestamp ordering; space them a second apart.
  for (const table of ["tal_tasks", "tal_notes", "tal_automations"]) {
    const stamp = `strftime('%Y-%m-%dT%H:%M:%fZ', '2026-10-01', rowid || ' seconds')`;
    s.db.run(`UPDATE ${table} SET created_at = ${stamp}, updated_at = ${stamp}`);
  }
}

/** Enables the feature, indexes every item and runs the wrapped tools once, then turns it off again. */
async function enableThenDisable(s: Services) {
  writeSemanticConfig(s.settings, { enabled: true }, s.db);
  invalidateSemanticCache(s);
  expect(semanticExtensions(s, workerEnv)).toBeDefined();
  const sem: SemanticContext = { db: s.db, services: s, embedder: new FixtureEmbedder(), config: fixtureConfig(), queryVectors: new Map() };
  await runItemPass(sem);
  const toolCtx: ToolContext = { services: s, timezone: "UTC", mode: "chat" };
  const tools = semanticTools(sem);
  for (const [name, input] of [["list_tasks", { query: "botany" }], ["search_notes", { query: "vacation plans" }], ["search", { query: "medication reminder" }]] as const) {
    await (tools.find((t) => t.name === name) as ImmediateTool).execute(input, toolCtx);
  }
  expect(Number(s.db.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${ITEM_TABLE}`)!.n)).toBeGreaterThan(0);
  writeSemanticConfig(s.settings, { enabled: false }, s.db);
  invalidateSemanticCache(s);
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const LOCAL_TIME = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/g;

/** Replaces ids by first-seen order and every timestamp by a marker, so two runs compare by content. */
function normalize(value: unknown, ids = new Map<string, string>()): unknown {
  if (Array.isArray(value)) return value.map((v) => normalize(v, ids));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => {
        if ((k === "id" || k.endsWith("_id")) && typeof v === "string") {
          if (!ids.has(v)) ids.set(v, `id${ids.size}`);
          return [k, ids.get(v)];
        }
        return [k, normalize(v, ids)];
      }),
    );
  }
  if (typeof value === "string") {
    let text = value;
    for (const [id, marker] of ids) text = text.replaceAll(id, marker);
    return ISO.test(text) ? "<time>" : text.replace(LOCAL_TIME, "<time>");
  }
  return value;
}

/** Runs the listed read and write tools through upstream `ALL_TOOLS`, in a fixed order. */
async function upstreamOutputs(s: Services) {
  const toolCtx: ToolContext = { services: s, timezone: "UTC", mode: "chat" };
  const run = (name: string, input: unknown) => (ALL_TOOLS.find((t) => t.name === name) as ImmediateTool).execute(input, toolCtx);
  const outputs: unknown[] = [];
  for (const [name, input] of [
    ["list_tasks", {}],
    ["list_tasks", { query: "botany" }],
    ["list_tasks", { query: "plants" }],
    ["list_tasks", { view: "completed", query: "doc appt soon?" }],
    ["search_notes", { query: "Lisbon" }],
    ["search_notes", { query: "vacation plans" }],
    ["search", { query: "rent" }],
    ["search", { query: "medication reminder" }],
    ["list_automations", {}],
  ] as const) {
    outputs.push(await run(name, input));
  }
  outputs.push(await run("create_task", { title: "Repot the fern" }));
  outputs.push(await run("update_task", { task: "Repot the fern", title: "Repot the fern and the cactus" }));
  const note = (await run("create_note", { title: "Garden log", content: "Fern repotted" })) as { created: { id: string } };
  outputs.push(note);
  outputs.push(await run("update_note", { id: note.created.id, append: "Cactus next week" }));
  outputs.push(await run("list_tasks", { query: "fern" }));
  return normalize(outputs);
}

async function routeOutputs() {
  const c = await loggedIn();
  const out: unknown[] = [];
  for (const path of ["/api/tasks", "/api/notes", "/api/notes?q=Lisbon", "/api/automations"]) {
    const res = await c.call(path);
    out.push({ path, status: res.status, body: await res.json() });
  }
  return normalize(out);
}

describe("semantic surfaces with the feature off", () => {
  it("S-off-schema: every semantic tool keeps upstream's schema object, permission, cap and label, and its description outside the search tools", async () => {
    await inAgent(async (a) => {
      const s = a.services;
      reset(s);
      expect(semanticExtensions(s, workerEnv)).toBeUndefined();
      writeSemanticConfig(s.settings, { enabled: false }, s.db);
      invalidateSemanticCache(s);
      expect(semanticExtensions(s, workerEnv)).toBeUndefined();

      const sem: SemanticContext = { db: s.db, services: s, embedder: new FixtureEmbedder(), config: fixtureConfig(), queryVectors: new Map() };
      const tools: ToolDefinition[] = semanticTools(sem);
      expect(tools.map((t) => t.name)).toEqual(ALL_TOOLS.map((t) => t.name));
      const reworded: Record<string, string> = { search: SEARCH_DESCRIPTION, search_notes: SEARCH_NOTES_DESCRIPTION, search_memories: SEARCH_MEMORIES_DESCRIPTION };
      for (const tool of tools) {
        const base = ALL_TOOLS.find((t) => t.name === tool.name)!;
        expect(tool.input).toBe(base.input);
        expect(tool.description).toBe(reworded[tool.name] ?? base.description);
        expect(tool.permission).toBe(base.permission);
        expect(tool.maxCallsPerTurn).toBe(base.maxCallsPerTurn);
        expect(tool.label).toBe(base.label);
      }
      reset(s);
    });
  });

  it("S-off-output: upstream tools give the same outputs never enabled and enabled-then-disabled", async () => {
    const never = await inAgent(async (a) => {
      reset(a.services);
      await seed(a.services);
      expect(semanticExtensions(a.services, workerEnv)).toBeUndefined();
      return upstreamOutputs(a.services);
    });
    const after = await inAgent(async (a) => {
      reset(a.services);
      await seed(a.services);
      await enableThenDisable(a.services);
      expect(semanticExtensions(a.services, workerEnv)).toBeUndefined();
      const outputs = await upstreamOutputs(a.services);
      expect(tableExists(a.services.db, ITEM_TABLE)).toBe(true);
      reset(a.services);
      return outputs;
    });
    expect(after).toEqual(never);
  });

  it("S-off-routes: task, note and automation routes answer the same never enabled and enabled-then-disabled", async () => {
    await inAgent(async (a) => {
      reset(a.services);
      await seed(a.services);
    });
    const never = await routeOutputs();
    await inAgent(async (a) => {
      reset(a.services);
      await seed(a.services);
      await enableThenDisable(a.services);
    });
    const after = await routeOutputs();
    await inAgent((a) => reset(a.services));
    expect(after).toEqual(never);
  });

  it("S-off-table: with the feature never enabled, no item vector table appears", async () => {
    await inAgent(async (a) => {
      reset(a.services);
      await seed(a.services);
      expect(semanticExtensions(a.services, workerEnv)).toBeUndefined();
      await upstreamOutputs(a.services);
    });
    await routeOutputs();
    await inAgent((a) => {
      expect(semanticExtensions(a.services, workerEnv)).toBeUndefined();
      expect(tableExists(a.services.db, ITEM_TABLE)).toBe(false);
      reset(a.services);
    });
  });
});
