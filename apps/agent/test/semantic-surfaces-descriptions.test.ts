import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { inAgent } from "./helpers";
import { FixtureEmbedder, fixtureConfig } from "./fixture-embedder";
import { invalidateSemanticCache, semanticExtensions } from "../src/semantic";
import { deleteSemanticConfig, writeSemanticConfig } from "../src/semantic/config";
import { dropSemanticData } from "../src/semantic/migrations";
import type { SemanticContext } from "../src/semantic/recall";
import { semanticTools } from "../src/semantic/tools";
import { ALL_TOOLS, type ToolDefinition } from "../src/tools";
import type { Services } from "../src/services/container";
import type { Env } from "../src/env";

const workerEnv = env as unknown as Env;

const SEARCH =
  "Search the owner's tasks, notes, memories, automations and past conversations at once, by keywords and meaning. Use this first for open questions.";
const SEARCH_NOTES = "Search the owner's notes by keywords and meaning. Returns titles and short excerpts.";
const SEARCH_MEMORIES =
  "Only for facts you saved about the owner. Use `search` for anything they may have written down. Results marked historical are past facts that are no longer true; set include_history for questions about the past.";
const REWORDED: Record<string, string> = { search: SEARCH, search_notes: SEARCH_NOTES, search_memories: SEARCH_MEMORIES };

function reset(s: Services) {
  dropSemanticData(s.db);
  deleteSemanticConfig(s.settings);
  invalidateSemanticCache(s);
}

/** Every field but `execute` (and, for the reworded tools, `description`). */
function definition(tool: ToolDefinition, omitDescription: boolean): Record<string, unknown> {
  const { execute: _execute, ...rest } = tool as ToolDefinition & { execute?: unknown };
  if (!omitDescription) return rest;
  const { description: _description, ...others } = rest;
  return others;
}

/** The tool list the runner would hand the model: the extensions' tools, or upstream's. */
function runnerTools(s: Services): ToolDefinition[] {
  return semanticExtensions(s, workerEnv)?.tools ?? ALL_TOOLS;
}

describe("semantic search tool descriptions", () => {
  it("TD-a: with semantic on the three search tools are reworded and every other field stays upstream's", async () => {
    await inAgent((a) => {
      const s = a.services;
      reset(s);
      writeSemanticConfig(s.settings, { enabled: true }, s.db);
      invalidateSemanticCache(s);
      const sem: SemanticContext = { db: s.db, services: s, embedder: new FixtureEmbedder(), config: fixtureConfig(), queryVectors: new Map() };

      for (const tools of [semanticTools(sem), runnerTools(s)]) {
        expect(tools.map((t) => t.name)).toEqual(ALL_TOOLS.map((t) => t.name));
        for (const tool of tools) {
          const base = ALL_TOOLS.find((t) => t.name === tool.name)!;
          const reworded = REWORDED[tool.name];
          if (reworded) {
            expect(tool.description).toBe(reworded);
            expect(base.description).not.toBe(reworded);
          } else {
            expect(tool.description).toBe(base.description);
          }
          expect(definition(tool, true)).toEqual(definition(base, true));
          expect(tool.input).toBe(base.input);
        }
      }
      reset(s);
    });
  });

  it("TD-b: with semantic off the tool list, descriptions included, is ALL_TOOLS", async () => {
    await inAgent((a) => {
      const s = a.services;
      reset(s);
      expect(runnerTools(s)).toBe(ALL_TOOLS);

      writeSemanticConfig(s.settings, { enabled: false }, s.db);
      invalidateSemanticCache(s);
      const tools = runnerTools(s);
      expect(tools).toBe(ALL_TOOLS);
      expect(tools.map((t) => [t.name, t.description])).toEqual(ALL_TOOLS.map((t) => [t.name, t.description]));
      for (const name of Object.keys(REWORDED)) {
        const tool = tools.find((t) => t.name === name)!;
        expect(tool.description).not.toBe(REWORDED[name]);
        expect(definition(tool, false)).toEqual(definition(ALL_TOOLS.find((t) => t.name === name)!, false));
      }
      reset(s);
    });
  });
});
