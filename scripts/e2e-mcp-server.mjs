import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const lines = [];
function serverForRequest() {
  const server = new McpServer({ name: "e2e", version: "1" });
  server.registerTool("echo", { inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } }, async ({ text }) => ({
    content: [{ type: "text", text }],
  }));
  server.registerTool("append_log", { inputSchema: { line: z.string() } }, async ({ line }) => {
    lines.push(line);
    return { content: [{ type: "text", text: `Appended ${line}; ${lines.length} line(s)` }] };
  });
  return server;
}
const http = createServer(async (req, res) => {
  if (req.url !== "/mcp") {
    res.writeHead(404).end();
    return;
  }
  const server = serverForRequest();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch {
    if (!res.headersSent) res.writeHead(500).end();
  }
});
http.listen(8790, "127.0.0.1");
process.on("SIGTERM", () => http.close());
process.on("SIGINT", () => http.close());
