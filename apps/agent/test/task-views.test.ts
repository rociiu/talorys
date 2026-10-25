import { describe, expect, it } from "vitest";
import { localDayBounds } from "../src/services/time";
import { inAgent } from "./helpers";

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
