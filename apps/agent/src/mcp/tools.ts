import { MCP_LIMITS } from "@talorys/shared";
import { z } from "zod";
import type { ToolDefinition } from "../tools/registry";
import { ToolError } from "../tools/registry";
import type { Services } from "../services/container";
import type { McpService } from "./service";
import type { ServerRow, ToolRow } from "./repository";
import { providerToolName } from "./names";

export function mcpToolsForTurn(mcp: McpService, options: { signal?: AbortSignal; approval?: boolean } = {}): ToolDefinition[] {
  let calls = 0;
  const reserve = () => {
    if (!options.approval && calls >= mcp.config().maxCallsPerTurn) throw new ToolError("MCP per-turn call limit reached.");
    calls++;
  };
  const definitions: ToolDefinition[] = [];
  for (const server of mcp.repository.list()) {
    for (const tool of mcp.repository.listTools(server.id)) {
      if (!options.approval && (!server.enabled || tool.policy === "off" || tool.status !== "ok")) continue;
      const name = providerToolName(server.slug, tool.name);
      if (!name) continue;
      const definition = makeDefinition(mcp, server, tool, name, reserve, options);
      if (definition) definitions.push(definition);
    }
  }
  return options.approval ? definitions : definitions.slice(0, MCP_LIMITS.toolsPerTurn);
}
function makeDefinition(
  mcp: McpService,
  s: ServerRow,
  t: ToolRow,
  name: string,
  reserve: () => void,
  options: { signal?: AbortSignal; approval?: boolean },
): ToolDefinition | null {
  let input: z.ZodType;
  try {
    input = z.fromJSONSchema(JSON.parse(t.input_schema), { defaultTarget: "draft-2020-12" });
  } catch {
    mcp.repository.setToolStatus(s.id, t.name, "unsupported_schema");
    return null;
  }
  const base = {
    name,
    description: `[External: ${s.name}] ${t.description}`,
    input,
    maxCallsPerTurn: 2,
    label: () => `Using ${s.name}: ${t.title ?? t.name}`,
  };
  if (t.policy === "auto" && !options.approval)
    return {
      ...base,
      permission: "write",
      execute: (args, ctx) => {
        reserve();
        return mcp.call(s.id, t.name, args as Record<string, unknown>, ctx.signal ?? options.signal);
      },
    };
  return {
    ...base,
    permission: "destructive",
    prepare: (args) => {
      reserve();
      return {
        targetId: `${s.id}/${t.name}`,
        summary: `Call ${s.name} → ${t.name}`,
        payload: { args },
        preview: mcp.redact(JSON.stringify(args, null, 2)),
      };
    },
    snapshot: (targetId) => {
      if (targetId !== `${s.id}/${t.name}`) return null;
      try {
        const server = mcp.repository.get(s.id);
        const tool = mcp.repository.listTools(s.id).find((row) => row.name === t.name);
        if (!tool) return null;
        return [
          server.url,
          server.transport,
          server.auth_header_name,
          server.enabled,
          tool.policy,
          tool.schema_hash,
          tool.description,
          server.auth_header_value,
        ];
      } catch {
        return null;
      }
    },
    commit: async (targetId, ctx, payload) => {
      if (targetId !== `${s.id}/${t.name}`) throw new ToolError("MCP target is unavailable.");
      const parsed = z.object({ args: input }).parse(payload);
      mcp.recordApprovedCall();
      return mcp.call(s.id, t.name, parsed.args as Record<string, unknown>, ctx.signal);
    },
  };
}
export function safeMcpTools(services: Services, signal?: AbortSignal): ToolDefinition[] {
  try {
    services.mcp.refreshStaleInBackground();
    return mcpToolsForTurn(services.mcp, { signal });
  } catch {
    return [];
  }
}
