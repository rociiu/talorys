import { describe, expect, it } from "vitest";
import { inAgent } from "./helpers";
import { parseLocalDateTime } from "../src/services/time";
import { ALL_TOOLS, ToolExecutor } from "../src/tools";

const impossibleDates = [
  "2026-02-30T12:00Z",
  "2026-02-29T12:00:00+05:30",
  "1900-02-29T01:00-04:00",
  "2026-04-31T23:59:59.999Z",
  "0001-02-29T00:00Z",
];

describe("task due dates with explicit offsets", () => {
  it.each(impossibleDates)("rejects %s without creating or changing a task", async (due) => {
    expect(parseLocalDateTime(due, "UTC")).toBeNull();
    await inAgent(async (agent) => {
      const s = agent.services;
      const title = `invalid due ${crypto.randomUUID()}`;
      const original = s.tasks.create({ title: `keep ${title}`, due_at: "2026-06-15T12:00:00.000Z" });
      const ex = new ToolExecutor(ALL_TOOLS, { services: s, timezone: "UTC", mode: "chat" }, { maxToolCalls: 2 });
      await expect(ex.execute("create_task", { title, due })).rejects.toThrow(/Could not understand the date/);
      expect(s.tasks.list({ q: title }).map((task) => task.id)).toEqual([original.id]);
      await expect(ex.execute("update_task", { task: original.id, due })).rejects.toThrow(/Could not understand the date/);
      expect(s.tasks.get(original.id)?.due_at).toBe(original.due_at);
    });
  });

  it.each([
    "2024-02-29T23:45:12.123+05:30",
    "2000-02-29T00:00Z",
    "0000-02-29T00:00Z",
    "0099-12-31T23:59:59.999-12:00",
    "2026-01-01T00:15+14:00",
    "2026-01-01T24:00Z",
  ])("preserves valid offset timestamp %s", (due) => {
    expect(parseLocalDateTime(due, "America/New_York")).toBe(new Date(due).toISOString());
  });
});
