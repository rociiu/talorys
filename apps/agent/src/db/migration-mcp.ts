import type { Migration } from "./migrations";

export const MCP_MIGRATION: Migration = {
  version: 7,
  name: "mcp servers and approval results",
  statements: [
    `CREATE TABLE IF NOT EXISTS tal_mcp_servers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, url TEXT NOT NULL,
        transport TEXT NOT NULL DEFAULT 'streamable-http' CHECK (transport IN ('streamable-http','sse')),
        auth_header_name TEXT, auth_header_value TEXT, enabled INTEGER NOT NULL DEFAULT 1,
        max_calls_per_day INTEGER NOT NULL DEFAULT 50, calls_day TEXT, calls_today INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown','ok','error')),
        last_error TEXT, last_ok_at TEXT, tools_refreshed_at TEXT, server_info TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`,
    `CREATE TABLE IF NOT EXISTS tal_mcp_tools (
        server_id TEXT NOT NULL REFERENCES tal_mcp_servers(id) ON DELETE CASCADE,
        name TEXT NOT NULL, title TEXT, description TEXT NOT NULL DEFAULT '',
        input_schema TEXT NOT NULL, schema_hash TEXT NOT NULL,
        read_only INTEGER NOT NULL DEFAULT 0, destructive INTEGER NOT NULL DEFAULT 1,
        policy TEXT NOT NULL DEFAULT 'approve' CHECK (policy IN ('off','auto','approve')),
        status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','unsupported_schema','name_conflict','missing')),
        seen_at TEXT NOT NULL, PRIMARY KEY (server_id, name)
      )`,
    `ALTER TABLE tal_pending_actions ADD COLUMN result TEXT`,
  ],
};
