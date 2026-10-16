import { DEFAULT_LIMITS, DEFAULT_MODEL, DEFAULT_MEMORY_HISTORY, type Settings, settingsSchema, settingsUpdateSchema } from "@talorys/shared";
import type { z } from "zod";
import { type Database, now } from "../db/database";
import { ValidationError } from "../api/errors";

export const DEFAULT_SETTINGS: Settings = {
  agentName: "Talorys",
  timezone: "UTC",
  theme: "system",
  language: "system",
  model: DEFAULT_MODEL,
  temperature: 0.4,
  limits: { ...DEFAULT_LIMITS },
  autoMemory: true,
  demoMode: false,
  memoryHistory: { ...DEFAULT_MEMORY_HISTORY },
  updateCheck: true,
};

const SETTINGS_KEY = "app.settings";

/** Application settings plus small internal key/value records, stored in tal_settings. */
export class SettingsService {
  constructor(
    private readonly db: Database,
    /** Installer-provided defaults (e.g. the owner's timezone), used until changed in Settings. */
    private readonly defaults: Partial<Settings> = {},
  ) {}

  get(): Settings {
    const stored = this.getJson<Partial<Settings>>(SETTINGS_KEY) ?? {};
    const merged = {
      ...DEFAULT_SETTINGS,
      ...this.defaults,
      ...stored,
      limits: { ...DEFAULT_SETTINGS.limits, ...(stored.limits ?? {}) },
      memoryHistory: { ...DEFAULT_SETTINGS.memoryHistory, ...(stored.memoryHistory ?? {}) },
    };
    const parsed = settingsSchema.safeParse(merged);
    if (parsed.success) return parsed.data;
    // Ignore invalid installer defaults rather than failing.
    const fallback = settingsSchema.safeParse({ ...merged, timezone: stored.timezone ?? DEFAULT_SETTINGS.timezone, agentName: stored.agentName ?? DEFAULT_SETTINGS.agentName });
    return fallback.success ? fallback.data : DEFAULT_SETTINGS;
  }

  update(patch: z.input<typeof settingsUpdateSchema>): Settings {
    const parsedPatch = settingsUpdateSchema.safeParse(patch);
    if (!parsedPatch.success) throw ValidationError.fromZod(parsedPatch.error);
    const current = this.get();
    const next = {
      ...current,
      ...stripUndefined(parsedPatch.data),
      limits: { ...current.limits, ...stripUndefined(parsedPatch.data.limits ?? {}) },
      memoryHistory: { ...current.memoryHistory, ...stripUndefined(parsedPatch.data.memoryHistory ?? {}) },
    };
    const parsed = settingsSchema.safeParse(next);
    if (!parsed.success) throw ValidationError.fromZod(parsed.error);
    this.setJson(SETTINGS_KEY, parsed.data);
    return parsed.data;
  }

  /** Raw stored overrides (used for export). */
  raw(): Partial<Settings> {
    return this.getJson<Partial<Settings>>(SETTINGS_KEY) ?? {};
  }

  getJson<T>(key: string): T | null {
    const row = this.db.one<{ value: string }>(`SELECT value FROM tal_settings WHERE key = ?`, key);
    if (!row) return null;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return null;
    }
  }

  setJson(key: string, value: unknown): void {
    this.db.run(
      `INSERT INTO tal_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key, JSON.stringify(value), now(),
    );
  }

  delete(key: string): void {
    this.db.run(`DELETE FROM tal_settings WHERE key = ?`, key);
  }
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
