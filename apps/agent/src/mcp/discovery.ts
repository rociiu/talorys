import { MCP_LIMITS } from "@talorys/shared";
import { z } from "zod";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { now } from "../db/database";
import { clampDescription, providerToolName, schemaHash } from "./names";
import type { ServerRow, ToolRow } from "./repository";

export async function discoveredRows(server: ServerRow, listed: Tool[]): Promise<ToolRow[]> {
  // The MCP spec allows 1-128 characters; anything else is skipped rather than stored or shown.
  const tools = listed.filter((t) => /^[^\p{Cc}]{1,128}$/u.test(t.name));
  const names = tools.map((t) => providerToolName(server.slug, t.name));
  return Promise.all(
    tools.slice(0, MCP_LIMITS.toolsPerServer).map(async (t, i) => {
      const schema = JSON.stringify(t.inputSchema);
      let status: ToolRow["status"] = "ok";
      if (!names[i] || names.filter((n) => n === names[i]).length > 1) status = "name_conflict";
      if (new TextEncoder().encode(schema).length > MCP_LIMITS.schemaBytes || !supportedSchema(t.inputSchema)) status = "unsupported_schema";
      const readOnly = t.annotations?.readOnlyHint === true;
      const destructive = t.annotations?.destructiveHint !== false;
      return {
        server_id: server.id,
        name: t.name,
        title: t.title?.slice(0, MCP_LIMITS.titleChars) ?? null,
        description: clampDescription(t.description ?? ""),
        input_schema: status === "unsupported_schema" ? "{}" : schema,
        schema_hash: await schemaHash(t.inputSchema),
        read_only: Number(readOnly),
        destructive: Number(destructive),
        policy: readOnly && t.annotations?.destructiveHint !== true ? "auto" : "approve",
        status,
        seen_at: now(),
      };
    }),
  );
}
function supportedSchema(schema: unknown): boolean {
  try {
    z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0], { defaultTarget: "draft-2020-12" });
    return true;
  } catch {
    return false;
  }
}
