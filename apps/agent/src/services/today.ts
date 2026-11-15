import { getZonedParts, type TodayOverview, type TodaySuggestion, zonedTimeToUtc } from "@talorys/shared";
import type { Services } from "./container";
import { localDayBounds } from "./time";

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
  const bounds = { now: nowIso, nextDay: localDayBounds(timezone, at).end };
  const local = getZonedParts(at, timezone);
  const soonDate = new Date(Date.UTC(local.year, local.month - 1, local.day + 8));
  const soonEnd = zonedTimeToUtc(soonDate.getUTCFullYear(), soonDate.getUTCMonth() + 1, soonDate.getUTCDate(), 0, 0, timezone).toISOString();
  const { open, overdue, today, upcoming } = s.tasks.counts(bounds);
  const counts = { open, overdue, today, upcoming };
  const projects = s.projects.dashboard(nowIso, soonEnd, 3);
  const automations = s.automations
    .list()
    .filter((a) => a.enabled && a.next_run)
    .sort((a, b) => a.next_run!.localeCompare(b.next_run!))
    .slice(0, 4);

  return {
    generated_at: nowIso,
    timezone,
    local_date: localDate(at, timezone),
    counts,
    focus: s.tasks.focus(bounds, 3),
    tasks: {
      overdue: s.tasks.listCategory("overdue", bounds, 5),
      today: s.tasks.listCategory("today", bounds, 8),
      upcoming: s.tasks.listCategory("upcoming", bounds, 5),
    },
    projects,
    automations,
    suggestion: suggestion(counts, projects),
  };
}
