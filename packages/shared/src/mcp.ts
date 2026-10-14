import { z } from "zod";

export const MCP_LIMITS = {
  servers: 10,
  toolsPerServer: 40,
  toolsPerTurn: 25,
  descriptionChars: 1000,
  schemaBytes: 8192,
  titleChars: 80,
  maxCallsPerTurn: 10,
  maxCallsPerDay: 500,
  maxResultChars: 20000,
} as const;
export const mcpPolicySchema = z.enum(["off", "auto", "approve"]);
export type McpToolPolicy = z.infer<typeof mcpPolicySchema>;
export const mcpAuthSchema = z.object({
  header: z
    .string()
    .regex(/^[A-Za-z0-9-]{1,64}$/)
    .default("Authorization"),
  value: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[^\r\n\0]*$/),
});
export const mcpServerCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  url: z.string().url().max(2048),
  transport: z.enum(["streamable-http", "sse"]).default("streamable-http"),
  auth: mcpAuthSchema.optional(),
});
export const mcpServerPatchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  url: z.string().url().max(2048).optional(),
  transport: z.enum(["streamable-http", "sse"]).optional(),
  auth: mcpAuthSchema.nullable().optional(),
  enabled: z.boolean().optional(),
  max_calls_per_day: z.number().int().min(1).max(MCP_LIMITS.maxCallsPerDay).optional(),
});
export const mcpConfigSchema = z.object({
  maxCallsPerTurn: z.number().int().min(0).max(MCP_LIMITS.maxCallsPerTurn).default(3),
  maxResultChars: z.number().int().min(1).max(MCP_LIMITS.maxResultChars).default(8000),
});
export const mcpConfigPatchSchema = z.object({
  maxCallsPerTurn: z.number().int().min(0).max(MCP_LIMITS.maxCallsPerTurn).optional(),
  maxResultChars: z.number().int().min(1).max(MCP_LIMITS.maxResultChars).optional(),
});
export type McpConfig = z.infer<typeof mcpConfigSchema>;
export type McpServerCreate = z.infer<typeof mcpServerCreateSchema>;
export type McpServerPatch = z.infer<typeof mcpServerPatchSchema>;
export interface McpToolView {
  name: string;
  title: string | null;
  description: string;
  policy: McpToolPolicy;
  status: "ok" | "unsupported_schema" | "name_conflict" | "missing";
  read_only: boolean;
  destructive: boolean;
}
export interface McpServerView {
  id: string;
  name: string;
  slug: string;
  url: string;
  transport: "streamable-http" | "sse";
  auth: { header: string } | null;
  enabled: boolean;
  max_calls_per_day: number;
  calls_today: number;
  status: "unknown" | "ok" | "error";
  last_error: string | null;
  last_ok_at: string | null;
  tools_refreshed_at: string | null;
  server_info: { name: string; version: string } | null;
  created_at: string;
  updated_at: string;
  tools: McpToolView[];
}
