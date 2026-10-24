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

  it("keeps a checkbox inside a sample that shows another fence, and still toggles the task after it", () => {
    const sample = ["- [ ] before", "```markdown", "- [ ] example", "~~~", "- [ ] still an example", "```", "- [ ] after"].join("\n");
    expect(taskStats(sample)).toEqual({ done: 0, total: 2 });
    expect(toggleTaskLine(sample, 2)).toBe(sample);
    expect(toggleTaskLine(sample, 4)).toBe(sample);
    expect(toggleTaskLine(sample, 6).split("\n")[6]).toBe("- [x] after");
  });

  it("keeps an inner fence inside a longer code sample", () => {
    const sample = ["````markdown", "```js", "- [ ] example in the sample", "```", "````", "- [ ] after"].join("\n");
    expect(taskStats(sample)).toEqual({ done: 0, total: 1 });
    expect(toggleTaskLine(sample, 2)).toBe(sample);
    expect(toggleTaskLine(sample, 5).split("\n")[5]).toBe("- [x] after");
  });
});
