import { TASK_PRIORITIES, TASK_STATUSES, type Task } from "@talorys/shared";
import { z } from "zod";
import { defineTool, quoteTitle, ToolError, type ToolContext } from "./registry";
import { formatLocal, localDayBounds, parseLocalDateTime } from "../services/time";

const localDate = z
  .string()
  .describe("Local date 'YYYY-MM-DD' or date-time 'YYYY-MM-DDTHH:MM' in the owner's timezone");

function toDue(value: string | null | undefined, ctx: ToolContext): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const iso = parseLocalDateTime(value, ctx.timezone);
  if (!iso) throw new ToolError(`Could not understand the date "${value}". Use YYYY-MM-DD or YYYY-MM-DDTHH:MM.`);
  return iso;
}

function resolveTask(ref: string, ctx: ToolContext): Task {
  const task = ctx.services.tasks.resolve(ref);
  if (!task) throw new ToolError(`No single task matches "${ref}". List tasks to find the exact one.`);
  return task;
}

function resolveProject(ref: string | undefined | null, ctx: ToolContext): string | null | undefined {
  if (ref === undefined) return undefined;
  if (ref === null || ref === "") return null;
  const project = ctx.services.projects.resolve(ref);
  if (!project) throw new ToolError(`Project "${ref}" does not exist. Create it first with create_project.`);
  return project.id;
}

/** Compact representation for the model, with dates in the owner's timezone. */
export function presentTask(t: Task, tz: string) {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    due: formatLocal(t.due_at, tz),
    ...(t.description ? { description: t.description.slice(0, 300) } : {}),
  };
}

export const taskTools = [
  defineTool({
    name: "create_task",
    description: "Create a task for the owner. Use for to-dos and action items.",
    permission: "write",
    maxCallsPerTurn: 5,
    input: z.object({
      title: z.string().min(1).max(300),
      description: z.string().max(2000).optional(),
      priority: z.enum(TASK_PRIORITIES).optional(),
      due: localDate.optional(),
      project: z.string().max(200).optional().describe("Project name or id"),
    }),
    label: (i) => `Adding task “${i.title}”`,
    execute: (i, ctx) => {
      const task = ctx.services.tasks.create({
        title: i.title,
        description: i.description,
        priority: i.priority,
        due_at: toDue(i.due, ctx) ?? null,
        project_id: resolveProject(i.project, ctx) ?? null,
      });
      ctx.services.activity.record("task.created", `Agent created task “${task.title}”`);
      return { created: presentTask(task, ctx.timezone) };
    },
  }),
  defineTool({
    name: "list_tasks",
    description:
      "List the owner's tasks. view: 'today' (due today or overdue), 'upcoming', 'overdue', 'open' (all not done), 'completed'.",
    permission: "read",
    maxCallsPerTurn: 3,
    input: z.object({
      view: z.enum(["today", "upcoming", "overdue", "open", "completed"]).optional(),
      query: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    label: (i) => `Checking ${i.view ?? "open"} tasks`,
    execute: (i, ctx) => {
      const bounds = localDayBounds(ctx.timezone);
      const view = i.view ?? "open";
      const tasks = ctx.services.tasks.list({
        status: view === "open" ? "open" : "all",
        view: view === "open" ? "all" : view,
        q: i.query,
        limit: i.limit ?? 25,
        dayStart: bounds.start,
        dayEnd: bounds.end,
      });
      return { count: tasks.length, tasks: tasks.map((t) => presentTask(t, ctx.timezone)) };
    },
  }),
  defineTool({
    name: "update_task",
    description: "Update a task's title, description, status, priority, due date or project.",
    permission: "write",
    maxCallsPerTurn: 5,
    input: z.object({
      task: z.string().min(1).describe("Task id or exact/partial title"),
      title: z.string().min(1).max(300).optional(),
      description: z.string().max(2000).optional(),
      status: z.enum(TASK_STATUSES).optional(),
      priority: z.enum(TASK_PRIORITIES).optional(),
      due: localDate.nullable().optional(),
      project: z.string().max(200).nullable().optional(),
    }),
    label: (i) => `Updating task “${i.task}”`,
    execute: (i, ctx) => {
      const task = resolveTask(i.task, ctx);
      const updated = ctx.services.tasks.update(task.id, {
        title: i.title,
        description: i.description,
        status: i.status,
        priority: i.priority,
        due_at: toDue(i.due, ctx),
        project_id: resolveProject(i.project, ctx),
      });
      return { updated: presentTask(updated, ctx.timezone) };
    },
  }),
  defineTool({
    name: "complete_task",
    description: "Mark a task as done.",
    permission: "write",
    maxCallsPerTurn: 10,
    input: z.object({ task: z.string().min(1).describe("Task id or exact/partial title") }),
    label: (i) => `Completing “${i.task}”`,
    execute: (i, ctx) => {
      const task = resolveTask(i.task, ctx);
      const done = ctx.services.tasks.complete(task.id);
      ctx.services.activity.record("task.completed", `Agent completed task “${done.title}”`);
      return { completed: presentTask(done, ctx.timezone) };
    },
  }),
  defineTool({
    name: "delete_task",
    description: "Propose permanently deleting a task. The owner must approve it in the app before anything is deleted.",
    permission: "destructive",
    maxCallsPerTurn: 3,
    input: z.object({ task: z.string().min(1).describe("Task id or exact/partial title") }),
    label: (i) => `Proposing to delete “${i.task}”`,
    prepare: (i, ctx) => {
      const task = resolveTask(i.task, ctx);
      return { targetId: task.id, summary: `Delete task ${quoteTitle(task.title)}` };
    },
    snapshot: (id, ctx) => {
      const t = ctx.services.tasks.get(id);
      // Status is left out: completing a task after the proposal should not block deleting it.
      return t && [t.title, t.description, t.priority, t.due_at, t.project_id];
    },
    commit: (id, ctx) => {
      const task = ctx.services.tasks.get(id);
      if (!task) throw new ToolError("This task no longer exists.");
      ctx.services.tasks.delete(task.id);
      ctx.services.activity.record("task.deleted", `Deleted task “${task.title}” (approved agent action)`);
    },
  }),
];
