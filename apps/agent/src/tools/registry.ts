import type { PendingAction } from "@talorys/shared";
import { AppError, NotFoundError } from "../api/errors";
import type { z } from "zod";
import type { Services } from "../services/container";

export type ToolPermission = "read" | "write" | "destructive";

export interface ToolContext {
  services: Services;
  timezone: string;
  /** "chat" for interactive turns; "scheduled" for automation runs (read-only + notify). */
  mode: "chat" | "scheduled";
  /** The chat conversation, which owns any destructive actions proposed during the turn. */
  conversationId?: string;
}

/** The exact target of a destructive call, resolved before anything changes. */
export interface PreparedAction {
  targetId: string;
  /** Shown to the owner on the approval card, e.g. `Delete task “Buy milk”`. */
  summary: string;
  /** Extra validated input `commit` needs (e.g. a note's replacement text), stored with the proposal. */
  payload?: unknown;
  /** Text the action will write, shown in full on the approval card so the owner sees what they approve. */
  preview?: string;
}

interface BaseTool<S extends z.ZodType> {
  name: string;
  description: string;
  input: S;
  /** Max invocations of this tool in a single turn (in addition to the global budget). */
  maxCallsPerTurn?: number;
  /** Short human-readable label for the UI, e.g. "Adding task “Buy milk”". */
  label: (input: z.infer<S>) => string;
}

export interface ImmediateTool<S extends z.ZodType = z.ZodType, R = unknown> extends BaseTool<S> {
  permission: "read" | "write";
  execute: (input: z.infer<S>, ctx: ToolContext) => R | Promise<R>;
}

/**
 * A destructive tool never runs during the agent's turn. `prepare` resolves the target
 * without changing anything; `commit` runs only after the owner approves that exact action.
 * `snapshot` returns the fields the approval card describes (null if the target is gone);
 * approval is refused if they changed after the proposal.
 */
export interface DestructiveTool<S extends z.ZodType = z.ZodType> extends BaseTool<S> {
  permission: "destructive";
  prepare: (input: z.infer<S>, ctx: ToolContext) => PreparedAction | Promise<PreparedAction>;
  snapshot: (targetId: string, ctx: ToolContext) => unknown;
  commit: (targetId: string, ctx: ToolContext, payload: unknown) => unknown;
}

export type ToolDefinition<S extends z.ZodType = z.ZodType, R = unknown> = ImmediateTool<S, R> | DestructiveTool<S>;

export function defineTool<S extends z.ZodType, R>(def: ToolDefinition<S, R>): ToolDefinition<S, R> {
  return def;
}

/** Quotes a title for an approval summary, shortened so the card stays readable. */
export function quoteTitle(text: string, max = 80): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return `“${clean.length > max ? `${clean.slice(0, max - 1)}…` : clean}”`;
}

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export interface ExecutorLimits {
  maxToolCalls: number;
}

/**
 * Executes tools for one agent turn with validation, permission checks,
 * a global call budget, per-tool caps and duplicate-call (loop) detection.
 */
export class ToolExecutor {
  private calls = 0;
  private readonly perTool = new Map<string, number>();
  private readonly signatures = new Map<string, number>();
  /** Approval requests created this turn, by provider tool-call id. */
  private readonly approvals = new Map<string, PendingAction>();
  /** Task plan drafts proposed this turn, by provider tool-call id. */
  private readonly plans = new Map<string, string>();

  constructor(
    private readonly tools: ToolDefinition[],
    private readonly ctx: ToolContext,
    private readonly limits: ExecutorLimits,
  ) {}

  get callCount(): number {
    return this.calls;
  }

  budgetExhausted(): boolean {
    return this.calls >= this.limits.maxToolCalls;
  }

  /** Tools permitted in this context. Scheduled runs never get write or destructive tools. */
  available(): ToolDefinition[] {
    if (this.limits.maxToolCalls <= 0) return [];
    return this.tools.filter((t) => this.ctx.mode === "chat" || t.permission === "read" || t.name === "notify_owner");
  }

  find(name: string): ToolDefinition | undefined {
    return this.available().find((t) => t.name === name);
  }

  approvalFor(callId: string): PendingAction | undefined {
    return this.approvals.get(callId);
  }

  /** The draft id of a task plan proposed by this call, if any. */
  planFor(callId: string): string | undefined {
    return this.plans.get(callId);
  }

  /** Every task plan draft proposed this turn. */
  proposedPlans(): string[] {
    return [...this.plans.values()];
  }

  async execute(name: string, rawInput: unknown, callId?: string): Promise<unknown> {
    const tool = this.find(name);
    if (!tool) throw new ToolError(`Tool "${name}" is not available.`);
    if (this.calls >= this.limits.maxToolCalls) {
      throw new ToolError("Tool call limit reached for this request. Answer the owner with the information you already have.");
    }
    const used = this.perTool.get(name) ?? 0;
    if (tool.maxCallsPerTurn !== undefined && used >= tool.maxCallsPerTurn) {
      throw new ToolError(`"${name}" was already used ${used} times in this request. Do not call it again.`);
    }
    const parsed = tool.input.safeParse(rawInput ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ToolError(`Invalid input${issue ? ` at "${issue.path.join(".")}": ${issue.message}` : ""}.`);
    }
    const signature = `${name}:${stableStringify(parsed.data)}`;
    const repeats = this.signatures.get(signature) ?? 0;
    if (repeats >= 1) {
      throw new ToolError("This exact call was already made in this request. Use the earlier result instead of repeating it.");
    }
    this.calls++;
    this.perTool.set(name, used + 1);
    this.signatures.set(signature, repeats + 1);
    if (tool.permission !== "destructive") {
      let result: unknown;
      try {
        result = await tool.execute(parsed.data, this.ctx);
      } catch (error) {
        // A rejected call doesn't use up the tool's per-turn allowance, so the model can correct its input.
        if (error instanceof ToolError) this.perTool.set(name, used);
        throw error;
      }
      if (callId && result && typeof result === "object" && "plan_id" in result && typeof result.plan_id === "string") {
        this.plans.set(callId, result.plan_id);
      }
      return result;
    }

    if (!this.ctx.conversationId) throw new ToolError(`"${name}" needs the owner's approval and can only be used in chat.`);
    const prepared = await tool.prepare(parsed.data, this.ctx);
    const action = this.ctx.services.pendingActions.create({
      conversation_id: this.ctx.conversationId,
      tool: tool.name,
      target_id: prepared.targetId,
      target_version: await targetVersion(tool, prepared.targetId, this.ctx),
      summary: prepared.summary,
      payload: prepared.payload === undefined ? null : JSON.stringify(prepared.payload),
      preview: prepared.preview ?? null,
    });
    if (callId) this.approvals.set(callId, action);
    return {
      status: "awaiting_owner_approval",
      action: prepared.summary,
      note: "Nothing has changed yet. The owner now sees an Approve button for exactly this action. Briefly tell them what you proposed. Do not call this tool again for the same item and do not claim it is done.",
    };
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/** SHA-256 of the target's snapshot, or null if the target no longer exists. */
async function targetVersion(tool: DestructiveTool, targetId: string, ctx: ToolContext): Promise<string | null> {
  const snapshot = tool.snapshot(targetId, ctx);
  if (snapshot === null || snapshot === undefined) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableStringify(snapshot)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Runs a destructive action the owner approved in the UI. The pending record is claimed
 * atomically first, so each action runs at most once, and only on the target that was shown:
 * if the target changed after the proposal (an edit, an import), the action fails instead.
 */
export async function runApprovedAction(tools: ToolDefinition[], ctx: ToolContext, actionId: string): Promise<PendingAction> {
  const pending = ctx.services.pendingActions;
  const stored = pending.get(actionId);
  if (!stored) throw new NotFoundError("This action no longer exists.");
  const tool = tools.find((t) => t.name === stored.tool);
  if (tool?.permission !== "destructive") throw new NotFoundError("This action no longer exists.");
  if (!pending.resolve(actionId, "approved")) {
    const status = pending.view(actionId)?.status;
    throw new AppError("CONFLICT", status === "expired" ? "This request expired. Ask again to get a new one." : "This action was already handled.");
  }
  try {
    const version = await targetVersion(tool, stored.target_id, ctx);
    if (version === null) throw new ToolError("This item no longer exists.");
    if (!stored.target_version || version !== stored.target_version) {
      throw new ToolError("This item changed after it was proposed, so nothing was done. Ask again to get a new approval.");
    }
    await tool.commit(stored.target_id, ctx, stored.payload === null ? undefined : JSON.parse(stored.payload));
  } catch (error) {
    pending.markFailed(actionId, error instanceof ToolError ? error.message : "The action failed.");
    if (!(error instanceof ToolError)) console.error("Approved action failed", error);
  }
  return pending.view(actionId)!;
}
