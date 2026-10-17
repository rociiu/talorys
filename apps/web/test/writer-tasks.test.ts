import { describe, expect, it } from "vitest";
import { taskStats, toggleTaskLine } from "../src/components/WriterEditor";

const note = ["- [x] real done", "- [ ] real open", "```md", "- [ ] example in code", "- [x] another example", "```", "- [ ] after the fence"].join("\n");

describe("todos in fenced code blocks", () => {
  it("are not counted as todos", () => {
    expect(taskStats(note)).toEqual({ done: 1, total: 3 });
    expect(taskStats("~~~\n- [ ] a\n~~~")).toEqual({ done: 0, total: 0 });
  });

  it("are not toggled, while real todos around them are", () => {
    expect(toggleTaskLine(note, 3)).toBe(note);
    expect(toggleTaskLine(note, 1).split("\n")[1]).toBe("- [x] real open");
    expect(toggleTaskLine(note, 6).split("\n")[6]).toBe("- [x] after the fence");
  });
});
