import { ToolError } from "../tools/registry";

export function shapeResult(result: Record<string, unknown>, server: string, tool: string, max: number): string {
  const blocks = Array.isArray(result.content) ? result.content : [];
  const text = blocks
    .map((b: unknown) => {
      if (b && typeof b === "object" && "type" in b && b.type === "text" && "text" in b && typeof b.text === "string") return b.text;
      return "[non-text content omitted]";
    })
    .join("\n");
  const content = [text, result.structuredContent === undefined ? "" : JSON.stringify(result.structuredContent)].filter(Boolean).join("\n");
  if (result.isError) throw new ToolError(`External tool failed: ${content.slice(0, Math.min(max, 300))}`);
  return JSON.stringify({
    source: "external_tool",
    server,
    tool,
    content: content.slice(0, max),
    ...(content.length > max ? { truncated: true } : {}),
  });
}
