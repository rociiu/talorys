import { ALL_TOOLS, type ToolContext, type ToolDefinition } from "../tools";
import type { ImmediateTool } from "../tools/registry";
import { presentTask } from "../tools/tasks";
import { localDayBounds } from "../services/time";
import { startBackgroundIndex } from "./indexer";
import { type SemanticContext, hybridSearch, savedAt } from "./recall";
import { noteAdditions, prepareSurfaceSearch, startBackgroundItemPass, taskAdditions } from "./surfaces";

const SEARCH_MEMORY_LIMIT = 10;
const SEARCH_ALL_MEMORY_LIMIT = 5;
/** Tasks of one view checked against meaning additions; far above any owner's open list. */
const VIEW_SCAN_LIMIT = 1000;
const NOTE_EXCERPT_CHARS = 400;

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
      const { query, include_history } = raw as { query: string; include_history?: boolean };
      const timezone = ctx.services.settings.get().timezone;
      const hits = await hybridSearch(sem, query, { limit: SEARCH_MEMORY_LIMIT, includeHistorical: include_history });
      return {
        memories: hits.map(({ memory: m }) => ({
          id: m.id,
          content: m.content,
          category: m.category,
          saved: savedAt(m.updated_at, timezone),
          ...(m.status !== "active" ? { status: m.status } : {}),
        })),
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
      const timezone = ctx.services.settings.get().timezone;
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

type ListTasksInput = { view?: "today" | "upcoming" | "overdue" | "open" | "completed"; query?: string; limit?: number };

/**
 * Upstream `list_tasks`, then up to three tasks of the same view found by meaning, tagged
 * `match: "meaning"`. Upstream hits stay first and unchanged; `count` covers the additions.
 */
function wrapListTasks(sem: SemanticContext): ToolDefinition {
  const base = upstream("list_tasks");
  return {
    ...base,
    execute: async (raw: unknown, ctx: ToolContext) => {
      const i = raw as ListTasksInput;
      const result = (await base.execute(raw, ctx)) as { count: number; tasks: { id: string }[] };
      if (!i.query) return result;
      const vector = await prepareSurfaceSearch(sem, i.query);
      if (!vector) return result;
      // The view mapping is upstream's (tools/tasks.ts), without the keyword filter.
      const bounds = localDayBounds(ctx.timezone);
      const view = i.view ?? "open";
      const allowedIds = new Set(
        ctx.services.tasks
          .list({
            status: view === "open" ? "open" : "all",
            view: view === "open" ? "all" : view,
            limit: VIEW_SCAN_LIMIT,
            dayStart: bounds.start,
            dayEnd: bounds.end,
          })
          .map((t) => t.id),
      );
      const added = taskAdditions(sem, vector, { keywordIds: result.tasks.map((t) => t.id), allowedIds, completedView: view === "completed" });
      if (added.length === 0) return result;
      const tasks = [...result.tasks, ...added.map((t) => ({ ...presentTask(t, ctx.timezone), match: "meaning" as const }))];
      return { ...result, count: tasks.length, tasks };
    },
  };
}

/** Upstream `search_notes`, then up to three notes found by meaning, tagged `match: "meaning"`. */
function wrapSearchNotes(sem: SemanticContext): ToolDefinition {
  const base = upstream("search_notes");
  return {
    ...base,
    execute: async (raw: unknown, ctx: ToolContext) => {
      const { query } = raw as { query: string };
      const result = (await base.execute(raw, ctx)) as { results: { id: string }[] };
      const vector = await prepareSurfaceSearch(sem, query);
      const added = noteAdditions(sem, vector, result.results.map((n) => n.id), NOTE_EXCERPT_CHARS);
      if (added.length === 0) return result;
      return { ...result, results: [...result.results, ...added.map((n) => ({ ...n, match: "meaning" as const }))] };
    },
  };
}

/** An upstream task, note or automation write, then a background item pass. */
function wrapItemIndexAfter(sem: SemanticContext, name: string): ToolDefinition {
  const base = upstream(name);
  return {
    ...base,
    execute: async (raw: unknown, ctx: ToolContext) => {
      const result = await base.execute(raw, ctx);
      void startBackgroundItemPass(sem);
      return result;
    },
  };
}

const ITEM_WRITE_TOOLS = ["create_task", "update_task", "complete_task", "create_note", "update_note", "create_reminder", "create_automation"];

/**
 * `ALL_TOOLS` with the search tools replaced in place by hybrid versions, `list_tasks` and
 * `search_notes` extended with meaning additions, and the memory, task, note and automation
 * save tools wrapped to index in the background. Destructive item tools stay upstream's: the
 * next item pass purges the vectors of whatever the owner approved deleting. `forget_memory` stays upstream's: it only
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
    list_tasks: wrapListTasks(sem),
    search_notes: wrapSearchNotes(sem),
    ...Object.fromEntries(ITEM_WRITE_TOOLS.map((name) => [name, wrapItemIndexAfter(sem, name)])),
  };
  return ALL_TOOLS.map((t) => wrapped[t.name] ?? t);
}
