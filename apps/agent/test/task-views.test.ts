import type { TaskCategoryPage, TodayOverview } from "@talorys/shared";
import { describe, expect, it } from "vitest";
import { localDayBounds } from "../src/services/time";
import { client, inAgent, loggedIn } from "./helpers";

describe("task views", () => {
  it("keeps an in-progress task with no due date in today and out of upcoming", async () => {
    await inAgent((agent) => {
      const s = agent.services;
      const id = crypto.randomUUID();
      const bounds = localDayBounds(s.settings.get().timezone);
      const writing = s.tasks.create({ title: `Writing ${id}`, status: "in_progress" });
      const someday = s.tasks.create({ title: `Someday ${id}` });
      const later = s.tasks.create({ title: `Later ${id}`, status: "in_progress", due_at: "2099-01-01T15:00:00.000Z" });
      const ids = (view: "today" | "upcoming") => s.tasks.list({ view, q: id, dayEnd: bounds.end, limit: 10 }).map((task) => task.id);

      const today = ids("today");
      const upcoming = ids("upcoming");
      expect(today).toContain(writing.id);
      expect(today).not.toContain(someday.id);
      expect(today).not.toContain(later.id);
      expect(upcoming).not.toContain(writing.id);
      expect(upcoming).toContain(someday.id);
      expect(upcoming).toContain(later.id);
    });
  });
});

it("matches the dashboard at the API boundary and recalculates when the owner changes timezone", async () => {
  const at = new Date();
  const zones = ["UTC", "Pacific/Kiritimati"];
  const ordered = zones.map((zone) => ({ zone, end: Date.parse(localDayBounds(zone, at).end) })).sort((a, b) => a.end - b.end);
  const [early, late] = ordered as [typeof ordered[number], typeof ordered[number]];
  const due = new Date((early.end + late.end) / 2).toISOString();
  const { task, previous } = await inAgent((agent) => {
    const s = agent.services;
    return { task: s.tasks.create({ title: "Different local day", due_at: due }), previous: s.settings.get().timezone };
  });
  try {
    expect((await client().call("/api/tasks/categories")).status).toBe(401);
    const c = await loggedIn();
    for (const [zone, category] of [[early.zone, "upcoming"], [late.zone, "today"]] as const) {
      expect((await c.call("/api/settings", { method: "PATCH", body: { timezone: zone } })).status).toBe(200);
      const overview = await c.json<TodayOverview>("/api/today");
      const list = await c.json<TaskCategoryPage>(`/api/tasks/categories?category=${category}`);
      expect(overview.timezone).toBe(zone);
      expect(list.counts).toMatchObject(overview.counts);
      expect(list.tasks.map((t) => t.id)).toContain(task.id);
      const other = await c.json<TaskCategoryPage>(`/api/tasks/categories?category=${category === "upcoming" ? "today" : "upcoming"}`);
      expect(other.tasks.map((t) => t.id)).not.toContain(task.id);
    }
  } finally {
    await inAgent((agent) => {
      agent.services.tasks.delete(task.id);
      agent.services.settings.update({ timezone: previous });
    });
  }
});
