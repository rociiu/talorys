import type { Task } from "@talorys/shared";
import { describe, expect, it } from "vitest";
import { buildToday, compareFocusTasks } from "../src/services/today";
import { client, inAgent, loggedIn } from "./helpers";

function task(patch: Partial<Task> & Pick<Task, "id" | "title">): Task {
  return {
    description: "",
    status: "todo",
    priority: "medium",
    due_at: null,
    project_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    completed_at: null,
    ...patch,
  };
}

describe("Today focus sorting", () => {
  it("uses urgency, priority, status and creation time without inventing scores", () => {
    const now = "2026-06-15T12:00:00.000Z";
    const end = "2026-06-16T00:00:00.000Z";
    const tasks = [
      task({ id: "later", title: "Later", due_at: "2026-06-20T12:00:00.000Z", priority: "urgent" }),
      task({ id: "undated", title: "Undated", priority: "urgent" }),
      task({ id: "today-low", title: "Today low", due_at: "2026-06-15T18:00:00.000Z", priority: "low" }),
      task({ id: "overdue", title: "Overdue", due_at: "2026-06-14T18:00:00.000Z", priority: "low" }),
      task({ id: "today-urgent", title: "Today urgent", due_at: "2026-06-15T17:00:00.000Z", priority: "urgent" }),
      task({ id: "started", title: "Started", due_at: "2026-06-15T17:00:00.000Z", priority: "urgent", status: "in_progress" }),
    ];
    expect(tasks.sort((a, b) => compareFocusTasks(a, b, now, end)).map((t) => t.id)).toEqual([
      "overdue",
      "started",
      "today-urgent",
      "today-low",
      "later",
      "undated",
    ]);
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
    expect(await res.json()).toMatchObject({ counts: {}, focus: [], tasks: {}, projects: [], automations: [] });
    await inAgent((agent) => agent.services.db.run(`DELETE FROM tal_usage_daily`));
  });
});
