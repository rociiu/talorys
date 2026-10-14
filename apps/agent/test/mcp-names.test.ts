import { expect, it } from "vitest";
import { ALL_TOOLS } from "../src/tools";
import { clampDescription, providerToolName, slugFor } from "../src/mcp/names";
import { discoveredRows } from "../src/mcp/discovery";
import { inAgent } from "./helpers";
import { addFake } from "./mcp-helpers";

it("namespaces, sanitizes, limits and disambiguates names", () => {
  expect(ALL_TOOLS.some((t) => t.name.startsWith("mcp_"))).toBe(false);
  expect(providerToolName("foo", "a.b c")).toBe("mcp_foo_a_b_c");
  expect(providerToolName("foo", "x".repeat(60))).toBeNull();
  expect(slugFor("A! B", new Set(["ab"]))).toBe("ab2");
  expect(slugFor("!!!", new Set())).toBe("server");
  expect(clampDescription("x".repeat(1001))).toHaveLength(1000);
});
it("stores colliding and overlong names as unavailable", async () =>
  inAgent(async (a) => {
    const { server } = await addFake(a.services);
    const rows = await discoveredRows(
      a.services.mcp.repository.get(server.id),
      ["a.b", "a b", "x".repeat(70)].map((name) => ({ name, inputSchema: { type: "object" } })),
    );
    expect(rows.map((r) => r.status)).toEqual(["name_conflict", "name_conflict", "name_conflict"]);
  }));
it("skips tool names the MCP spec does not allow instead of storing them", async () =>
  inAgent(async (a) => {
    const { server } = await addFake(a.services);
    const listed = ["ok", "", "y".repeat(129), "bad\nname"].map((name) => ({ name, inputSchema: { type: "object" as const } }));
    const rows = await discoveredRows(a.services.mcp.repository.get(server.id), listed);
    expect(rows.map((r) => r.name)).toEqual(["ok"]);
  }));
