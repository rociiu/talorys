import type { McpServerCreate, McpServerPatch, McpServerView, McpToolPolicy, McpToolView } from "@talorys/shared";
import { type Database, newId, now } from "../db/database";
import { NotFoundError } from "../api/errors";
import { slugFor } from "./names";

export interface ServerRow {
  id: string;
  name: string;
  slug: string;
  url: string;
  transport: "streamable-http" | "sse";
  auth_header_name: string | null;
  auth_header_value: string | null;
  enabled: number;
  max_calls_per_day: number;
  calls_day: string | null;
  calls_today: number;
  status: "unknown" | "ok" | "error";
  last_error: string | null;
  last_ok_at: string | null;
  tools_refreshed_at: string | null;
  server_info: string | null;
  created_at: string;
  updated_at: string;
}
export interface ToolRow {
  server_id: string;
  name: string;
  title: string | null;
  description: string;
  input_schema: string;
  schema_hash: string;
  read_only: number;
  destructive: number;
  policy: McpToolPolicy;
  status: McpToolView["status"];
  seen_at: string;
}

export class McpRepository {
  constructor(private readonly db: Database) {}
  list(): ServerRow[] {
    return this.db.all<ServerRow>("SELECT * FROM tal_mcp_servers ORDER BY created_at, id");
  }
  get(id: string): ServerRow {
    const row = this.db.one<ServerRow>("SELECT * FROM tal_mcp_servers WHERE id = ?", id);
    if (!row) throw new NotFoundError("MCP server not found.");
    return row;
  }
  create(input: McpServerCreate): ServerRow {
    const id = newId();
    const slug = slugFor(input.name, new Set(this.list().map((s) => s.slug)));
    this.db.run(
      `INSERT INTO tal_mcp_servers
      (id, name, slug, url, transport, auth_header_name, auth_header_value, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.name,
      slug,
      input.url,
      input.transport,
      input.auth?.header,
      input.auth?.value,
      now(),
      now(),
    );
    return this.get(id);
  }
  update(id: string, patch: McpServerPatch): ServerRow {
    const s = this.get(id);
    const auth = patch.auth === undefined ? { header: s.auth_header_name, value: s.auth_header_value } : patch.auth;
    this.db.run(
      `UPDATE tal_mcp_servers SET name=?, url=?, transport=?, enabled=?, max_calls_per_day=?,
      auth_header_name=?, auth_header_value=?, updated_at=? WHERE id=?`,
      patch.name ?? s.name,
      patch.url ?? s.url,
      patch.transport ?? s.transport,
      patch.enabled ?? !!s.enabled,
      patch.max_calls_per_day ?? s.max_calls_per_day,
      auth?.header,
      auth?.value,
      now(),
      id,
    );
    return this.get(id);
  }
  delete(id: string): void {
    this.get(id);
    this.db.transaction(() => {
      this.clearTools(id);
      this.db.run("DELETE FROM tal_mcp_servers WHERE id = ?", id);
    });
  }
  clearTools(id: string): void {
    this.db.run("DELETE FROM tal_mcp_tools WHERE server_id = ?", id);
  }
  setStatus(id: string, error: string | null, info?: unknown): void {
    this.db.run(
      `UPDATE tal_mcp_servers SET status=?, last_error=?, last_ok_at=CASE WHEN ? IS NULL THEN ? ELSE last_ok_at END,
      server_info=COALESCE(?, server_info), updated_at=? WHERE id=?`,
      error ? "error" : "ok",
      error,
      error,
      now(),
      info ? JSON.stringify(info) : null,
      now(),
      id,
    );
  }
  reserveCall(id: string): boolean {
    const day = now().slice(0, 10);
    return (
      this.db.run(
        `UPDATE tal_mcp_servers SET calls_today=CASE WHEN calls_day=? THEN calls_today+1 ELSE 1 END, calls_day=?
      WHERE id=? AND enabled=1 AND (calls_day IS NULL OR calls_day<>? OR calls_today<max_calls_per_day)`,
        day,
        day,
        id,
        day,
      ).changes === 1
    );
  }
  listTools(id: string): ToolRow[] {
    return this.db.all<ToolRow>("SELECT * FROM tal_mcp_tools WHERE server_id=? ORDER BY name", id);
  }
  replaceTools(id: string, rows: ToolRow[]): void {
    this.db.transaction(() => {
      this.db.run("UPDATE tal_mcp_tools SET status='missing' WHERE server_id=?", id);
      for (const t of rows) this.upsertTool(t);
      // Retain missing rows only within the storage cap.
      const missing = this.listTools(id).filter((t) => t.status === "missing");
      for (const t of missing.slice(Math.max(0, 40 - rows.length))) this.db.run("DELETE FROM tal_mcp_tools WHERE server_id=? AND name=?", id, t.name);
      this.db.run("UPDATE tal_mcp_servers SET tools_refreshed_at=? WHERE id=?", now(), id);
    });
  }
  private upsertTool(t: ToolRow): void {
    this.db.run(
      `INSERT INTO tal_mcp_tools (server_id,name,title,description,input_schema,schema_hash,read_only,destructive,policy,status,seen_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(server_id,name) DO UPDATE SET
      title=excluded.title,description=excluded.description,input_schema=excluded.input_schema,
      policy=CASE WHEN tal_mcp_tools.schema_hash<>excluded.schema_hash THEN 'approve' ELSE tal_mcp_tools.policy END,
      schema_hash=excluded.schema_hash,read_only=excluded.read_only,destructive=excluded.destructive,status=excluded.status,seen_at=excluded.seen_at`,
      t.server_id,
      t.name,
      t.title,
      t.description,
      t.input_schema,
      t.schema_hash,
      t.read_only,
      t.destructive,
      t.policy,
      t.status,
      t.seen_at,
    );
  }
  setToolPolicy(id: string, name: string, policy: McpToolPolicy): void {
    if (!this.db.run("UPDATE tal_mcp_tools SET policy=? WHERE server_id=? AND name=?", policy, id, name).changes)
      throw new NotFoundError("MCP tool not found.");
  }
  setToolStatus(id: string, name: string, status: ToolRow["status"]): void {
    this.db.run("UPDATE tal_mcp_tools SET status=? WHERE server_id=? AND name=?", status, id, name);
  }
  view(id: string): McpServerView {
    const s = this.get(id);
    return {
      id: s.id,
      name: s.name,
      slug: s.slug,
      url: s.url,
      transport: s.transport,
      auth: s.auth_header_name ? { header: s.auth_header_name } : null,
      enabled: !!s.enabled,
      max_calls_per_day: s.max_calls_per_day,
      calls_today: s.calls_day === now().slice(0, 10) ? s.calls_today : 0,
      status: s.status,
      last_error: s.last_error,
      last_ok_at: s.last_ok_at,
      tools_refreshed_at: s.tools_refreshed_at,
      server_info: s.server_info ? JSON.parse(s.server_info) : null,
      created_at: s.created_at,
      updated_at: s.updated_at,
      tools: this.listTools(id).map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        policy: t.policy,
        status: t.status,
        read_only: !!t.read_only,
        destructive: !!t.destructive,
      })),
    };
  }
}
