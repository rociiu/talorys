import type { Database } from "../db/database";
import type { Migration } from "../db/migrations";
import { ITEM_TABLES_V3, dropItemVectorCache } from "./itemStore";
import { VECTOR_TABLE_V2, convertLegacyVectors, dropVectorCache } from "./vectorStore";

/**
 * The semantic module's own append-only migration track (`slim`), versioned in
 * `tal_semantic_schema` and kept apart from upstream `tal_schema`.
 *
 * Rules:
 *  - Applied lazily: no `tal_semantic_*` table exists until the feature is first enabled.
 *  - Never ALTER or DROP upstream `tal_*` tables, and never add triggers to them.
 *  - Never read, write or migrate other `tal_sem_*` tables; only
 *    `dropSemanticData` removes them.
 *  - Never edit or reorder an existing migration; add a new one.
 */
export const SEMANTIC_TRACK = "slim";

export const SEMANTIC_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "vectors and embedding usage",
    statements: [
      `CREATE TABLE IF NOT EXISTS tal_semantic_vectors (memory_id TEXT PRIMARY KEY, model TEXT NOT NULL, dims INTEGER NOT NULL,
        content_hash TEXT NOT NULL, vector TEXT NOT NULL, updated_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS tal_semantic_usage (day TEXT PRIMARY KEY, embedding_requests INTEGER NOT NULL DEFAULT 0,
        embedded_tokens_estimate INTEGER NOT NULL DEFAULT 0)`,
    ],
  },
  {
    version: 2,
    name: "unit-length BLOB vectors",
    statements: VECTOR_TABLE_V2,
    after: convertLegacyVectors,
  },
  {
    version: 3,
    name: "item vectors and item usage",
    statements: ITEM_TABLES_V3,
  },
];

export function tableExists(db: Database, name: string): boolean {
  return db.one(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, name) !== null;
}

/** The applied track and version, or null when the schema has never been created. */
export function semanticSchema(db: Database): { track: string; version: number } | null {
  if (!tableExists(db, "tal_semantic_schema")) return null;
  return db.one<{ track: string; version: number }>(`SELECT track, version FROM tal_semantic_schema WHERE id = 1`);
}

/**
 * Applies pending semantic migrations. Each migration runs in its own transaction
 * together with the version bump, so a failure leaves the previous version intact.
 */
export function ensureSemanticSchema(db: Database, migrations: Migration[] = SEMANTIC_MIGRATIONS): number {
  db.run(`CREATE TABLE IF NOT EXISTS tal_semantic_schema (id INTEGER PRIMARY KEY CHECK (id = 1), track TEXT NOT NULL,
    version INTEGER NOT NULL, updated_at TEXT NOT NULL)`);
  let version = semanticSchema(db)?.version ?? 0;
  for (const m of migrations) {
    if (m.version <= version) continue;
    db.transaction(() => {
      for (const statement of m.statements) db.run(statement);
      m.after?.(db);
      db.run(
        `INSERT INTO tal_semantic_schema (id, track, version, updated_at) VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET track = excluded.track, version = excluded.version, updated_at = excluded.updated_at`,
        SEMANTIC_TRACK,
        m.version,
        new Date().toISOString(),
      );
    });
    version = m.version;
  }
  return version;
}

/** Names of every table matching `tal_sem%`: this module's and any others. */
export function semanticTableNames(db: Database): string[] {
  return db
    .all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'tal\\_sem%' ESCAPE '\\' ORDER BY name`)
    .map((r) => r.name);
}

/**
 * Drops every `tal_sem%` table, virtual tables first so their shadow tables go with
 * them, then whatever still exists, and forgets the vector caches. Owner data in upstream
 * tables is never touched.
 */
export function dropSemanticData(db: Database): void {
  const tables = db.all<{ name: string; sql: string | null }>(
    `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name LIKE 'tal\\_sem%' ESCAPE '\\'`,
  );
  const virtual = tables.filter((t) => t.sql?.toUpperCase().startsWith("CREATE VIRTUAL"));
  db.transaction(() => {
    for (const t of virtual) db.run(`DROP TABLE IF EXISTS "${t.name}"`);
    for (const name of semanticTableNames(db)) db.run(`DROP TABLE IF EXISTS "${name}"`);
  });
  dropVectorCache(db);
  dropItemVectorCache(db);
}
