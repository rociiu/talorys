import {
  type ChatMessage,
  type ProposedPlanInput,
  TASK_PLAN_TTL_MS,
  type TaskPlanContent,
  type TaskPlanDraft,
  type TaskPlanResult,
  taskPlanContentSchema,
} from "@talorys/shared";
import { type Database, newId, now } from "../db/database";
import type { TaskRepository } from "../db/repositories/tasks";
import { decodeTools } from "../db/repositories/conversations";
import type { ProjectRepository } from "../db/repositories/notes";
import { AppError, NotFoundError, ValidationError } from "../api/errors";
import type { ActivityLog } from "./usage";
import { parseLocalDateTime } from "./time";

interface DraftRow {
  id: string;
  conversation_id: string;
  payload: string;
  status: "pending" | "confirmed" | "cancelled";
  revision: number;
  result: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
  confirmed_at: string | null;
}

/** Drafts (whatever their status) are removed this long after they were proposed. */
const DRAFT_RETENTION_MS = 30 * 86_400_000;

const normalizeTitle = (title: string) => title.replace(/\s+/g, " ").trim().toLowerCase();

function present(row: DraftRow): TaskPlanDraft {
  const expired = row.status === "pending" && row.expires_at <= now();
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    revision: row.revision,
    status: expired ? "expired" : row.status,
    plan: JSON.parse(row.payload) as TaskPlanContent,
    expires_at: row.expires_at,
    confirmed_at: row.confirmed_at,
    result: row.result ? (JSON.parse(row.result) as TaskPlanResult) : null,
  };
}

/**
 * Task plans the agent proposes in chat. A draft never creates anything by itself: tasks
 * (and a new project) are written only by `confirm`, which the owner triggers through the API,
 * atomically and at most once per draft.
 */
export class TaskPlanService {
  constructor(
    private readonly db: Database,
    private readonly tasks: TaskRepository,
    private readonly projects: ProjectRepository,
    private readonly activity: ActivityLog,
  ) {}

  /**
   * Turns the agent's proposal into a validated draft. Tasks repeated within the plan, or equal
   * to an open task the owner already has, are left out and reported in `skipped`.
   */
  propose(conversationId: string, input: ProposedPlanInput): { draft: TaskPlanDraft; skipped: string[] } {
    const existingTitles = new Set(this.tasks.list({ status: "open", limit: 500 }).map((t) => normalizeTitle(t.title)));
    const seen = new Set<string>();
    const skipped: string[] = [];
    const tasks: TaskPlanContent["tasks"] = [];
    for (const t of input.tasks) {
      const key = normalizeTitle(t.title);
      if (seen.has(key) || existingTitles.has(key)) {
        skipped.push(t.title);
        continue;
      }
      seen.add(key);
      tasks.push({
        client_id: `t${tasks.length + 1}`,
        title: t.title,
        description: t.description ?? "",
        priority: t.priority ?? "medium",
        due: t.due ?? null,
        // Unless the agent says the owner stated the date, treat it as a suggestion.
        due_suggested: t.due ? t.due_is_suggestion !== false : false,
      });
    }
    if (tasks.length === 0) throw new ValidationError("Every proposed task already exists as an open task.");
    let project: TaskPlanContent["project"] = { mode: "none" };
    if (input.existing_project) {
      const found = this.projects.resolve(input.existing_project);
      if (!found) throw new ValidationError(`Project "${input.existing_project}" does not exist.`);
      project = { mode: "existing", id: found.id, name: found.name };
    } else if (input.new_project) {
      project = { mode: "new", name: input.new_project };
    }
    const content = this.normalize({ title: input.title, description: input.description ?? "", project, tasks });
    const ts = now();
    const row: DraftRow = {
      id: newId(),
      conversation_id: conversationId,
      payload: JSON.stringify(content),
      status: "pending",
      revision: 1,
      result: null,
      created_at: ts,
      updated_at: ts,
      expires_at: new Date(Date.parse(ts) + TASK_PLAN_TTL_MS).toISOString(),
      confirmed_at: null,
    };
    this.db.run(
      `INSERT INTO tal_task_plan_drafts (id, conversation_id, payload, status, revision, result, created_at, updated_at, expires_at, confirmed_at)
       VALUES (?, ?, ?, 'pending', 1, NULL, ?, ?, ?, NULL)`,
      row.id, row.conversation_id, row.payload, row.created_at, row.updated_at, row.expires_at,
    );
    this.db.run(`DELETE FROM tal_task_plan_drafts WHERE created_at < ?`, new Date(Date.now() - DRAFT_RETENTION_MS).toISOString());
    return { draft: present(row), skipped };
  }

  get(id: string): TaskPlanDraft | null {
    const row = this.row(id);
    return row ? present(row) : null;
  }

  /** The draft, only if it belongs to `conversationId`. */
  require(conversationId: string, id: string): TaskPlanDraft {
    const row = this.row(id);
    if (!row || row.conversation_id !== conversationId) throw new NotFoundError("This plan no longer exists.");
    return present(row);
  }

  /** Saves the owner's edits to a pending draft and bumps its revision. */
  update(conversationId: string, id: string, revision: number, content: TaskPlanContent): TaskPlanDraft {
    const draft = this.requirePending(conversationId, id, revision);
    const next = this.normalize(content, draft.plan);
    const changed = this.db.run(
      `UPDATE tal_task_plan_drafts SET payload = ?, revision = revision + 1, updated_at = ?
       WHERE id = ? AND status = 'pending' AND revision = ? AND expires_at > ?`,
      JSON.stringify(next), now(), id, revision, now(),
    ).changes;
    if (changed !== 1) throw stale();
    return this.syncMessage(this.require(conversationId, id));
  }

  /**
   * Creates the approved tasks (and the new project, if any) in one transaction. The draft is
   * claimed in that same transaction, so a repeated or concurrent confirmation can't create
   * anything twice: it gets the first confirmation's result instead (`replayed: true`).
   */
  confirm(conversationId: string, id: string, revision: number, content: TaskPlanContent, timezone: string): { draft: TaskPlanDraft; replayed: boolean } {
    const current = this.require(conversationId, id);
    if (current.status === "confirmed") return { draft: current, replayed: true };
    this.requirePending(conversationId, id, revision);
    const plan = this.normalize(content, current.plan);
    const dues = plan.tasks.map((t) => {
      if (!t.due) return null;
      const iso = parseLocalDateTime(t.due, timezone);
      if (!iso) throw new ValidationError(`“${t.title}” has an invalid due date.`);
      return iso;
    });

    this.db.transaction(() => {
      const at = now();
      const claimed = this.db.run(
        `UPDATE tal_task_plan_drafts SET status = 'confirmed', payload = ?, confirmed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'pending' AND revision = ? AND expires_at > ?`,
        JSON.stringify(plan), at, at, id, revision, at,
      ).changes;
      if (claimed !== 1) throw stale();

      let projectId: string | null = null;
      let projectCreated = false;
      if (plan.project.mode === "existing") {
        projectId = plan.project.id;
      } else if (plan.project.mode === "new") {
        const project = this.projects.create({ name: plan.project.name, description: plan.description });
        projectId = project.id;
        projectCreated = true;
        this.activity.record("project.created", `Created project “${project.name}” from a task plan`);
      }
      const taskIds = plan.tasks.map((t, i) =>
        this.tasks.create({ title: t.title, description: t.description, priority: t.priority, due_at: dues[i] ?? null, project_id: projectId }).id,
      );
      const result: TaskPlanResult = { task_ids: taskIds, project_id: projectId, project_created: projectCreated };
      this.db.run(`UPDATE tal_task_plan_drafts SET result = ? WHERE id = ?`, JSON.stringify(result), id);
      this.activity.record("task_plan.confirmed", `Created ${taskIds.length} task(s) from the plan “${plan.title}”`);
      this.syncMessage(this.require(conversationId, id));
    });
    return { draft: this.require(conversationId, id), replayed: false };
  }

  /** Cancels a pending draft; nothing is created. Cancelling an already-cancelled draft is a no-op. */
  cancel(conversationId: string, id: string): TaskPlanDraft {
    const draft = this.require(conversationId, id);
    if (draft.status === "cancelled") return draft;
    if (draft.status !== "pending") throw new AppError("CONFLICT", draft.status === "confirmed" ? "This plan was already confirmed." : "This plan expired.");
    this.db.run(`UPDATE tal_task_plan_drafts SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'pending'`, now(), id);
    return this.syncMessage(this.require(conversationId, id));
  }

  /** Cancels a draft whose chat turn was stopped before it finished. */
  discard(id: string): void {
    this.db.run(`UPDATE tal_task_plan_drafts SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'pending'`, now(), id);
  }

  /** Refreshes plan cards stored on messages with each draft's current state. */
  withCurrentState(messages: ChatMessage[]): ChatMessage[] {
    return messages.map((m) =>
      m.tools.some((t) => t.plan)
        ? { ...m, tools: m.tools.map((t) => (t.plan ? { ...t, plan: this.get(t.plan.id) ?? lapsed(t.plan) } : t)) }
        : m,
    );
  }

  /**
   * Copies a draft's latest state into the chat message that shows it. Drafts are pruned after
   * DRAFT_RETENTION_MS, and the message's copy is what the card and the model see after that.
   */
  private syncMessage(draft: TaskPlanDraft): TaskPlanDraft {
    const rows = this.db.all<{ id: string; tools: string }>(
      `SELECT id, tools FROM tal_messages WHERE conversation_id = ? AND tools LIKE ?`,
      draft.conversation_id, `%${draft.id}%`,
    );
    for (const row of rows) {
      const tools = decodeTools(row.tools).map((t) => (t.plan?.id === draft.id ? { ...t, plan: draft } : t));
      this.db.run(`UPDATE tal_messages SET tools = ? WHERE id = ?`, JSON.stringify(tools), row.id);
    }
    return draft;
  }

  private row(id: string): DraftRow | null {
    return this.db.one<DraftRow>(`SELECT * FROM tal_task_plan_drafts WHERE id = ?`, id);
  }

  private requirePending(conversationId: string, id: string, revision: number): TaskPlanDraft {
    const draft = this.require(conversationId, id);
    if (draft.status === "expired") throw new AppError("CONFLICT", "This plan expired. Ask again to get a new one.");
    if (draft.status === "cancelled") throw new AppError("CONFLICT", "This plan was cancelled.");
    if (draft.status === "confirmed") throw new AppError("CONFLICT", "This plan was already confirmed.");
    if (draft.revision !== revision) throw stale();
    return draft;
  }

  /**
   * Validates plan content on the server: limits and dates through the shared schema, the
   * project against the database, and (for edits) that tasks only come from the proposal.
   */
  private normalize(raw: TaskPlanContent, proposed?: TaskPlanContent): TaskPlanContent {
    const parsed = taskPlanContentSchema.safeParse(raw);
    if (!parsed.success) throw ValidationError.fromZod(parsed.error);
    const plan = parsed.data;
    if (proposed) {
      const allowed = new Set(proposed.tasks.map((t) => t.client_id));
      if (plan.tasks.some((t) => !allowed.has(t.client_id))) throw new ValidationError("Tasks can be edited or removed, not added.");
    }
    const seen = new Set<string>();
    for (const t of plan.tasks) {
      const key = normalizeTitle(t.title);
      if (seen.has(key)) throw new ValidationError(`“${t.title}” is in the plan twice.`);
      seen.add(key);
    }
    if (plan.project.mode === "existing") {
      const project = this.projects.get(plan.project.id);
      if (!project) throw new ValidationError("The selected project no longer exists.");
      plan.project = { mode: "existing", id: project.id, name: project.name };
    } else if (plan.project.mode === "new") {
      // A suggested name equal to an existing project reuses it instead of creating a duplicate.
      const existing = this.projects.resolve(plan.project.name);
      if (existing && existing.name.toLowerCase() === plan.project.name.trim().toLowerCase()) {
        plan.project = { mode: "existing", id: existing.id, name: existing.name };
      }
    }
    return plan;
  }
}

/** A message's copy of a pruned draft. One still pending was never confirmed, so it has expired. */
const lapsed = (plan: TaskPlanDraft): TaskPlanDraft => (plan.status === "pending" ? { ...plan, status: "expired" } : plan);

const stale = () => new AppError("CONFLICT", "This plan changed or expired since you opened it. Reload to see the latest version.");
