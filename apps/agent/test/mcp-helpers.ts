import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { Services } from "../src/services/container";
import { mcpServerCreateSchema } from "@talorys/shared";
import { mcpToolsForTurn } from "../src/mcp/tools";
import { ToolExecutor } from "../src/tools";

export interface FakeTool {
  name: string;
  description?: string;
  readOnly?: boolean;
  destructive?: boolean;
  input?: Record<string, z.ZodType>;
  result?: string;
  isError?: boolean;
}
export function fakeMcpServer(opts: { tools?: FakeTool[]; requireHeader?: [string, string]; failWith?: number; hang?: boolean } = {}) {
  const calls: { name: string; args: unknown }[] = [];
  const headers: Headers[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    headers.push(request.headers);
    if (opts.requireHeader && request.headers.get(opts.requireHeader[0]) !== opts.requireHeader[1])
      return new Response("Unauthorized", { status: 401 });
    if (opts.failWith) return new Response("upstream failed", { status: opts.failWith });
    if (opts.hang)
      return new Promise<Response>((_resolve, reject) => {
        if (request.signal.aborted) reject(request.signal.reason);
        request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
      });
    const server = new McpServer({ name: "fake", version: "1" });
    for (const tool of opts.tools ?? [{ name: "echo", readOnly: true }]) register(server, tool, calls);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(request);
  };
  return { fetcher, calls, headers };
}
function register(server: McpServer, tool: FakeTool, calls: { name: string; args: unknown }[]) {
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: tool.input ?? { text: z.string() },
      annotations: { readOnlyHint: tool.readOnly, destructiveHint: tool.destructive },
    },
    async (args) => {
      calls.push({ name: tool.name, args });
      return { content: [{ type: "text", text: tool.result ?? JSON.stringify(args) }], isError: tool.isError };
    },
  );
}
export async function addFake(s: Services, opts: Parameters<typeof fakeMcpServer>[0] = {}, name = "fake") {
  // Tests share one agent: start from no servers, so slugs (and tool names) are predictable.
  for (const existing of s.mcp.repository.list()) s.mcp.repository.delete(existing.id);
  const fake = fakeMcpServer(opts);
  s.mcp.fetcher = fake.fetcher;
  const server = await s.mcp.add(
    mcpServerCreateSchema.parse({
      name,
      url: "https://mcp.example.com/mcp",
      ...(opts.requireHeader ? { auth: { header: opts.requireHeader[0], value: opts.requireHeader[1] } } : {}),
    }),
  );
  return { ...fake, server };
}
export function executor(s: Services, mode: "chat" | "scheduled" = "chat", signal?: AbortSignal) {
  const conversation = s.conversations.create();
  return new ToolExecutor(
    mcpToolsForTurn(s.mcp, { signal }),
    { services: s, timezone: "UTC", mode, conversationId: conversation.id, signal },
    { maxToolCalls: 10 },
  );
}
