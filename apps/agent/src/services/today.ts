import { getZonedParts, type Task, type TodayOverview, type TodaySuggestion, zonedTimeToUtc } from "@talorys/shared";
import type { Services } from "./container";
import { localDayBounds } from "./time";

const PRIORITY = { urgent: 0, high: 1, medium: 2, low: 3 } as const;

function dueBucket(task: Task, nowIso: string, dayEnd: string): number {
  if (!task.due_at) return 3;
  if (task.due_at < nowIso) return 0;
  if (task.due_at < dayEnd) return 1;
  return 2;
}

/** Deterministic focus order: urgency, explicit priority, work underway, then age. */
export function compareFocusTasks(a: Task, b: Task, nowIso: string, dayEnd: string): number {
  const bucket = dueBucket(a, nowIso, dayEnd) - dueBucket(b, nowIso, dayEnd);
  if (bucket) return bucket;
  const priority = PRIORITY[a.priority] - PRIORITY[b.priority];
  if (priority) return priority;
  if (a.due_at !== b.due_at) return (a.due_at ?? "￿").localeCompare(b.due_at ?? "￿");
  const status = Number(b.status === "in_progress") - Number(a.status === "in_progress");
  if (status) return status;
  return a.created_at.localeCompare(b.created_at);
}

function localDate(at: Date, timezone: string): string {
  const p = getZonedParts(at, timezone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

function suggestion(counts: TodayOverview["counts"], projects: TodayOverview["projects"]): TodaySuggestion | null {
  if (counts.overdue > 0) return { kind: "review_overdue", count: counts.overdue };
  const approaching = projects.find((p) => p.due_soon_tasks > 0 || p.overdue_tasks > 0);
  if (approaching) {
    return {
      kind: "plan_project",
      project_id: approaching.id,
      project_name: approaching.name,
      count: approaching.due_soon_tasks + approaching.overdue_tasks,
    };
  }
  const active = projects.find((p) => p.open_tasks > 0);
  if (active) return { kind: "review_project", project_id: active.id, project_name: active.name, count: active.open_tasks };
  if (counts.open === 0) return { kind: "create_first_task" };
  return null;
}

/** A bounded, read-only daily overview. No AI provider or inference is involved. */
export function buildToday(s: Services, at = new Date()): TodayOverview {
  const timezone = s.settings.get().timezone;
  const nowIso = at.toISOString();
  const bounds = localDayBounds(timezone, at);
  const local = getZonedParts(at, timezone);
  const soonDate = new Date(Date.UTC(local.year, local.month - 1, local.day + 8));
  const soonEnd = zonedTimeToUtc(soonDate.getUTCFullYear(), soonDate.getUTCMonth() + 1, soonDate.getUTCDate(), 0, 0, timezone).toISOString();
  const open = s.tasks.list({ status: "open", limit: 500 });
  const counts = s.tasks.counts(bounds.end, nowIso);
  const projects = s.projects.dashboard(nowIso, soonEnd, 3);
  const automations = s.automations
    .list()
    .filter((a) => a.enabled && a.next_run)
    .sort((a, b) => a.next_run!.localeCompare(b.next_run!))
    .slice(0, 4);
  const byDue = (a: Task, b: Task) => (a.due_at ?? "￿").localeCompare(b.due_at ?? "￿") || a.created_at.localeCompare(b.created_at);

  return {
    generated_at: nowIso,
    timezone,
    local_date: localDate(at, timezone),
    counts,
    focus: [...open].sort((a, b) => compareFocusTasks(a, b, nowIso, bounds.end)).slice(0, 3),
    tasks: {
      overdue: open.filter((t) => t.due_at && t.due_at < nowIso).sort(byDue).slice(0, 5),
      today: open
        .filter((t) => (t.due_at && t.due_at >= nowIso && t.due_at < bounds.end) || (!t.due_at && t.status === "in_progress"))
        .sort(byDue)
        .slice(0, 8),
      upcoming: open.filter((t) => t.due_at && t.due_at >= bounds.end).sort(byDue).slice(0, 5),
    },
    projects,
    automations,
    suggestion: suggestion(counts, projects),
  };
}
