import { ALL_TOOLS, type ToolContext, type ToolDefinition } from "../tools";
import type { ImmediateTool } from "../tools/registry";
import { startBackgroundIndex } from "./indexer";
import { type SemanticContext, hybridSearch, savedAt } from "./recall";

const SEARCH_MEMORY_LIMIT = 10;
const SEARCH_ALL_MEMORY_LIMIT = 5;

/** An upstream read or write tool; destructive tools are never wrapped (they run on owner approval). */
function upstream(name: string): ImmediateTool {
  const tool = ALL_TOOLS.find((t) => t.name === name);
  if (!tool || tool.permission === "destructive") throw new Error(`Upstream immediate tool "${name}" not found`);
  return tool;
}

/** `search_memories` with hybrid hits; name, description, schema, permission, cap and label are upstream's. */
function wrapSearchMemories(sem: SemanticContext): ToolDefinition {
  const base = upstream("search_memories");
  return {
    ...base,
    execute: async (raw: unknown, ctx: ToolContext) => {
      const { query } = raw as { query: string };
      const timezone = ctx.timezone ?? ctx.services.settings.get().timezone;
      const hits = await hybridSearch(sem, query, { limit: SEARCH_MEMORY_LIMIT });
      return {
        memories: hits.map(({ memory: m }) => ({ id: m.id, content: m.content, category: m.category, saved: savedAt(m.updated_at, timezone) })),
      };
    },
  };
}

/** Upstream `search` with only its `memories` replaced by hybrid hits. */
function wrapSearch(sem: SemanticContext): ToolDefinition {
  const base = upstream("search");
  return {
    ...base,
    execute: async (raw: unknown, ctx: ToolContext) => {
      const { query } = raw as { query: string };
      const result = (await base.execute(raw, ctx)) as Record<string, unknown>;
      const timezone = ctx.timezone ?? ctx.services.settings.get().timezone;
      const hits = await hybridSearch(sem, query, { limit: SEARCH_ALL_MEMORY_LIMIT });
      return { ...result, memories: hits.map(({ memory: m }) => ({ id: m.id, content: m.content, saved: savedAt(m.updated_at, timezone) })) };
    },
  };
}

/** Upstream `remember`/`update_memory`, then a background index of the saved memory. */
function wrapIndexAfter(sem: SemanticContext, name: string): ToolDefinition {
  const base = upstream(name);
  return {
    ...base,
    execute: async (raw: unknown, ctx: ToolContext) => {
      const result = await base.execute(raw, ctx);
      void startBackgroundIndex(sem);
      return result;
    },
  };
}

/**
 * `ALL_TOOLS` with the search tools replaced in place by hybrid versions and the memory
 * save tools wrapped to index in the background. `forget_memory` stays upstream's: it only
 * proposes, and the approve route purges the vector when the owner approves (see routes.ts).
 * Everything but `execute` is the upstream definition, so ToolExecutor enforces the same
 * permissions, per-turn caps and scheduled read-only mode.
 */
export function semanticTools(sem: SemanticContext): ToolDefinition[] {
  const wrapped: Record<string, ToolDefinition> = {
    search_memories: wrapSearchMemories(sem),
    search: wrapSearch(sem),
    remember: wrapIndexAfter(sem, "remember"),
    update_memory: wrapIndexAfter(sem, "update_memory"),
  };
  return ALL_TOOLS.map((t) => wrapped[t.name] ?? t);
}
