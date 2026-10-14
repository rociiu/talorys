import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import type { ServerRow } from "./repository";
import { mcpUrlProblem } from "./endpoint";

export function guardedFetch(fetcher: typeof fetch, allowLocal: boolean, signal?: AbortSignal): typeof fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (mcpUrlProblem(url, { allowLocal })) throw new Error("Unsafe MCP endpoint.");
    const signals = [AbortSignal.timeout(20_000), signal, init?.signal, input instanceof Request ? input.signal : undefined].filter(
      (s): s is AbortSignal => !!s,
    );
    const response = await fetcher(input, { ...init, redirect: "manual", signal: AbortSignal.any(signals) });
    if (response.status >= 300 && response.status < 400) throw new Error("MCP redirects are refused.");
    if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) throw new Error("MCP response is too large.");
    if (!response.body) return response;
    return new Response(response.body.pipeThrough(byteLimit(MAX_RESPONSE_BYTES)), response);
  };
}

const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Errors the stream once more than `max` bytes pass: a response without Content-Length is not read in full. */
function byteLimit(max: number): TransformStream<Uint8Array, Uint8Array> {
  let total = 0;
  return new TransformStream({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > max) controller.error(new Error("MCP response is too large."));
      else controller.enqueue(chunk);
    },
  });
}

export async function withMcpClient<T>(
  endpoint: ServerRow,
  fetcher: typeof fetch,
  signal: AbortSignal | undefined,
  allowLocal: boolean,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ name: "talorys", version: "1" }, { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() });
  const headers = endpoint.auth_header_name && endpoint.auth_header_value ? { [endpoint.auth_header_name]: endpoint.auth_header_value } : {};
  const connecting = new AbortController();
  const lifecycle = AbortSignal.any([connecting.signal, ...(signal ? [signal] : [])]);
  const timeout = setTimeout(() => connecting.abort(), 5000);
  const options = { fetch: guardedFetch(fetcher, allowLocal, lifecycle), requestInit: { headers } };
  const transport =
    endpoint.transport === "sse"
      ? new SSEClientTransport(new URL(endpoint.url), options)
      : new StreamableHTTPClientTransport(new URL(endpoint.url), options);
  try {
    await client.connect(transport, { timeout: 5000, signal: lifecycle });
    clearTimeout(timeout);
    return await fn(client);
  } finally {
    clearTimeout(timeout);
    await client.close();
  }
}

export async function discoverTools(endpoint: ServerRow, fetcher: typeof fetch, signal?: AbortSignal, allowLocal = false) {
  const budget = AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]);
  return withMcpClient(endpoint, fetcher, budget, allowLocal, async (client) => {
    const tools = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, { timeout: 10_000, signal: budget });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor && tools.length < 40);
    return { tools: tools.slice(0, 40), info: client.getServerVersion() };
  });
}
export async function callRemoteTool(
  endpoint: ServerRow,
  name: string,
  args: Record<string, unknown>,
  fetcher: typeof fetch,
  signal?: AbortSignal,
  allowLocal = false,
) {
  return withMcpClient(endpoint, fetcher, signal, allowLocal, (client) =>
    client.callTool({ name, arguments: args }, undefined, { timeout: 15_000, signal }),
  );
}
