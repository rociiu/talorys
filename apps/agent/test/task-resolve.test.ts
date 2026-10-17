import { describe, expect, it } from "vitest";
import { inAgent } from "./helpers";

describe("resolving a task by title", () => {
  it("prefers the task whose title equals the reference over titles that contain it", async () => {
    await inAgent((agent) => {
      const tasks = agent.services.tasks;
      const short = tasks.create({ title: "Call Sam" });
      tasks.create({ title: "Call Sam about lunch" });
      expect(tasks.resolve("call sam")?.id).toBe(short.id);
      expect(tasks.resolve("  Call Sam  ")?.id).toBe(short.id);
    });
  });

  it("is still ambiguous when several tasks share the exact title or only contain the reference", async () => {
    await inAgent((agent) => {
      const tasks = agent.services.tasks;
      tasks.create({ title: "Pay rent" });
      tasks.create({ title: "Pay rent" });
      tasks.create({ title: "Book dentist today" });
      tasks.create({ title: "Book dentist tomorrow" });
      expect(tasks.resolve("Pay rent")).toBeNull();
      expect(tasks.resolve("Book dentist")).toBeNull();
      expect(tasks.resolve("dentist today")?.title).toBe("Book dentist today");
    });
  });
});
