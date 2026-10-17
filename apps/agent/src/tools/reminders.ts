import { scheduleSpecSchema } from "@talorys/shared";
import { z } from "zod";
import { defineTool, quoteTitle, ToolError } from "./registry";
import { clip } from "../services/text";
import { formatLocal, toLocalMinute } from "../services/time";

export const reminderTools = [
  defineTool({
    name: "create_reminder",
    description:
      "Create a one-time reminder shown in the owner's notification center. Give either 'at' (local time 'YYYY-MM-DDTHH:MM' in the owner's timezone) or 'in_minutes'.",
    permission: "write",
    maxCallsPerTurn: 3,
    input: z.object({
      message: z.string().min(1).max(500),
      at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).optional(),
      in_minutes: z.number().int().min(1).max(60 * 24 * 365).optional(),
    }),
    label: (i) => `Setting reminder “${i.message}”`,
    execute: async (i, ctx) => {
      let at = i.at;
      if (!at && i.in_minutes) at = toLocalMinute(new Date(Date.now() + i.in_minutes * 60_000 + 59_000), ctx.timezone);
      if (!at) throw new ToolError("Provide 'at' or 'in_minutes'.");
      const a = await ctx.services.automations.create({
        name: clip(i.message, 120),
        kind: "reminder",
        message: i.message,
        schedule: { type: "once", at },
        enabled: true,
      });
      return { reminder: { id: a.id, message: a.message, when: formatLocal(a.next_run, ctx.timezone) } };
    },
  }),
  defineTool({
    name: "create_automation",
    description: [
      "Create a recurring schedule. kind: 'reminder' (show message, no AI), 'task_digest' (deterministic summary of due/overdue tasks, no AI),",
      "or 'agent_prompt' (run an AI prompt with read-only tools; use only when AI reasoning is truly needed).",
      "schedule examples: {type:'daily',time:'09:00'}, {type:'weekly',days:[5],time:'17:00'} (0=Sunday),",
      "{type:'monthly',day:1,time:'08:00'}, {type:'interval',minutes:120}, {type:'once',at:'2026-01-31T09:00'}. Times are local.",
    ].join(" "),
    permission: "write",
    maxCallsPerTurn: 2,
    input: z.object({
      name: z.string().min(1).max(200),
      kind: z.enum(["reminder", "task_digest", "agent_prompt"]),
      message: z.string().max(2000).optional().describe("Reminder text or AI prompt"),
      schedule: scheduleSpecSchema,
    }),
    label: (i) => `Scheduling “${i.name}”`,
    execute: async (i, ctx) => {
      const a = await ctx.services.automations.create({
        name: i.name,
        kind: i.kind,
        message: i.message ?? "",
        schedule: i.schedule,
        enabled: true,
      });
      return { automation: { id: a.id, name: a.name, schedule: a.schedule_description, next_run: formatLocal(a.next_run, ctx.timezone) } };
    },
  }),
  defineTool({
    name: "list_automations",
    description: "List reminders and scheduled automations.",
    permission: "read",
    maxCallsPerTurn: 2,
    input: z.object({}),
    label: () => `Checking schedules`,
    execute: (_i, ctx) => ({
      automations: ctx.services.automations.list().map((a) => ({
        id: a.id,
        name: a.name,
        kind: a.kind,
        schedule: a.schedule_description,
        enabled: a.enabled,
        next_run: formatLocal(a.next_run, ctx.timezone),
      })),
    }),
  }),
  defineTool({
    name: "cancel_automation",
    description: "Propose deleting a reminder or automation by id. The owner must approve it in the app before anything is deleted.",
    permission: "destructive",
    maxCallsPerTurn: 3,
    input: z.object({ id: z.string().min(1) }),
    label: () => `Proposing to cancel a schedule`,
    prepare: (i, ctx) => {
      const a = ctx.services.automations.get(i.id);
      if (!a) throw new ToolError("Automation not found.");
      return { targetId: a.id, summary: `Cancel ${a.kind === "reminder" ? "reminder" : "automation"} ${quoteTitle(a.name)}` };
    },
    // Run bookkeeping (last_run, next_run, run_count) changes on every run and is left out.
    snapshot: (id, ctx) => {
      const a = ctx.services.automations.get(id);
      return a && [a.name, a.kind, a.message, a.schedule, a.enabled];
    },
    commit: async (id, ctx) => {
      const a = ctx.services.automations.get(id);
      if (!a) throw new ToolError("This automation no longer exists.");
      await ctx.services.automations.delete(a.id);
    },
  }),
  defineTool({
    name: "notify_owner",
    description: "Post a message to the owner's notification center. Use in scheduled runs to deliver results.",
    permission: "write",
    maxCallsPerTurn: 1,
    input: z.object({ title: z.string().min(1).max(200), body: z.string().min(1).max(4000) }),
    label: () => `Sending a notification`,
    execute: (i, ctx) => {
      const n = ctx.services.notifications.create({ title: i.title, body: i.body });
      return { notified: n.id };
    },
  }),
];
