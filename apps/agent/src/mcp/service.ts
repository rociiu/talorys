import { MCP_LIMITS, mcpConfigSchema, type McpConfig, type McpServerCreate, type McpServerPatch } from "@talorys/shared";
import type { Env } from "../env";
import { ValidationError } from "../api/errors";
import type { SettingsService } from "../services/settings";
import type { ActivityLog, UsageService } from "../services/usage";
import { ToolError } from "../tools/registry";
import type { McpRepository, ServerRow } from "./repository";
import { mcpUrlProblem } from "./endpoint";
import { callRemoteTool, discoverTools } from "./client";
import { discoveredRows } from "./discovery";
import { redactData, redactSecrets } from "./secrets";
import { shapeResult } from "./results";
import { mcpToolsForTurn } from "./tools";

export class McpService {
  fetcher: typeof fetch = fetch;
  private readonly refreshing = new Set<string>();
  private readonly allowLocal: boolean;
  constructor(
    readonly repository: McpRepository,
    private readonly settings: SettingsService,
    private readonly activity: ActivityLog,
    private readonly usage: UsageService,
    env: Env,
    private readonly background: (work: Promise<unknown>) => void = () => {},
  ) {
    this.allowLocal = env.TALORYS_ENV === "development";
  }
  config(): McpConfig {
    const parsed = mcpConfigSchema.safeParse(this.settings.getJson("mcp.config") ?? {});
    return parsed.success ? parsed.data : mcpConfigSchema.parse({});
  }
  setConfig(patch: Partial<McpConfig>): McpConfig {
    const config = mcpConfigSchema.parse({ ...this.config(), ...patch });
    this.settings.setJson("mcp.config", config);
    return config;
  }
  list() {
    return this.repository.list().map((s) => this.repository.view(s.id));
  }
  private endpoint(raw: string): string {
    const problem = mcpUrlProblem(raw, { allowLocal: this.allowLocal });
    if (problem) throw new ValidationError(problem);
    const url = new URL(raw);
    url.hash = "";
    return url.href;
  }
  async add(input: McpServerCreate) {
    if (this.repository.list().length >= MCP_LIMITS.servers) throw new ValidationError("MCP server limit reached.");
    const server = this.repository.create({ ...input, url: this.endpoint(input.url) });
    this.activity.record("mcp.server_added", "MCP server added");
    return this.refresh(server.id);
  }
  async update(id: string, patch: McpServerPatch) {
    const before = this.repository.get(id);
    const next = this.repository.update(id, { ...patch, ...(patch.url ? { url: this.endpoint(patch.url) } : {}) });
    this.activity.record("mcp.server_updated", "MCP server updated");
    if (before.url !== next.url || before.transport !== next.transport) {
      this.repository.clearTools(id);
      return this.refresh(id);
    }
    return this.repository.view(id);
  }
  remove(id: string): void {
    this.repository.delete(id);
    this.activity.record("mcp.server_removed", "MCP server removed");
  }
  async test(id: string) {
    try {
      const s = this.repository.get(id);
      const { info } = await discoverTools(s, this.fetcher, undefined, this.allowLocal);
      const safeInfo = info ? { name: this.redact(info.name).slice(0, 80), version: this.redact(info.version).slice(0, 80) } : undefined;
      this.repository.setStatus(id, null, safeInfo);
      return { ok: true, server_info: safeInfo };
    } catch {
      this.repository.setStatus(id, "MCP connection failed.");
      return { ok: false, error: "MCP connection failed." };
    }
  }
  async refresh(id: string) {
    const s = this.repository.get(id);
    const secrets = this.secrets();
    try {
      const { tools, info } = await discoverTools(s, this.fetcher, undefined, this.allowLocal);
      // Third-party text can reflect the authentication header. Redact before persistence.
      const safe = redactData(tools, [...secrets, ...this.secrets()]) as typeof tools;
      const rows = await discoveredRows(s, safe);
      if (!this.sameEndpoint(s)) return this.repository.view(id);
      this.repository.replaceTools(id, rows);
      this.repository.setStatus(
        id,
        null,
        info ? { name: this.redact(info.name).slice(0, 80), version: this.redact(info.version).slice(0, 80) } : undefined,
      );
      this.activity.record("mcp.tools_refreshed", "MCP tools refreshed");
    } catch {
      if (this.sameEndpoint(s)) this.repository.setStatus(id, "MCP connection failed.");
    }
    return this.repository.view(id);
  }
  private sameEndpoint(s: ServerRow): boolean {
    try {
      const current = this.repository.get(s.id);
      return current.url === s.url && current.transport === s.transport && current.auth_header_value === s.auth_header_value;
    } catch {
      return false;
    }
  }
  refreshStaleInBackground(): void {
    for (const s of this.repository.list()) {
      if (!s.enabled || this.refreshing.has(s.id) || (s.tools_refreshed_at && Date.now() - Date.parse(s.tools_refreshed_at) <= 86400_000)) continue;
      this.refreshing.add(s.id);
      this.background(
        this.refresh(s.id)
          .catch(() => {})
          .finally(() => this.refreshing.delete(s.id)),
      );
    }
  }
  private secrets(): string[] {
    return this.repository.list().flatMap((s) => (s.auth_header_value ? [s.auth_header_value] : []));
  }
  redact(text: string): string {
    return redactSecrets(text, this.secrets());
  }
  async call(id: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const s = this.repository.get(id);
    const t = this.repository.listTools(id).find((t) => t.name === name);
    if (!s.enabled || !t || t.status !== "ok" || t.policy === "off") throw new ToolError("MCP tool is unavailable.");
    if (!this.repository.reserveCall(id)) throw new ToolError("MCP server daily call limit reached.");
    this.activity.record("mcp.call", this.redact(`${s.name}: ${name}`));
    const secrets = this.secrets();
    try {
      const result = await callRemoteTool(s, name, args, this.fetcher, signal, this.allowLocal);
      const safe = redactData(result, [...secrets, ...this.secrets()]) as Record<string, unknown>;
      return shapeResult(safe, this.redact(s.name), this.redact(name), this.config().maxResultChars);
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError("MCP call failed or was cancelled.");
    }
  }
  recordApprovedCall(): void {
    this.usage.increment({ tool_calls: 1 });
  }
  toolsForApproval() {
    return mcpToolsForTurn(this, { approval: true });
  }
}
