import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { z } from "zod";
import { fakeMcpServer } from "./mcp-helpers";

it("initializes, discovers, validates and calls MCP inside workerd", async () => {
  const fake = fakeMcpServer();
  const client = new Client({ name: "test", version: "1" }, { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL("https://mcp.example.com"), { fetch: fake.fetcher }));
    const { tools } = await client.listTools();
    const schema = z.fromJSONSchema(tools[0]!.inputSchema as Parameters<typeof z.fromJSONSchema>[0], { defaultTarget: "draft-2020-12" });
    expect(schema.safeParse({ text: "hi" }).success).toBe(true);
    expect(schema.safeParse({ text: 1 }).success).toBe(false);
    const result = await client.callTool({ name: "echo", arguments: { text: "hi" } });
    expect(result.content).toEqual([{ type: "text", text: '{"text":"hi"}' }]);
    expect(fake.calls).toEqual([{ name: "echo", args: { text: "hi" } }]);
  } finally {
    await client.close();
  }
});
