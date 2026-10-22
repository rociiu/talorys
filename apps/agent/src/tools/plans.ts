import { proposedPlanInputSchema } from "@talorys/shared";
import { AppError } from "../api/errors";
import { defineTool, ToolError } from "./registry";

export const PROPOSE_TASK_PLAN = "propose_task_plan";

export const planTools = [
  defineTool({
    name: PROPOSE_TASK_PLAN,
    description:
      "Propose a plan of 2-15 tasks (usually 3-8) when the owner asks to plan, break down or organize a multi-step goal. " +
      "Creates nothing: the owner reviews, edits and confirms the plan in the app. For a single task use create_task instead.",
    // "write" keeps it out of scheduled runs; it only stores a draft for the owner to review.
    permission: "write",
    maxCallsPerTurn: 1,
    input: proposedPlanInputSchema,
    label: (i) => `Proposing plan “${i.title}”`,
    execute: (i, ctx) => {
      if (!ctx.conversationId) throw new ToolError("Task plans can only be proposed in chat.");
      let proposed: ReturnType<typeof ctx.services.taskPlans.propose>;
      try {
        proposed = ctx.services.taskPlans.propose(ctx.conversationId, i);
      } catch (error) {
        if (error instanceof AppError) throw new ToolError(error.message);
        throw error;
      }
      const { draft, skipped } = proposed;
      return {
        status: "awaiting_owner_review",
        plan_id: draft.id,
        tasks: draft.plan.tasks.length,
        ...(skipped.length ? { left_out_as_duplicates: skipped } : {}),
        note: "No tasks exist yet. The owner now sees the plan with Edit, Confirm and Cancel buttons. In one or two sentences, say you proposed it for review. Do not list every task again, do not call create_task for these, and never say they were created.",
      };
    },
  }),
];
