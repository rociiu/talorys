import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  type Backup,
  MEMORY_CATEGORIES,
  MEMORY_STATUSES,
  TALORYS_VERSION,
  backupSchema,
  languagePreferenceSchema,
  MAX_MCP_SERVERS,
  MCP_AUTH_TYPES,
  scheduleSpecSchema,
} from "@talorys/shared";
import type { Services } from "./container";
import { ValidationError } from "../api/errors";
import { decodeTools } from "../db/repositories/conversations";
import { validateEndpoint } from "../mcp/url";

/**
 * Settings a backup may never change: they control cost and model behaviour, and a
 * backup file is untrusted input. The owner changes them in Settings instead. The agent
 * name counts because it goes into the system prompt as instructions, not marked as data.
 */
export const IMPORT_IGNORED_SETTINGS = ["model", "limits", "demoMode", "autoMemory", "memoryHistory", "agentName", "webSearch"] as const;

/** Builds a portable backup. Sessions, login attempts and credentials are never exported. */
export function exportData(s: Services): Backup {
  const db = s.db;
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exported_at: new Date().toISOString(),
    app_version: TALORYS_VERSION,
    data: {
      settings: s.settings.get(),
      conversations: db.all(`SELECT id, title, summary, summary_upto, created_at, updated_at FROM tal_conversations ORDER BY created_at`),
      messages: db.all(`SELECT id, conversation_id, role, content, tools, status, error, created_at FROM tal_messages ORDER BY created_at`),
      // Lifecycle fields travel with each memory; embeddings are derived data and are rebuilt after import.
      memories: db.all(
        `SELECT id, content, category, source, status, superseded_by, valid_from, valid_until, created_at, updated_at FROM tal_memories ORDER BY created_at`,
      ),
      tasks: db.all(`SELECT * FROM tal_tasks ORDER BY created_at`),
      notes: db.all(`SELECT * FROM tal_notes ORDER BY created_at`),
      projects: db.all(`SELECT * FROM tal_projects ORDER BY created_at`),
      automations: db
        .all<Record<string, unknown>>(`SELECT id, name, kind, message, schedule, enabled, created_at, updated_at FROM tal_automations`)
        .map((a) => ({ ...a, schedule: JSON.parse(String(a.schedule)), enabled: a.enabled === 1 })),
      // Where each server is and how it authenticates; never the credential, a session or tool choices.
      mcp_servers: db.all(`SELECT id, name, url, auth_type, created_at FROM tal_mcp_servers ORDER BY created_at`),
    },
  } as unknown as Backup;
}

export interface ImportSummary {
  conversations: number;
  messages: number;
  memories: number;
  tasks: number;
  notes: number;
  projects: number;
  automations: number;
  /** Imported automations always arrive paused; the owner enables them. */
  automations_paused: number;
  /** Imported MCP servers arrive disabled, without credentials or enabled tools. */
  mcp_servers: number;
  ignored_settings: string[];
}

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;

/**
 * Merges a backup into the current data inside one transaction. Records are
 * upserted by id, so importing the same backup twice is harmless, nothing
 * that exists only locally is deleted, and a record edited after the backup was
 * made keeps the newer local version. A backup is untrusted input: new automations
 * arrive paused, existing automations and the settings in IMPORT_IGNORED_SETTINGS are
 * never changed, and imported messages can never be retried as owner input.
 */
export async function importData(s: Services, raw: unknown): Promise<ImportSummary> {
  const parsed = backupSchema.safeParse(raw);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error);
  const backup = parsed.data;
  if (backup.version > BACKUP_VERSION) {
    throw new ValidationError(`This backup was made by a newer Talorys (format v${backup.version}). Update Talorys first.`);
  }
  const previousTimezone = s.settings.get().timezone;
  const d = backup.data;
  const db = s.db;
  const now = new Date().toISOString();

  let paused = 0; // existing automations this backup paused
  // The schema validates the compared timestamps but they may carry a UTC offset;
  // normalise to the ISO-UTC shape the app itself writes so text comparisons in
  // the guarded upserts (and against rows this import stores) are correct.
  const iso = (v: string): string => new Date(v).toISOString();

  const summary = db.transaction((): ImportSummary => {
    for (const p of d.projects) {
      db.run(
        `INSERT INTO tal_projects (id, name, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, status = excluded.status, updated_at = excluded.updated_at
         WHERE excluded.updated_at > tal_projects.updated_at`,
        p.id, p.name, str(p.description), pick(p.status, ["active", "paused", "completed", "archived"], "active"), p.created_at, iso(p.updated_at),
      );
    }
    const projectExists = (id: unknown) => typeof id === "string" && !!db.one(`SELECT 1 AS x FROM tal_projects WHERE id = ?`, id);
    for (const c of d.conversations) {
      // Summaries go into the system prompt but are invisible in the UI, so imported ones are
      // dropped and regenerated from the (visible) messages when needed.
      // The guard is row-level last-writer-wins on updated_at, which also moves when a
      // message is added (ConversationRepository.touch()): a backup exported after newer
      // chat activity beats a rename made earlier. If renames ever need to win on their
      // own, they need a separate title timestamp; the tests pin this behaviour.
      db.run(
        `INSERT INTO tal_conversations (id, title, summary, summary_upto, created_at, updated_at) VALUES (?, ?, NULL, NULL, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at
         WHERE excluded.updated_at > tal_conversations.updated_at`,
        c.id, c.title, c.created_at, iso(c.updated_at),
      );
    }
    let messages = 0;
    for (const m of d.messages) {
      if (!db.one(`SELECT 1 AS x FROM tal_conversations WHERE id = ?`, m.conversation_id)) continue;
      db.run(
        `INSERT INTO tal_messages (id, conversation_id, role, content, tools, status, error, created_at, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'import') ON CONFLICT(id) DO NOTHING`,
        // Approvals and task plans refer to drafts in the exporting instance; an imported one could only mislead.
        m.id, m.conversation_id, m.role, m.content, JSON.stringify(decodeTools(m.tools).map(({ approval: _a, plan: _p, ...t }) => t)),
        pick(m.status, ["complete", "error", "cancelled"], "complete"), strOrNull(m.error), m.created_at,
      );
      messages++;
    }
    const statedDate = (v: unknown) => (typeof v === "string" && /^\d{4}(-\d{2}(-\d{2})?)?$/.test(v) ? v : null);
    const importedLinks: { id: string; superseded_by: string }[] = [];
    for (const m of d.memories) {
      const existing = db.one<{ content: string; updated_at: string }>(`SELECT content, updated_at FROM tal_memories WHERE id = ?`, m.id);
      const updated_at = iso(m.updated_at);
      // Never overwrite a newer local edit with an older backup copy.
      if (existing && existing.updated_at >= updated_at) continue;
      // Older backups (before Smart Memory) have no lifecycle fields: those memories stay current.
      const status = pick(m.status, MEMORY_STATUSES, "active");
      db.run(
        `INSERT INTO tal_memories (id, content, category, source, status, superseded_by, valid_from, valid_until, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET content = excluded.content, category = excluded.category, status = excluded.status,
           valid_from = excluded.valid_from, valid_until = excluded.valid_until, updated_at = excluded.updated_at`,
        m.id, m.content, pick(m.category, MEMORY_CATEGORIES, "other"), "import", status,
        statedDate(m.valid_from), statedDate(m.valid_until), m.created_at, updated_at,
      );
      if (typeof m.superseded_by === "string" && m.superseded_by) importedLinks.push({ id: m.id, superseded_by: m.superseded_by });
    }
    // Relationships are restored only when they point at an existing memory and don't form a cycle.
    for (const link of importedLinks) {
      if (!db.one(`SELECT 1 AS x FROM tal_memories WHERE id = ?`, link.superseded_by)) continue;
      if (s.memoryHistory.lifecycle.wouldCycle(link.id, link.superseded_by)) continue;
      db.run(`UPDATE tal_memories SET superseded_by = ? WHERE id = ?`, link.superseded_by, link.id);
    }
    for (const t of d.tasks) {
      db.run(
        `INSERT INTO tal_tasks (id, title, description, status, priority, due_at, project_id, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, description = excluded.description, status = excluded.status,
           priority = excluded.priority, due_at = excluded.due_at, project_id = excluded.project_id, updated_at = excluded.updated_at,
           completed_at = excluded.completed_at
         WHERE excluded.updated_at > tal_tasks.updated_at`,
        t.id, t.title, str(t.description), pick(t.status, ["todo", "in_progress", "done"], "todo"),
        pick(t.priority, ["low", "medium", "high", "urgent"], "medium"), strOrNull(t.due_at),
        projectExists(t.project_id) ? t.project_id : null, t.created_at, iso(t.updated_at), strOrNull(t.completed_at),
      );
    }
    for (const n of d.notes) {
      db.run(
        `INSERT INTO tal_notes (id, title, content, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, content = excluded.content, project_id = excluded.project_id, updated_at = excluded.updated_at
         WHERE excluded.updated_at > tal_notes.updated_at`,
        n.id, n.title, n.content, projectExists(n.project_id) ? n.project_id : null, n.created_at, iso(n.updated_at),
      );
    }
    let automations = 0;
    for (const a of d.automations) {
      const schedule = scheduleSpecSchema.safeParse(a.schedule);
      if (!schedule.success) continue;
      const kind = pick(a.kind, ["reminder", "task_digest", "agent_prompt"], "reminder");
      // An imported AI prompt must not start running on its own, and an existing automation keeps the
      // owner's version. The one change a backup may make to it is the safe one: pausing it.
      if (db.one(`SELECT 1 AS x FROM tal_automations WHERE id = ?`, a.id)) {
        if (a.enabled === false) {
          paused += db.run(`UPDATE tal_automations SET enabled = 0, status = 'paused', updated_at = ? WHERE id = ? AND enabled = 1`, now, a.id).changes > 0 ? 1 : 0;
        }
        continue;
      }
      db.run(
        `INSERT INTO tal_automations (id, name, kind, message, schedule, enabled, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, 'paused', ?, ?)`,
        a.id, a.name, kind, str(a.message), JSON.stringify(schedule.data), str(a.created_at, now), now,
      );
      automations++;
    }
    let mcpServers = 0;
    for (const m of d.mcp_servers) {
      // An imported server never connects or exposes a tool on its own: it arrives disabled, with no
      // credential and no tools, and an existing server keeps the owner's version. Unsafe URLs are skipped.
      if (db.one(`SELECT 1 AS x FROM tal_mcp_servers WHERE id = ?`, m.id) || s.mcp.repo.count() >= MAX_MCP_SERVERS) continue;
      let url: string;
      try {
        url = validateEndpoint(m.url, { development: false }).href;
      } catch {
        continue;
      }
      s.mcp.repo.create({
        id: m.id,
        name: m.name.slice(0, 64),
        url,
        auth_type: pick(m.auth_type, MCP_AUTH_TYPES, "none"),
        enabled: false,
        created_at: str(m.created_at, now),
      });
      mcpServers++;
    }
    const settings: Record<string, unknown> = { ...d.settings };
    const ignored = IMPORT_IGNORED_SETTINGS.filter((key) => key in settings);
    for (const key of ignored) delete settings[key];
    // A backup from a newer version may name a language this one doesn't have; keep the current one.
    if ("language" in settings && !languagePreferenceSchema.safeParse(settings.language).success) delete settings.language;
    if (Object.keys(settings).length > 0) {
      // Validated merge; invalid fields are rejected with a clear error.
      s.settings.update(settings as never);
    }
    return {
      conversations: d.conversations.length,
      messages,
      memories: d.memories.length,
      tasks: d.tasks.length,
      notes: d.notes.length,
      projects: d.projects.length,
      automations,
      automations_paused: automations,
      mcp_servers: mcpServers,
      ignored_settings: [...ignored],
    };
  });

  // Disarm automations the backup paused; a new timezone also moves the owner's existing schedules.
  if (paused > 0 || s.settings.get().timezone !== previousTimezone) await s.automations.rearmAll();
  s.activity.record("data.imported", `Imported backup from ${backup.exported_at}`);
  return summary;
}
