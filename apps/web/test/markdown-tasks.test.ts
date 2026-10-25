import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { taskComponents } from "../src/components/Markdown";

type Li = (props: Record<string, unknown>) => ReactElement<{ onClick?: (e: unknown) => void }>;

const taskItem = (line: number) => ({
  className: "task-list-item",
  node: { position: { start: { line } }, children: [] },
});

describe("task checkboxes in the preview", () => {
  it("toggle only the nested task that was clicked, not its parent task", () => {
    const onToggle = vi.fn();
    const li = taskComponents(onToggle).li as unknown as Li;
    // "- [ ] parent\n  - [ ] child": the click bubbles from the child's checkbox through both list items.
    const parent = li(taskItem(1));
    const child = li(taskItem(2));
    const childLi = { tagName: "LI" };
    const parentLi = { tagName: "LI" };
    const checkbox = { tagName: "INPUT", closest: () => childLi };
    child.props.onClick?.({ target: checkbox, currentTarget: childLi });
    parent.props.onClick?.({ target: checkbox, currentTarget: parentLi });
    expect(onToggle.mock.calls).toEqual([[1]]);
  });
});
