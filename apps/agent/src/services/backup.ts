import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  ENCRYPTED_BACKUP_FORMAT,
  type Backup,
  type SignedBackup,
  type EncryptedBackup,
  TALORYS_VERSION,
  backupSchema,
  signedBackupSchema,
  encryptedBackupSchema,
  hasPrototypePollution,
  scheduleSpecSchema,
  hmacSha256Hex,
  toBase64Url,
  fromBase64Url,
} from "@talorys/shared";
import type { Services } from "./container";
import { ValidationError } from "../api/errors";

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
      memories: db.all(`SELECT * FROM tal_memories ORDER BY created_at`),
      tasks: db.all(`SELECT * FROM tal_tasks ORDER BY created_at`),
      notes: db.all(`SELECT * FROM tal_notes ORDER BY created_at`),
      projects: db.all(`SELECT * FROM tal_projects ORDER BY created_at`),
      automations: db
        .all<Record<string, unknown>>(`SELECT id, name, kind, message, schedule, enabled, created_at, updated_at FROM tal_automations`)
        .map((a) => {
          let schedule: unknown = null;
          try {
            schedule = JSON.parse(String(a.schedule));
          } catch {
            schedule = null;
          }
          return { ...a, schedule, enabled: a.enabled === 1 };
        }),
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
}

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;

/**
 * Merges a backup into the current data inside one transaction. Records are
 * upserted by id, so importing the same backup twice is harmless and nothing
 * that exists only locally is deleted. Imported automations are re-armed afterwards.
 */
export async function importData(s: Services, raw: unknown): Promise<ImportSummary> {
  if (hasPrototypePollution(raw)) {
    throw new ValidationError("Prototype pollution attempt detected");
  }

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

  const summary = db.transaction((): ImportSummary => {
    for (const p of d.projects) {
      db.run(
        `INSERT INTO tal_projects (id, name, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, status = excluded.status, updated_at = excluded.updated_at`,
        p.id, p.name, str(p.description), pick(p.status, ["active", "paused", "completed", "archived"], "active"), p.created_at, p.updated_at,
      );
    }
    const projectExists = (id: unknown) => typeof id === "string" && !!db.one(`SELECT 1 AS x FROM tal_projects WHERE id = ?`, id);
    for (const c of d.conversations) {
      db.run(
        `INSERT INTO tal_conversations (id, title, summary, summary_upto, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, summary = excluded.summary, summary_upto = excluded.summary_upto, updated_at = excluded.updated_at`,
        c.id, c.title, strOrNull(c.summary), strOrNull(c.summary_upto), c.created_at, c.updated_at,
      );
    }
    let messages = 0;
    for (const m of d.messages) {
      if (!db.one(`SELECT 1 AS x FROM tal_conversations WHERE id = ?`, m.conversation_id)) continue;
      db.run(
        `INSERT INTO tal_messages (id, conversation_id, role, content, tools, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
        m.id, m.conversation_id, m.role, m.content, typeof m.tools === "string" ? m.tools : JSON.stringify(m.tools ?? []),
        pick(m.status, ["complete", "error", "cancelled"], "complete"), strOrNull(m.error), m.created_at,
      );
      messages++;
    }
    for (const m of d.memories) {
      db.run(
        `INSERT INTO tal_memories (id, content, category, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET content = excluded.content, category = excluded.category, updated_at = excluded.updated_at`,
        m.id, m.content, pick(m.category, ["preference", "fact", "goal", "project", "habit", "person", "other"], "other"),
        "import", m.created_at, m.updated_at,
      );
    }
    for (const t of d.tasks) {
      db.run(
        `INSERT INTO tal_tasks (id, title, description, status, priority, due_at, project_id, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, description = excluded.description, status = excluded.status,
           priority = excluded.priority, due_at = excluded.due_at, project_id = excluded.project_id, updated_at = excluded.updated_at,
           completed_at = excluded.completed_at`,
        t.id, t.title, str(t.description), pick(t.status, ["todo", "in_progress", "done"], "todo"),
        pick(t.priority, ["low", "medium", "high", "urgent"], "medium"), strOrNull(t.due_at),
        projectExists(t.project_id) ? t.project_id : null, t.created_at, t.updated_at, strOrNull(t.completed_at),
      );
    }
    for (const n of d.notes) {
      db.run(
        `INSERT INTO tal_notes (id, title, content, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, content = excluded.content, project_id = excluded.project_id, updated_at = excluded.updated_at`,
        n.id, n.title, n.content, projectExists(n.project_id) ? n.project_id : null, n.created_at, n.updated_at,
      );
    }
    let automations = 0;
    for (const a of d.automations) {
      const schedule = scheduleSpecSchema.safeParse(a.schedule);
      if (!schedule.success) continue;
      const kind = pick(a.kind, ["reminder", "task_digest", "agent_prompt"], "reminder");
      const enabled = a.enabled !== false;
      db.run(
        `INSERT INTO tal_automations (id, name, kind, message, schedule, enabled, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, message = excluded.message,
           schedule = excluded.schedule, enabled = excluded.enabled, updated_at = excluded.updated_at`,
        a.id, a.name, kind, str(a.message), JSON.stringify(schedule.data), enabled ? 1 : 0, enabled ? "scheduled" : "paused",
        str(a.created_at, now), str(a.updated_at, now),
      );
      automations++;
    }
    if (d.settings && Object.keys(d.settings).length > 0) {
      // Validated merge; invalid fields are rejected with a clear error.
      s.settings.update(d.settings as never);
    }
    return {
      conversations: d.conversations.length,
      messages,
      memories: d.memories.length,
      tasks: d.tasks.length,
      notes: d.notes.length,
      projects: d.projects.length,
      automations,
    };
  });

  // Arm (or disarm) imported schedules outside the data transaction (SDK schedules are separate rows).
  // A backup can change timezone even when all scheduled automations are local.
  if (summary.automations > 0 || s.settings.get().timezone !== previousTimezone) await s.automations.rearmAll();
  s.activity.record("data.imported", `Imported backup from ${backup.exported_at}`);
  return summary;
}

// ---------- Cryptographic Signed & Encrypted Backup Services ----------

export async function exportSignedData(s: Services, secret: string): Promise<SignedBackup> {
  const plain = exportData(s);
  const hmac = await hmacSha256Hex(secret, `${plain.format}$${plain.version}$${plain.exported_at}$${JSON.stringify(plain.data)}`);
  return {
    ...plain,
    hmac,
  };
}

export async function verifyBackupHmac(backup: any, secret: string): Promise<boolean> {
  if (!backup || typeof backup !== "object" || !backup.hmac || typeof backup.hmac !== "string") return false;
  if (!/^[0-9a-f]{64}$/i.test(backup.hmac)) return false;

  if ("ciphertext" in backup) {
    const enc = backup as EncryptedBackup;
    const expected = await hmacSha256Hex(secret, `${enc.format}$${enc.version}$${enc.exported_at}$${enc.iv}$${enc.ciphertext}`);
    return enc.hmac.toLowerCase() === expected.toLowerCase();
  }

  if ("data" in backup) {
    if (backup.format !== BACKUP_FORMAT) return false;
    const expected = await hmacSha256Hex(secret, `${backup.format}$${backup.version}$${backup.exported_at}$${JSON.stringify(backup.data)}`);
    return backup.hmac.toLowerCase() === expected.toLowerCase();
  }

  return false;
}

export async function importSignedData(s: Services, raw: unknown, secret: string): Promise<ImportSummary> {
  if (hasPrototypePollution(raw)) {
    throw new ValidationError("Prototype pollution attempt detected");
  }
  const valid = await verifyBackupHmac(raw, secret);
  if (!valid) {
    throw new ValidationError("HMAC verification failed. The backup data may be tampered or the key is incorrect.");
  }
  const parsed = signedBackupSchema.safeParse(raw);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error);
  return importData(s, parsed.data);
}

export async function exportEncryptedData(s: Services, secret: string): Promise<EncryptedBackup> {
  const plain = exportData(s);
  const jsonStr = JSON.stringify(plain.data);

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  const salt = new Uint8Array(16);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 10000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(jsonStr);
  const encryptedBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  const ctBytes = new Uint8Array(encryptedBuf);
  const tagBytes = ctBytes.slice(ctBytes.length - 16);

  const b64Iv = toBase64Url(iv);
  const b64Ct = toBase64Url(ctBytes);
  const b64Tag = toBase64Url(tagBytes);

  const exported_at = new Date().toISOString();
  const hmac = await hmacSha256Hex(secret, `${ENCRYPTED_BACKUP_FORMAT}$${BACKUP_VERSION}$${exported_at}$${b64Iv}$${b64Ct}`);

  return {
    format: ENCRYPTED_BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exported_at,
    app_version: TALORYS_VERSION,
    algorithm: "AES-GCM-256",
    iv: b64Iv,
    ciphertext: b64Ct,
    tag: b64Tag,
    hmac,
  };
}

export async function importEncryptedData(s: Services, raw: unknown, secret: string): Promise<ImportSummary> {
  if (hasPrototypePollution(raw)) {
    throw new ValidationError("Prototype pollution attempt detected");
  }
  const parsed = encryptedBackupSchema.safeParse(raw);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error);
  const enc = parsed.data;

  const validHmac = await verifyBackupHmac(enc, secret);
  if (!validHmac) throw new ValidationError("HMAC verification failed on encrypted backup.");

  let ctBytes: Uint8Array;
  let ivBytes: Uint8Array;
  try {
    ctBytes = fromBase64Url(enc.ciphertext);
    ivBytes = fromBase64Url(enc.iv);
  } catch {
    throw new ValidationError("Malformed base64url encoding in encrypted backup.");
  }

  if (ctBytes.length < 16) {
    throw new ValidationError("Ciphertext is too short.");
  }

  if (enc.tag) {
    const expectedTag = toBase64Url(ctBytes.slice(ctBytes.length - 16));
    if (enc.tag !== expectedTag) {
      throw new ValidationError("Authentication tag mismatch in encrypted backup.");
    }
  }

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  const salt = new Uint8Array(16);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 10000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );

  let decrypted: ArrayBuffer;
  try {
    decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ivBytes }, key, ctBytes);
  } catch {
    throw new ValidationError("Decryption failed. The ciphertext may be corrupted or tampered.");
  }

  const jsonStr = new TextDecoder().decode(decrypted);
  let data: unknown;
  try {
    data = JSON.parse(jsonStr);
  } catch {
    throw new ValidationError("Decrypted payload is not valid JSON.");
  }

  return importData(s, {
    format: BACKUP_FORMAT,
    version: enc.version,
    exported_at: enc.exported_at,
    app_version: enc.app_version,
    data,
  });
}
