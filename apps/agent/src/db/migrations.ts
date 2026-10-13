import type { Database } from "./database";

/**
 * Versioned, append-only schema migrations for Talorys data.
 *
 * Rules:
 *  - Never edit or reorder an existing migration; add a new one.
 *  - Migrations must be non-destructive (no DROP of owner data).
 *  - All tables are prefixed `tal_` so they never collide with the
 *    Agents SDK's internal `cf_agents_*` tables.
 */
export interface Migration {
  version: number;
  name: string;
  statements: string[];
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial schema",
    statements: [
      `CREATE TABLE IF NOT EXISTS tal_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS tal_conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        summary TEXT,
        summary_upto TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS tal_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES tal_conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user','assistant')),
        content TEXT NOT NULL,
        tools TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'complete',
        error TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS tal_messages_conv ON tal_messages(conversation_id, created_at)`,
      `CREATE TABLE IF NOT EXISTS tal_memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        category TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS tal_projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS tal_tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'todo',
        priority TEXT NOT NULL DEFAULT 'medium',
        due_at TEXT,
        project_id TEXT REFERENCES tal_projects(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS tal_tasks_status_due ON tal_tasks(status, due_at)`,
      `CREATE TABLE IF NOT EXISTS tal_notes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        project_id TEXT REFERENCES tal_projects(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS tal_automations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '',
        schedule TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'scheduled',
        schedule_id TEXT,
        next_run TEXT,
        last_run TEXT,
        last_result TEXT,
        last_error TEXT,
        run_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS tal_automation_runs (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL,
        automation_name TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        result TEXT,
        error TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS tal_runs_started ON tal_automation_runs(started_at)`,
      `CREATE TABLE IF NOT EXISTS tal_notifications (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        automation_id TEXT,
        read_at TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS tal_activity (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS tal_sessions (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        user_agent TEXT NOT NULL DEFAULT ''
      )`,
      `CREATE TABLE IF NOT EXISTS tal_login_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client TEXT NOT NULL,
        success INTEGER NOT NULL,
        at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS tal_login_attempts_at ON tal_login_attempts(at)`,
      `CREATE TABLE IF NOT EXISTS tal_usage_daily (
        day TEXT PRIMARY KEY,
        ai_requests INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        tool_calls INTEGER NOT NULL DEFAULT 0,
        scheduled_ai_runs INTEGER NOT NULL DEFAULT 0,
        ai_errors INTEGER NOT NULL DEFAULT 0
      )`,
      // Full-text indexes (external content, kept in sync by triggers).
      `CREATE VIRTUAL TABLE IF NOT EXISTS tal_memories_fts USING fts5(content, content='tal_memories', content_rowid='rowid')`,
      `CREATE TRIGGER IF NOT EXISTS tal_memories_ai AFTER INSERT ON tal_memories BEGIN
        INSERT INTO tal_memories_fts(rowid, content) VALUES (new.rowid, new.content);
      END`,
      `CREATE TRIGGER IF NOT EXISTS tal_memories_ad AFTER DELETE ON tal_memories BEGIN
        INSERT INTO tal_memories_fts(tal_memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      END`,
      `CREATE TRIGGER IF NOT EXISTS tal_memories_au AFTER UPDATE ON tal_memories BEGIN
        INSERT INTO tal_memories_fts(tal_memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        INSERT INTO tal_memories_fts(rowid, content) VALUES (new.rowid, new.content);
      END`,
      `CREATE VIRTUAL TABLE IF NOT EXISTS tal_notes_fts USING fts5(title, content, content='tal_notes', content_rowid='rowid')`,
      `CREATE TRIGGER IF NOT EXISTS tal_notes_ai AFTER INSERT ON tal_notes BEGIN
        INSERT INTO tal_notes_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
      END`,
      `CREATE TRIGGER IF NOT EXISTS tal_notes_ad AFTER DELETE ON tal_notes BEGIN
        INSERT INTO tal_notes_fts(tal_notes_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
      END`,
      `CREATE TRIGGER IF NOT EXISTS tal_notes_au AFTER UPDATE ON tal_notes BEGIN
        INSERT INTO tal_notes_fts(tal_notes_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
        INSERT INTO tal_notes_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
      END`,
    ],
  },
  {
    version: 2,
    name: "pending destructive actions",
    statements: [
      `CREATE TABLE IF NOT EXISTS tal_pending_actions (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES tal_conversations(id) ON DELETE CASCADE,
        tool TEXT NOT NULL,
        target_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','cancelled','failed')),
        error TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        resolved_at TEXT
      )`,
    ],
  },
  {
    version: 3,
    name: "message provenance",
    statements: [`ALTER TABLE tal_messages ADD COLUMN source TEXT NOT NULL DEFAULT 'chat'`],
  },
  {
    version: 4,
    name: "memory history",
    statements: [
      // Lifecycle columns. Existing memories stay current ("active") with no relationships.
      `ALTER TABLE tal_memories ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`,
      `ALTER TABLE tal_memories ADD COLUMN superseded_by TEXT`,
      `ALTER TABLE tal_memories ADD COLUMN valid_from TEXT`,
      `ALTER TABLE tal_memories ADD COLUMN valid_until TEXT`,
      `CREATE INDEX IF NOT EXISTS tal_memories_status ON tal_memories(status, updated_at)`,
      `CREATE INDEX IF NOT EXISTS tal_memories_superseded_by ON tal_memories(superseded_by)`,
      `CREATE TABLE IF NOT EXISTS tal_memory_reviews (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        other_id TEXT NOT NULL,
        relationship TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS tal_memory_reviews_memory ON tal_memory_reviews(memory_id)`,
      `CREATE INDEX IF NOT EXISTS tal_memory_reviews_other ON tal_memory_reviews(other_id)`,
    ],
  },
  {
    version: 5,
    name: "approval target versions",
    statements: [
      `ALTER TABLE tal_pending_actions ADD COLUMN target_version TEXT`,
      `ALTER TABLE tal_pending_actions ADD COLUMN payload TEXT`,
      `ALTER TABLE tal_pending_actions ADD COLUMN preview TEXT`,
    ],
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/**
 * Applies pending migrations. Each migration runs in its own transaction
 * together with the version bump, so a failure leaves the previous version intact.
 */
export function migrate(db: Database, migrations: Migration[] = MIGRATIONS): number {
  db.run(`CREATE TABLE IF NOT EXISTS tal_schema (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  const current = db.one<{ version: number }>(`SELECT version FROM tal_schema WHERE id = 1`)?.version ?? 0;
  let version = current;
  for (const m of migrations) {
    if (m.version <= version) continue;
    db.transaction(() => {
      for (const statement of m.statements) db.run(statement);
      db.run(
        `INSERT INTO tal_schema (id, version, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at`,
        m.version,
        new Date().toISOString(),
      );
    });
    version = m.version;
  }
  return version;
}

export function schemaVersion(db: Database): number {
  return db.one<{ version: number }>(`SELECT version FROM tal_schema WHERE id = 1`)?.version ?? 0;
}
