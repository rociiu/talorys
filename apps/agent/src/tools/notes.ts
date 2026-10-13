import { PROJECT_STATUSES } from "@talorys/shared";
import { z } from "zod";
import { defineTool, quoteTitle, type ToolContext, ToolError } from "./registry";

function noteSnapshot(id: string, ctx: ToolContext) {
  const n = ctx.services.notes.get(id);
  return n && [n.title, n.content, n.project_id];
}

export const noteTools = [
  defineTool({
    name: "create_note",
    description: "Save a Markdown note for the owner (ideas, meeting notes, reference information).",
    permission: "write",
    maxCallsPerTurn: 3,
    input: z.object({
      title: z.string().min(1).max(300),
      content: z.string().max(20_000),
      project: z.string().max(200).optional(),
    }),
    label: (i) => `Saving note “${i.title}”`,
    execute: (i, ctx) => {
      let projectId: string | null = null;
      if (i.project) {
        const p = ctx.services.projects.resolve(i.project);
        if (!p) throw new ToolError(`Project "${i.project}" does not exist.`);
        projectId = p.id;
      }
      const note = ctx.services.notes.create({ title: i.title, content: i.content, project_id: projectId });
      ctx.services.activity.record("note.created", `Agent created note “${note.title}”`);
      return { created: { id: note.id, title: note.title } };
    },
  }),
  defineTool({
    name: "search_notes",
    description: "Full-text search over the owner's notes. Returns titles and short excerpts.",
    permission: "read",
    maxCallsPerTurn: 3,
    input: z.object({ query: z.string().min(1).max(200) }),
    label: (i) => `Searching notes for “${i.query}”`,
    execute: (i, ctx) => ({
      results: ctx.services.notes.search(i.query, 8).map((n) => ({ id: n.id, title: n.title, excerpt: n.content.slice(0, 400) })),
    }),
  }),
  defineTool({
    name: "read_note",
    description: "Read the full content of a note by id.",
    permission: "read",
    maxCallsPerTurn: 3,
    input: z.object({ id: z.string().min(1) }),
    label: () => `Reading a note`,
    execute: (i, ctx) => {
      const note = ctx.services.notes.get(i.id);
      if (!note) throw new ToolError("Note not found.");
      return { id: note.id, title: note.title, content: note.content.slice(0, 8000) };
    },
  }),
  defineTool({
    name: "update_note",
    description:
      "Rename a note and/or append text to the end of it. To replace or remove existing text, use replace_note_content, which the owner must approve.",
    permission: "write",
    maxCallsPerTurn: 3,
    input: z.object({
      id: z.string().min(1),
      title: z.string().min(1).max(300).optional(),
      append: z.string().min(1).max(10_000).optional(),
    }).strict(),
    label: () => `Updating a note`,
    execute: (i, ctx) => {
      const note = ctx.services.notes.get(i.id);
      if (!note) throw new ToolError("Note not found.");
      const content = i.append ? `${note.content}\n\n${i.append}` : undefined;
      const updated = ctx.services.notes.update(note.id, { title: i.title, content });
      return { updated: { id: updated.id, title: updated.title } };
    },
  }),
  defineTool({
    name: "replace_note_content",
    description:
      "Propose replacing the whole text of a note (to edit or remove existing text). The owner must approve it in the app before anything changes.",
    permission: "destructive",
    maxCallsPerTurn: 2,
    input: z.object({ id: z.string().min(1), content: z.string().min(1).max(20_000) }),
    label: () => `Proposing to rewrite a note`,
    prepare: (i, ctx) => {
      const note = ctx.services.notes.get(i.id);
      if (!note) throw new ToolError("Note not found.");
      const size = `${note.content.length.toLocaleString("en-US")} → ${i.content.length.toLocaleString("en-US")} characters`;
      return { targetId: note.id, summary: `Rewrite note ${quoteTitle(note.title)} (${size})`, payload: { content: i.content }, preview: i.content };
    },
    snapshot: noteSnapshot,
    commit: (id, ctx, payload) => {
      const { content } = z.object({ content: z.string().min(1).max(20_000) }).parse(payload);
      const note = ctx.services.notes.update(id, { content });
      ctx.services.activity.record("note.rewritten", `Rewrote note “${note.title}” (approved agent action)`);
    },
  }),
  defineTool({
    name: "delete_note",
    description: "Propose permanently deleting a note. The owner must approve it in the app before anything is deleted.",
    permission: "destructive",
    maxCallsPerTurn: 2,
    input: z.object({ id: z.string().min(1) }),
    label: () => `Proposing to delete a note`,
    prepare: (i, ctx) => {
      const note = ctx.services.notes.get(i.id);
      if (!note) throw new ToolError("Note not found.");
      return { targetId: note.id, summary: `Delete note ${quoteTitle(note.title)}` };
    },
    snapshot: noteSnapshot,
    commit: (id, ctx) => {
      const note = ctx.services.notes.get(id);
      if (!note) throw new ToolError("This note no longer exists.");
      ctx.services.notes.delete(note.id);
      ctx.services.activity.record("note.deleted", `Deleted note “${note.title}” (approved agent action)`);
    },
  }),
];

export const projectTools = [
  defineTool({
    name: "list_projects",
    description: "List the owner's projects.",
    permission: "read",
    maxCallsPerTurn: 2,
    input: z.object({}),
    label: () => `Checking projects`,
    execute: (_i, ctx) => ({
      projects: ctx.services.projects.list().map((p) => ({ id: p.id, name: p.name, status: p.status, description: p.description.slice(0, 200) })),
    }),
  }),
  defineTool({
    name: "create_project",
    description: "Create a lightweight project to group tasks and notes.",
    permission: "write",
    maxCallsPerTurn: 2,
    input: z.object({
      name: z.string().min(1).max(200),
      description: z.string().max(2000).optional(),
      status: z.enum(PROJECT_STATUSES).optional(),
    }),
    label: (i) => `Creating project “${i.name}”`,
    execute: (i, ctx) => {
      const existing = ctx.services.projects.resolve(i.name);
      if (existing) return { existing: { id: existing.id, name: existing.name } };
      const p = ctx.services.projects.create(i);
      return { created: { id: p.id, name: p.name } };
    },
  }),
];
