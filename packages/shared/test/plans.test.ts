import { describe, expect, it } from "vitest";
import { localDueSchema, taskPlanContentSchema } from "../src";

describe("task plan schemas", () => {
  it("accepts real local dates and rejects impossible ones", () => {
    for (const ok of ["2026-11-03", "2028-02-29", "2026-11-03T09:30", "2026-12-31T23:59"]) expect(localDueSchema.safeParse(ok).success).toBe(true);
    for (const bad of ["2026-02-29", "2026-13-01", "2026-04-31", "2026-11-03T24:00", "2026-11-03T10:60", "tomorrow", "2026-11-03Z"]) {
      expect(localDueSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("fills defaults and refuses duplicate task ids and empty plans", () => {
    const parsed = taskPlanContentSchema.parse({ title: "Trip", tasks: [{ client_id: "t1", title: "Pack", priority: "low" }] });
    expect(parsed).toEqual({
      title: "Trip",
      description: "",
      project: { mode: "none" },
      tasks: [{ client_id: "t1", title: "Pack", description: "", priority: "low", due: null, due_suggested: false }],
    });
    const task = { client_id: "t1", title: "A", priority: "low" };
    expect(taskPlanContentSchema.safeParse({ title: "x", tasks: [task, { ...task, title: "B" }] }).success).toBe(false);
    expect(taskPlanContentSchema.safeParse({ title: "x", tasks: [] }).success).toBe(false);
    expect(taskPlanContentSchema.safeParse({ title: "x", project: { mode: "new", name: " " }, tasks: [task] }).success).toBe(false);
  });
});
