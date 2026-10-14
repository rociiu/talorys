import { expect, it } from "vitest";
import { shapeResult } from "../src/mcp/results";

it("wraps external data, omits non-text and bounds results", () => {
  const result = JSON.parse(
    shapeResult(
      {
        content: [
          { type: "text", text: "hello" },
          { type: "image", data: "not-a-text-result" },
        ],
        structuredContent: { saved: true },
      },
      "s",
      "t",
      200,
    ),
  );
  expect(result).toEqual({ source: "external_tool", server: "s", tool: "t", content: 'hello\n[non-text content omitted]\n{"saved":true}' });
  const truncated = JSON.parse(shapeResult({ content: [{ type: "text", text: "x".repeat(20) }] }, "s", "t", 10));
  expect(truncated).toMatchObject({ content: "x".repeat(10), truncated: true });
});
it("reports upstream tool errors as bounded ToolError text", () => {
  expect(() => shapeResult({ isError: true, content: [{ type: "text", text: "denied" }] }, "s", "t", 100)).toThrow("External tool failed: denied");
});
