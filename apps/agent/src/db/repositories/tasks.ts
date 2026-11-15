import type { ProjectDetail, Task, TaskCategory, TaskCategoryPage, TaskPriority, TaskStatus } from "@talorys/shared";
import { type Database, likePattern, newId, now } from "../database";
import { NotFoundError } from "../../api/errors";

export interface TaskInput {
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  due_at?: string | null;
  project_id?: string | null;
}

export interface TaskQuery {
  status?: TaskStatus | "open" | "all";
  view?: "today" | "upcoming" | "overdue" | "completed" | "all";
  project_id?: string;
  q?: string;
  limit?: number;
  /** Boundaries of "today" in the owner's timezone, as UTC ISO strings. */
  dayStart?: string;
  dayEnd?: string;
}

const PRIORITY_ORDER = `CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`;

export interface TaskCategoryBounds {
  now: string;
  nextDay: string;
}

// Existing API clients and backups can supply ISO timestamps with offsets. Compare them in UTC.
const DUE = `coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', due_at, '+0 seconds'), due_at)`;
const REQUEST_BOUNDS = `CROSS JOIN (SELECT ? AS request_time, ? AS next_day)`;
const OPEN = `status != 'done'`;
const OVERDUE = `${DUE} < request_time`;
const DUE_TODAY = `${DUE} >= request_time AND ${DUE} < next_day`;
const CATEGORY_PREDICATES: Record<TaskCategory, string> = {
  open: OPEN,
  overdue: `${OPEN} AND ${OVERDUE}`,
  today: `${OPEN} AND ((${DUE_TODAY}) OR (due_at IS NULL AND status = 'in_progress'))`,
  upcoming: `${OPEN} AND ${DUE} >= next_day`,
  unscheduled: `${OPEN} AND due_at IS NULL AND status != 'in_progress'`,
  completed: `status = 'done'`,
};

export class TaskRepository {
  constructor(private readonly db: Database) {}

  list(query: TaskQuery = {}): Task[] {
    const where: string[] = [];
    const params: unknown[] = [];
    const status = query.status ?? "all";
    if (status === "open") where.push(`status != 'done'`);
    else if (status !== "all") {
      where.push(`status = ?`);
      params.push(status);
    }
    const nowIso = now();
    switch (query.view) {
      case "today":
        // Open tasks due before the end of today (includes overdue) plus undated in-progress work.
        where.push(`status != 'done' AND ((due_at IS NOT NULL AND due_at < ?) OR (due_at IS NULL AND status = 'in_progress'))`);
        params.push(query.dayEnd ?? nowIso);
        break;
      case "upcoming":
        // Undated work already under way is listed under today, so it is not upcoming as well.
        where.push(`status != 'done' AND ((due_at IS NOT NULL AND due_at >= ?) OR (due_at IS NULL AND status != 'in_progress'))`);
        params.push(query.dayEnd ?? nowIso);
        break;
      case "overdue":
        where.push(`status != 'done' AND due_at IS NOT NULL AND due_at < ?`);
        params.push(nowIso);
        break;
      case "completed":
        where.push(`status = 'done'`);
        break;
    }
    if (query.project_id) {
      where.push(`project_id = ?`);
      params.push(query.project_id);
    }
    if (query.q) {
      where.push(`(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')`);
      params.push(likePattern(query.q), likePattern(query.q));
    }
    const order =
      query.view === "completed"
        ? `completed_at DESC`
        : `CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at ASC, ${PRIORITY_ORDER}, created_at ASC`;
    return this.db.all<Task>(
      `SELECT * FROM tal_tasks ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${order} LIMIT ?`,
      ...params,
      query.limit ?? 200,
    );
  }

  listCategory(category: TaskCategory, bounds: TaskCategoryBounds, limit: number, projectId?: string, offset = 0): Task[] {
    const order = category === "completed"
      ? `completed_at DESC, tal_tasks.rowid DESC`
      : `due_at IS NULL, ${DUE}, created_at, ${PRIORITY_ORDER}, tal_tasks.rowid`;
    return this.db.all<Task>(
      `SELECT tal_tasks.* FROM tal_tasks ${REQUEST_BOUNDS}
       WHERE ${CATEGORY_PREDICATES[category]} ${projectId ? "AND project_id = ?" : ""}
       ORDER BY ${order} LIMIT ? OFFSET ?`,
      bounds.now, bounds.nextDay, ...(projectId ? [projectId] : []), limit, offset,
    );
  }

  focus(bounds: TaskCategoryBounds, limit: number): Task[] {
    return this.db.all<Task>(
      `SELECT tal_tasks.* FROM tal_tasks ${REQUEST_BOUNDS}
       WHERE ${OPEN}
       ORDER BY CASE WHEN due_at IS NULL THEN 3 WHEN ${OVERDUE} THEN 0 WHEN ${DUE_TODAY} THEN 1 ELSE 2 END,
         ${PRIORITY_ORDER}, ${DUE}, status = 'in_progress' DESC, created_at, tal_tasks.rowid
       LIMIT ?`,
      bounds.now, bounds.nextDay, limit,
    );
  }

  counts(bounds: TaskCategoryBounds, projectId?: string): TaskCategoryPage["counts"] {
    // An aggregate without GROUP BY always returns one row, including for an empty project.
    const columns = Object.entries(CATEGORY_PREDICATES).map(([category, predicate]) =>
      `coalesce(sum(CASE WHEN ${predicate} THEN 1 ELSE 0 END), 0) AS ${category}`,
    );
    return this.db.one<TaskCategoryPage["counts"]>(
      `SELECT ${columns.join(", ")} FROM tal_tasks ${REQUEST_BOUNDS} ${projectId ? "WHERE project_id = ?" : ""}`,
      bounds.now, bounds.nextDay, ...(projectId ? [projectId] : []),
    )!;
  }

  projectCounts(projectId: string): ProjectDetail["task_counts"] {
    return this.db.one<ProjectDetail["task_counts"]>(
      `SELECT count(*) FILTER (WHERE ${OPEN}) AS open, count(*) FILTER (WHERE status = 'done') AS completed
       FROM tal_tasks WHERE project_id = ?`,
      projectId,
    )!;
  }

  get(id: string): Task | null {
    return this.db.one<Task>(`SELECT * FROM tal_tasks WHERE id = ?`, id);
  }

  require(id: string): Task {
    const task = this.get(id);
    if (!task) throw new NotFoundError("Task not found");
    return task;
  }

  create(input: TaskInput): Task {
    const ts = now();
    const status = input.status ?? "todo";
    const task: Task = {
      id: newId(),
      title: input.title.trim(),
      description: input.description ?? "",
      status,
      priority: input.priority ?? "medium",
      due_at: input.due_at ?? null,
      project_id: input.project_id ?? null,
      created_at: ts,
      updated_at: ts,
      completed_at: status === "done" ? ts : null,
    };
    this.db.run(
      `INSERT INTO tal_tasks (id, title, description, status, priority, due_at, project_id, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      task.id, task.title, task.description, task.status, task.priority, task.due_at, task.project_id,
      task.created_at, task.updated_at, task.completed_at,
    );
    return task;
  }

  update(id: string, patch: Partial<TaskInput>): Task {
    const existing = this.require(id);
    const next: Task = { ...existing, ...stripUndefined(patch), updated_at: now() } as Task;
    if (patch.status && patch.status !== existing.status) {
      next.completed_at = patch.status === "done" ? next.updated_at : null;
    }
    this.db.run(
      `UPDATE tal_tasks SET title = ?, description = ?, status = ?, priority = ?, due_at = ?, project_id = ?,
       updated_at = ?, completed_at = ? WHERE id = ?`,
      next.title, next.description, next.status, next.priority, next.due_at, next.project_id,
      next.updated_at, next.completed_at, id,
    );
    return next;
  }

  complete(id: string): Task {
    return this.update(id, { status: "done" });
  }

  delete(id: string): void {
    this.require(id);
    this.db.run(`DELETE FROM tal_tasks WHERE id = ?`, id);
  }

  /**
   * Finds a task by exact id or a case-insensitive title match (used by tools). A title equal to the
   * reference wins over longer titles that merely contain it ("Call Sam" vs "Call Sam about lunch").
   */
  resolve(ref: string): Task | null {
    const byId = this.get(ref);
    if (byId) return byId;
    const exact = this.db.all<Task>(`SELECT * FROM tal_tasks WHERE lower(trim(title)) = lower(?) LIMIT 2`, ref.trim());
    if (exact.length === 1) return exact[0]!;
    const matches = this.db.all<Task>(
      `SELECT * FROM tal_tasks WHERE title LIKE ? ESCAPE '\\' ORDER BY status = 'done', updated_at DESC LIMIT 2`,
      likePattern(ref),
    );
    return matches.length === 1 ? matches[0]! : null;
  }
}

export function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
