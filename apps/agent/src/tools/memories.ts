import { MEMORY_CATEGORIES } from "@talorys/shared";
import { z } from "zod";
import { defineTool, quoteTitle, ToolError } from "./registry";
import { hasHistoricalIntent } from "../memory/intent";

export const memoryTools = [
  defineTool({
    name: "remember",
    description:
      "Store a durable fact about the owner (preference, goal, habit, important fact). Only use when the owner asks you to remember something or states a clearly lasting preference. Write it as a short third-person statement.",
    permission: "write",
    maxCallsPerTurn: 3,
    input: z.object({
      content: z.string().min(3).max(1000),
      category: z.enum(MEMORY_CATEGORIES).optional(),
    }),
    label: () => `Saving to memory`,
    execute: async (i, ctx) => {
      const { memory, superseded, reviews } = await ctx.services.memoryHistory.create({ content: i.content, category: i.category ?? "other", source: "agent" });
      ctx.services.activity.record("memory.created", `Agent remembered: ${memory.content}`);
      return {
        remembered: { id: memory.id, content: memory.content, category: memory.category },
        ...(superseded.length ? { now_historical: superseded.map((m) => ({ id: m.id, content: m.content })) } : {}),
        ...(reviews.length ? { needs_owner_review: "This may conflict with an older memory; both are kept until the owner reviews it on the Memory page." } : {}),
      };
    },
  }),
  defineTool({
    name: "search_memories",
    description:
      "Search what you remember about the owner. Results marked historical are past facts that are no longer true; set include_history for questions about the past.",
    permission: "read",
    maxCallsPerTurn: 3,
    input: z.object({ query: z.string().min(1).max(200), include_history: z.boolean().optional() }),
    label: (i) => `Recalling “${i.query}”`,
    execute: (i, ctx) => ({
      memories: ctx.services.memories
        .search(i.query, 10, undefined, (i.include_history ?? hasHistoricalIntent(i.query)) ? "all" : "current")
        .map((m) => ({ id: m.id, content: m.content, category: m.category, ...(m.status !== "active" ? { status: m.status } : {}) })),
    }),
  }),
  defineTool({
    name: "update_memory",
    description: "Correct or refine an existing memory by id. The old wording is kept as a past fact the owner can restore.",
    permission: "write",
    maxCallsPerTurn: 3,
    input: z.object({ id: z.string().min(1), content: z.string().min(3).max(1000), category: z.enum(MEMORY_CATEGORIES).optional() }),
    label: () => `Updating a memory`,
    execute: async (i, ctx) => {
      const before = ctx.services.memories.get(i.id);
      if (!before) throw new ToolError("Memory not found.");
      // A new wording supersedes the old memory instead of overwriting it, so the agent can never erase a fact.
      const { memory: m } =
        i.content.trim() === before.content.trim()
          ? await ctx.services.memoryHistory.update(i.id, { category: i.category })
          : await ctx.services.memoryHistory.correct(i.id, i.content, i.category, "agent");
      return { updated: { id: m.id, content: m.content }, ...(m.id !== before.id ? { previous_kept_as_history: before.id } : {}) };
    },
  }),
  defineTool({
    name: "forget_memory",
    description: "Propose deleting a memory by id. The owner must approve it in the app before anything is deleted.",
    permission: "destructive",
    maxCallsPerTurn: 3,
    input: z.object({ id: z.string().min(1) }),
    label: () => `Proposing to forget a memory`,
    prepare: (i, ctx) => {
      const m = ctx.services.memories.get(i.id);
      if (!m) throw new ToolError("Memory not found.");
      return { targetId: m.id, summary: `Forget memory ${quoteTitle(m.content)}` };
    },
    snapshot: (id, ctx) => {
      const m = ctx.services.memories.get(id);
      return m && [m.content, m.category];
    },
    commit: (id, ctx) => {
      const m = ctx.services.memories.get(id);
      if (!m) throw new ToolError("This memory no longer exists.");
      ctx.services.memoryHistory.delete(m.id);
      ctx.services.activity.record("memory.deleted", "Forgot a memory (approved agent action)");
    },
  }),
];
