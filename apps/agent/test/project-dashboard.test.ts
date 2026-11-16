import { describe, expect, it } from "vitest";
import { inAgent } from "./helpers";

const NOW = "2026-11-16T10:00:00.000Z";
const SOON_END = "2026-11-24T10:00:00.000Z";

describe("project dashboard due timestamps", () => {
  it("normalizes explicit offsets for counts and next due without changing stored timestamps", async () => {
    await inAgent((agent) => {
      const s = agent.services;
      const project = s.projects.create({ name: "Offset dashboard" });
      const negative = s.tasks.create({ title: "Future despite local clock", project_id: project.id, due_at: "2026-11-16T09:30:00-08:00" });
      const positive = s.tasks.create({ title: "Overdue despite local clock", project_id: project.id, due_at: "2026-11-16T10:30:00+01:00" });
      const equivalent = [
        s.tasks.create({ title: "UTC", project_id: project.id, due_at: "2026-11-16T12:00:00.000Z" }),
        s.tasks.create({ title: "Positive offset", project_id: project.id, due_at: "2026-11-16T13:00:00+01:00" }),
        s.tasks.create({ title: "Negative offset", project_id: project.id, due_at: "2026-11-16T07:00:00-05:00" }),
      ];
      const done = s.tasks.create({ title: "Completed overdue", project_id: project.id, status: "done", due_at: "2026-11-16T08:00:00.000Z" });
      const undated = s.tasks.create({ title: "Undated", project_id: project.id });
      try {
        const row = s.projects.dashboard(NOW, SOON_END, 100).find((p) => p.id === project.id)!;
        expect(row).toMatchObject({ open_tasks: 6, overdue_tasks: 1, due_soon_tasks: 4, next_due_at: positive.due_at });
        expect(s.tasks.get(positive.id)?.due_at).toBe("2026-11-16T10:30:00+01:00");

        const bounds = { now: NOW, nextDay: SOON_END };
        expect(s.tasks.listCategory("overdue", bounds, 10, project.id).map((task) => task.id)).toEqual([positive.id]);
        expect(s.tasks.listCategory("today", bounds, 10, project.id).map((task) => task.id)).toEqual([
          ...equivalent.map((task) => task.id),
          negative.id,
        ]);
        const counts = s.tasks.counts(bounds, project.id);
        expect({ open: row.open_tasks, overdue: row.overdue_tasks, today: row.due_soon_tasks }).toEqual({
          open: counts.open,
          overdue: counts.overdue,
          today: counts.today,
        });
        expect(done.due_at).toBe("2026-11-16T08:00:00.000Z");
        expect(undated.due_at).toBeNull();
      } finally {
        s.db.run("DELETE FROM tal_tasks WHERE project_id = ?", project.id);
        s.projects.delete(project.id);
      }
    });
  });

  it("orders projects by chronological next due and keeps undated work last", async () => {
    await inAgent((agent) => {
      const s = agent.services;
      const first = s.projects.create({ name: "Chronologically first" });
      const second = s.projects.create({ name: "Chronologically second" });
      const undated = s.projects.create({ name: "Undated project" });
      const firstTask = s.tasks.create({ title: "Eleven UTC", project_id: first.id, due_at: "2026-11-16T12:00:00+01:00" });
      const secondTask = s.tasks.create({ title: "Noon UTC", project_id: second.id, due_at: "2026-11-16T04:00:00-08:00" });
      s.tasks.create({ title: "No due date", project_id: undated.id });
      try {
        const ids = [first.id, second.id, undated.id];
        const rows = s.projects.dashboard(NOW, SOON_END, 100).filter((project) => ids.includes(project.id));
        expect(rows.map((project) => project.id)).toEqual(ids);
        expect(rows.map((project) => project.next_due_at)).toEqual([firstTask.due_at, secondTask.due_at, null]);
      } finally {
        s.db.run("DELETE FROM tal_tasks WHERE project_id IN (?, ?, ?)", first.id, second.id, undated.id);
        for (const project of [first, second, undated]) s.projects.delete(project.id);
      }
    });
  });

  it("includes tasks due now but excludes tasks due exactly at the window end", async () => {
    await inAgent((agent) => {
      const s = agent.services;
      const project = s.projects.create({ name: "Dashboard boundaries" });
      const atNow = s.tasks.create({ title: "Due now", project_id: project.id, due_at: NOW });
      const beforeEnd = s.tasks.create({ title: "Before window end", project_id: project.id, due_at: "2026-11-24T09:59:59.999+00:00" });
      const atEnd = s.tasks.create({ title: "At window end", project_id: project.id, due_at: SOON_END });
      try {
        const row = s.projects.dashboard(NOW, SOON_END, 100).find((p) => p.id === project.id)!;
        expect(row).toMatchObject({ open_tasks: 3, overdue_tasks: 0, due_soon_tasks: 2, next_due_at: atNow.due_at });
        const counts = s.tasks.counts({ now: NOW, nextDay: SOON_END }, project.id);
        expect(counts).toMatchObject({ open: 3, overdue: 0, today: 2, upcoming: 1 });
        expect(s.tasks.listCategory("upcoming", { now: NOW, nextDay: SOON_END }, 10, project.id).map((task) => task.id)).toEqual([atEnd.id]);
        expect(beforeEnd.due_at).toBe("2026-11-24T09:59:59.999+00:00");
      } finally {
        s.db.run("DELETE FROM tal_tasks WHERE project_id = ?", project.id);
        s.projects.delete(project.id);
      }
    });
  });
});
