import { expect, it } from "vitest";
import { mcpConfigPatchSchema, mcpServerCreateSchema, mcpServerPatchSchema } from "../src/mcp";
import { toolActivitySchema } from "../src/schemas";

it("MCP patches preserve omitted fields rather than filling defaults", () => {
  expect(mcpServerPatchSchema.parse({ enabled: false })).toEqual({ enabled: false });
  expect(mcpConfigPatchSchema.parse({ maxResultChars: 100 })).toEqual({ maxResultChars: 100 });
  expect(mcpServerCreateSchema.parse({ name: "s", url: "https://mcp.example.com", auth: { value: "secret" } })).toMatchObject({
    transport: "streamable-http",
    auth: { header: "Authorization" },
  });
});
it("rejects injected headers and preserves approved result data", () => {
  expect(mcpServerCreateSchema.safeParse({ name: "s", url: "https://mcp.example.com", auth: { value: "secret\r\nInjected: yes" } }).success).toBe(
    false,
  );
  const activity = toolActivitySchema.parse({
    id: "call",
    name: "mcp_s_t",
    label: "Using s",
    status: "success",
    approval: { id: "action", summary: "Call s", status: "approved", error: null, expires_at: "now", result: "saved" },
  });
  expect(activity.approval?.result).toBe("saved");
});
