import { z } from "zod";
import { defineTool } from "./registry";
import { presentTask } from "./tasks";

export const searchTools = [
  defineTool({
    name: "search",
    description: "Search across the owner's tasks, notes, memories and past conversations at once.",
    permission: "read",
    maxCallsPerTurn: 2,
    input: z.object({ query: z.string().min(1).max(200) }),
    label: (i) => `“${i.query}” 검색 중`,
    execute: (i, ctx) => {
      const s = ctx.services;
      return {
        tasks: s.tasks.list({ q: i.query, limit: 5 }).map((t) => presentTask(t, ctx.timezone)),
        notes: s.notes.search(i.query, 5).map((n) => ({ id: n.id, title: n.title, excerpt: n.content.slice(0, 200) })),
        memories: s.memories.search(i.query, 5).map((m) => ({ id: m.id, content: m.content })),
        conversations: s.conversations.list({ q: i.query, limit: 5 }).map((c) => ({ id: c.id, title: c.title })),
      };
    },
  }),
];
