import { z } from "zod";
import { isValidCalendarDate } from "./recurrence";
import { TASK_PRIORITIES } from "./constants";

/** Size limits for a proposed task plan, enforced on the AI's proposal, on edits and on confirmation. */
export const TASK_PLAN_LIMITS = {
  maxTasks: 15,
  title: 200,
  description: 1000,
  taskTitle: 300,
  taskDescription: 2000,
  projectName: 200,
  clientId: 40,
} as const;

/** How long the owner has to review a proposed plan before it expires. */
export const TASK_PLAN_TTL_MS = 24 * 60 * 60_000;

const LOCAL_DUE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;

/** A due date in the owner's timezone: "YYYY-MM-DD" (end of that day) or "YYYY-MM-DDTHH:MM". Impossible dates are rejected. */
export const localDueSchema = z.string().trim().refine((v) => {
  const m = v.match(LOCAL_DUE);
  if (!m) return false;
  if (!isValidCalendarDate(Number(m[1]), Number(m[2]), Number(m[3]))) return false;
  return m[4] === undefined || (Number(m[4]) <= 23 && Number(m[5]) <= 59);
}, "Use a real date as YYYY-MM-DD or YYYY-MM-DDTHH:MM");

export const planTaskSchema = z.object({
  /** Stable id of the proposed task within its plan; never a database id. */
  client_id: z.string().regex(/^[a-z0-9-]+$/i).max(TASK_PLAN_LIMITS.clientId),
  title: z.string().trim().min(1).max(TASK_PLAN_LIMITS.taskTitle),
  description: z.string().trim().max(TASK_PLAN_LIMITS.taskDescription).default(""),
  priority: z.enum(TASK_PRIORITIES),
  due: localDueSchema.nullable().default(null),
  /** True when the date is the agent's suggestion rather than a deadline the owner stated. */
  due_suggested: z.boolean().default(false),
});
export type PlanTask = z.infer<typeof planTaskSchema>;

export const planProjectSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }),
  z.object({ mode: z.literal("existing"), id: z.string().min(1).max(64), name: z.string().max(TASK_PLAN_LIMITS.projectName).optional() }),
  z.object({ mode: z.literal("new"), name: z.string().trim().min(1).max(TASK_PLAN_LIMITS.projectName) }),
]);
export type PlanProject = z.infer<typeof planProjectSchema>;

/** The editable content of a plan: what the owner reviews and confirms. */
export const taskPlanContentSchema = z
  .object({
    title: z.string().trim().min(1).max(TASK_PLAN_LIMITS.title),
    description: z.string().trim().max(TASK_PLAN_LIMITS.description).default(""),
    project: planProjectSchema.default({ mode: "none" }),
    tasks: z.array(planTaskSchema).min(1, "Keep at least one task").max(TASK_PLAN_LIMITS.maxTasks),
  })
  .superRefine((plan, ctx) => {
    const ids = new Set<string>();
    plan.tasks.forEach((t, i) => {
      if (ids.has(t.client_id)) ctx.addIssue({ code: "custom", path: ["tasks", i, "client_id"], message: "Duplicate task id" });
      ids.add(t.client_id);
    });
  });
export type TaskPlanContent = z.infer<typeof taskPlanContentSchema>;

/** Saves the owner's edits, or confirms a plan, against the revision they were looking at. */
export const taskPlanSubmitSchema = z.object({
  revision: z.number().int().min(1),
  plan: taskPlanContentSchema,
});

export type TaskPlanStatus = "pending" | "confirmed" | "cancelled" | "expired";

export interface TaskPlanResult {
  task_ids: string[];
  project_id: string | null;
  project_created: boolean;
}

/** A proposed plan as the owner sees it. Nothing in it exists as a task until it is confirmed. */
export interface TaskPlanDraft {
  id: string;
  conversation_id: string;
  revision: number;
  status: TaskPlanStatus;
  plan: TaskPlanContent;
  expires_at: string;
  confirmed_at: string | null;
  result: TaskPlanResult | null;
}

/** The input the agent's propose_task_plan tool accepts: loose enough for small models, validated strictly after. */
export const proposedPlanInputSchema = z.object({
  title: z.string().trim().min(1).max(TASK_PLAN_LIMITS.title).describe("Short name of the goal, e.g. 'App launch preparation'"),
  description: z.string().trim().max(TASK_PLAN_LIMITS.description).optional(),
  existing_project: z.string().max(200).optional().describe("Name or id of an existing project to add the tasks to"),
  new_project: z.string().trim().min(1).max(TASK_PLAN_LIMITS.projectName).optional().describe("Name of a new project, only when the owner asks for one or it clearly helps"),
  tasks: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(TASK_PLAN_LIMITS.taskTitle).describe("Concise, actionable title starting with a verb"),
        description: z.string().trim().max(TASK_PLAN_LIMITS.taskDescription).optional(),
        priority: z.enum(TASK_PRIORITIES).optional(),
        due: localDueSchema.optional().describe("YYYY-MM-DD or YYYY-MM-DDTHH:MM, only if a date is known or clearly implied"),
        due_is_suggestion: z.boolean().optional().describe("true if you chose the date; false/omitted if the owner stated it"),
      }),
    )
    .min(2)
    .max(TASK_PLAN_LIMITS.maxTasks),
});
export type ProposedPlanInput = z.infer<typeof proposedPlanInputSchema>;

/** Snapshot of a plan stored with the chat message that proposed it. Refreshed from the database on read. */
export const taskPlanDraftSchema = z.object({
  id: z.string(),
  conversation_id: z.string(),
  revision: z.number(),
  status: z.enum(["pending", "confirmed", "cancelled", "expired"]),
  plan: taskPlanContentSchema,
  expires_at: z.string(),
  confirmed_at: z.string().nullable(),
  result: z.object({ task_ids: z.array(z.string()), project_id: z.string().nullable(), project_created: z.boolean() }).nullable(),
}) satisfies z.ZodType<TaskPlanDraft, unknown>;
