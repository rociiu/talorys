import type { TodayOverview } from "@talorys/shared";
import { describe, expect, it } from "vitest";
import { localDayBounds } from "../src/services/time";
import { buildToday } from "../src/services/today";
import { client, inAgent, loggedIn } from "./helpers";

const ZERO = { open: 0, overdue: 0, today: 0, upcoming: 0 };

describe("Today focus sorting", () => {
  it("uses urgency, priority, due timestamp, status, age and stable insertion order", async () => {
    await inAgent((agent) => {
      const { db, tasks } = agent.services;
      const bounds = { now: "2026-06-15T12:00:00.000Z", nextDay: "2026-06-16T00:00:00.000Z" };
      const later = tasks.create({ title: "Later", due_at: "2026-06-20T12:00:00.000Z", priority: "urgent" });
      const undated = tasks.create({ title: "Undated", priority: "urgent" });
      const undatedStarted = tasks.create({ title: "Undated underway", priority: "urgent", status: "in_progress" });
      const todayLow = tasks.create({ title: "Today low", due_at: "2026-06-15T13:00:00.000Z", priority: "low" });
      const overdue = tasks.create({ title: "Overdue", due_at: "2026-06-14T18:00:00.000Z", priority: "low" });
      const due = { due_at: "2026-06-15T17:00:00.000Z", priority: "urgent" as const };
      const todo = tasks.create({ title: "Today urgent", ...due });
      const started = tasks.create({ title: "Started", status: "in_progress", ...due });
      const tied = tasks.create({ title: "Tied with started", status: "in_progress", ...due });
      const older = tasks.create({ title: "Older", status: "in_progress", ...due });
      const earlierDue = tasks.create({ title: "Earlier", ...due, due_at: "2026-06-15T16:59:00.000Z" });
      const all = [overdue, earlierDue, older, started, tied, todo, todayLow, later, undatedStarted, undated];
      try {
        db.run("UPDATE tal_tasks SET created_at = ? WHERE id IN (?, ?)", started.created_at, started.id, tied.id);
        db.run("UPDATE tal_tasks SET created_at = ? WHERE id = ?", "2025-01-01T00:00:00.000Z", older.id);
        expect(tasks.focus(bounds, all.length).map((t) => t.id)).toEqual(all.map((t) => t.id));
      } finally {
        for (const t of all) tasks.delete(t.id);
      }
    });
  });
});

describe("Today aggregation", () => {
  it("separates overdue, today and upcoming in the owner's timezone and counts project work", async () => {
    await inAgent((agent) => {
      const s = agent.services;
      const previous = s.settings.get().timezone;
      s.settings.update({ timezone: "America/New_York" });
      const project = s.projects.create({ name: `Today ${crypto.randomUUID()}` });
      const overdue = s.tasks.create({ title: "Overdue", project_id: project.id, due_at: "2026-11-01T04:30:00.000Z" });
      const today = s.tasks.create({ title: "Today", project_id: project.id, due_at: "2026-11-01T05:45:00.000Z", priority: "high" });
      const upcoming = s.tasks.create({ title: "Upcoming", project_id: project.id, due_at: "2026-11-03T15:00:00.000Z" });
      const done = s.tasks.create({ title: "Done", project_id: project.id, status: "done", due_at: "2026-11-01T04:00:00.000Z" });
      try {
        const result = buildToday(s, new Date("2026-11-01T05:30:00.000Z"));
        expect(result.local_date).toBe("2026-11-01");
        expect(result.tasks.overdue.map((t) => t.id)).toContain(overdue.id);
        expect(result.tasks.today.map((t) => t.id)).toContain(today.id);
        expect(result.tasks.upcoming.map((t) => t.id)).toContain(upcoming.id);
        expect(result.tasks.overdue.map((t) => t.id)).not.toContain(done.id);
        expect(result.projects.find((p) => p.id === project.id)).toMatchObject({ open_tasks: 3, overdue_tasks: 1, due_soon_tasks: 2 });
        expect(result.suggestion).toMatchObject({ kind: "review_overdue" });
      } finally {
        for (const t of [overdue, today, upcoming, done]) s.tasks.delete(t.id);
        s.projects.delete(project.id);
        s.settings.update({ timezone: previous });
      }
    });
  });

  it("serves the dashboard to the owner without AI, but not anonymously", async () => {
    expect((await client().call("/api/today")).status).toBe(401);
    const c = await loggedIn();
    await inAgent((agent) => agent.services.usage.increment({ ai_requests: 10_000 }));
    const res = await c.call("/api/today");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ counts: ZERO, focus: [], tasks: { today: [], overdue: [], upcoming: [] }, projects: [], automations: [] });
    const done = await inAgent((agent) => agent.services.tasks.create({ title: "Completed only", status: "done" }));
    try {
      expect((await c.json<TodayOverview>("/api/today")).counts).toEqual(ZERO);
    } finally {
      await inAgent((agent) => {
        agent.services.tasks.delete(done.id);
        agent.services.db.run("DELETE FROM tal_usage_daily");
      });
    }
  });
});

it("selects bounded dashboard lists from all open tasks and counts every category exactly", async () => {
  await inAgent((agent) => {
    const s = agent.services;
    const timezone = s.settings.get().timezone;
    s.settings.update({ timezone: "America/New_York" });
    const project = s.projects.create({ name: "Large Today project" });
    const at = new Date("2026-11-01T05:30:00.000Z");
    const next = "2026-11-02T05:00:00.000Z";
    const bounds = { now: at.toISOString(), nextDay: next };
    const seed = (title: string, due_at: string | null, status: "todo" | "done" | "in_progress" = "todo") =>
      s.tasks.create({ title, due_at, status, project_id: project.id });
    try {
      const { overdue, urgent, today, upcoming, started, undated } = s.db.transaction(() => ({
        overdue: Array.from({ length: 501 }, (_, i) => seed(`Overdue ${i}`, new Date(at.getTime() - 10_000 + i).toISOString())),
        urgent: s.tasks.create({ title: "Urgent outside the old window", due_at: "2026-11-01T05:29:59.999Z", priority: "urgent", project_id: project.id }),
        today: Array.from({ length: 9 }, (_, i) => seed(`Today ${i}`, new Date(at.getTime() + i).toISOString())),
        upcoming: Array.from({ length: 7 }, (_, i) => seed(`Upcoming ${i}`, new Date(Date.parse(next) + i).toISOString())),
        started: seed("Undated in progress", null, "in_progress"),
        undated: seed("Undated todo", null),
        done: seed("Done overdue", "2026-11-01T05:00:00.000Z", "done"),
      }));

      expect(s.tasks.list({ status: "open", limit: 500 }).map((t) => t.id)).not.toContain(urgent.id);
      const result = buildToday(s, at);
      const ids = (tasks: { id: string }[]) => tasks.map((t) => t.id);
      expect(ids(result.focus)).toEqual(ids([urgent, ...overdue.slice(0, 2)]));
      expect(ids(result.tasks.overdue)).toEqual(ids(overdue.slice(0, 5)));
      expect(ids(result.tasks.today)).toEqual(ids(today.slice(0, 8)));
      expect(ids(result.tasks.upcoming)).toEqual(ids(upcoming.slice(0, 5)));
      expect(result.counts).toEqual({ open: 520, overdue: 502, today: 10, upcoming: 7 });
      expect(buildToday(s, at)).toEqual(result);

      const list = (category: "overdue" | "today" | "upcoming" | "unscheduled" | "open", offset = 0) =>
        ids(s.tasks.listCategory(category, bounds, 500, project.id, offset));
      const categorized = [...list("overdue"), ...list("overdue", 500), ...list("today"), ...list("upcoming"), ...list("unscheduled")];
      const allOpen = [...list("open"), ...list("open", 500)];
      expect(categorized).toHaveLength(520);
      expect(new Set(categorized)).toEqual(new Set(allOpen));
      expect(list("today")).toEqual(ids([...today, started]));
      expect(list("unscheduled")).toEqual([undated.id]);
    } finally {
      s.db.run("DELETE FROM tal_tasks WHERE project_id = ?", project.id);
      s.projects.delete(project.id);
      s.settings.update({ timezone });
    }
  });
});

it.each([
  ["2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z", 23],
  ["2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z", 25],
])("classifies tasks at local midnight on a %s DST transition day", async (start, end, hours) => {
  await inAgent((agent) => {
    const s = agent.services;
    const timezone = s.settings.get().timezone;
    const at = new Date(start);
    s.settings.update({ timezone: "America/New_York" });
    const last = s.tasks.create({ title: "Last millisecond of the day", due_at: new Date(Date.parse(end) - 1).toISOString() });
    const first = s.tasks.create({ title: "Next local midnight", due_at: end });
    const offset = s.tasks.create({ title: "Same midnight with an explicit offset", due_at: `${end.slice(0, 10)}T01:00:00-0${hours === 23 ? 3 : 4}:00` });
    try {
      expect(localDayBounds("America/New_York", at)).toEqual({ start, end });
      expect(Date.parse(end) - at.getTime()).toBe(hours * 3600_000);
      expect(buildToday(s, at).counts).toEqual({ open: 3, today: 1, overdue: 0, upcoming: 2 });
      const after = buildToday(s, new Date(end));
      expect(after.counts).toEqual({ open: 3, today: 2, overdue: 1, upcoming: 0 });
      expect(after.tasks.overdue.map((t) => t.id)).toEqual([last.id]);
      expect(after.tasks.today.map((t) => t.id)).toEqual([first.id, offset.id]);
    } finally {
      for (const t of [last, first, offset]) s.tasks.delete(t.id);
      s.settings.update({ timezone });
    }
  });
});
