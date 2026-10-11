import assert from "node:assert";
import { Database as SqliteDB } from "bun:sqlite";
import { MassiveTestHarness, type TestCase } from "./massive-harness";
import { BACKUP_FORMAT, BACKUP_VERSION, backupSchema, TALORYS_VERSION, type Backup } from "@talorys/shared";
import { exportData, importData } from "../apps/agent/src/services/backup";
import { MIGRATIONS, migrate } from "../apps/agent/src/db/migrations";
import { SettingsService, DEFAULT_SETTINGS } from "../apps/agent/src/services/settings";
import { ValidationError } from "../apps/agent/src/api/errors";

// ---------- Test DB & Services Adapter ----------

export class TestDB {
  raw: SqliteDB;
  constructor() {
    this.raw = new SqliteDB(":memory:");
  }
  all<T = any>(query: string, ...params: any[]): T[] {
    return this.raw.query(query).all(...params) as T[];
  }
  one<T = any>(query: string, ...params: any[]): T | null {
    return (this.raw.query(query).get(...params) as T) ?? null;
  }
  run(query: string, ...params: any[]): { changes: number } {
    const res = this.raw.run(query, ...params);
    return { changes: res.changes };
  }
  transaction<T>(fn: () => T): T {
    return this.raw.transaction(fn)();
  }
  close() {
    this.raw.close();
  }
}

export interface TestServicesContext {
  db: TestDB;
  settings: SettingsService;
  automations: { rearmAll: () => Promise<void> };
  activity: { record: (type: string, summary: string) => void; list: () => any[] };
  getRearmedCount: () => number;
  getActivityLogs: () => any[];
}

export function createTestServices(overrides: { timezone?: string; agentName?: string } = {}): TestServicesContext {
  const db = new TestDB();
  migrate(db as any);
  const settings = new SettingsService(db as any, {
    timezone: overrides.timezone ?? "Asia/Seoul",
    agentName: overrides.agentName ?? "Talorys",
  });
  let rearmed = 0;
  const activityLogs: any[] = [];
  return {
    db,
    settings,
    automations: {
      rearmAll: async () => {
        rearmed++;
      },
    },
    activity: {
      record: (type: string, summary: string) => {
        activityLogs.push({ type, summary, at: new Date().toISOString() });
      },
      list: () => activityLogs,
    },
    getRearmedCount: () => rearmed,
    getActivityLogs: () => activityLogs,
  };
}

// ---------- Helper Builders ----------

export function baseBackup(dataOverrides: Partial<Backup["data"]> = {}, rootOverrides: Record<string, any> = {}): any {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exported_at: "2026-10-12T00:00:00.000Z",
    app_version: TALORYS_VERSION,
    data: {
      settings: { ...DEFAULT_SETTINGS },
      conversations: [],
      messages: [],
      memories: [],
      tasks: [],
      notes: [],
      projects: [],
      automations: [],
      ...dataOverrides,
    },
    ...rootOverrides,
  };
}

export function makeTask(id: string, overrides: Record<string, any> = {}) {
  return {
    id,
    title: `Task ${id}`,
    description: `Description for ${id}`,
    status: "todo",
    priority: "medium",
    due_at: null,
    project_id: null,
    created_at: "2026-10-12T00:00:00.000Z",
    updated_at: "2026-10-12T00:00:00.000Z",
    completed_at: null,
    ...overrides,
  };
}

export function makeNote(id: string, overrides: Record<string, any> = {}) {
  return {
    id,
    title: `Note ${id}`,
    content: `# Content for ${id}\nMarkdown notes here.`,
    project_id: null,
    created_at: "2026-10-12T00:00:00.000Z",
    updated_at: "2026-10-12T00:00:00.000Z",
    ...overrides,
  };
}

export function makeMemory(id: string, overrides: Record<string, any> = {}) {
  return {
    id,
    content: `Owner prefers keyboard shortcuts for ${id}`,
    category: "preference",
    source: "manual",
    created_at: "2026-10-12T00:00:00.000Z",
    updated_at: "2026-10-12T00:00:00.000Z",
    ...overrides,
  };
}

export function makeProject(id: string, overrides: Record<string, any> = {}) {
  return {
    id,
    name: `Project ${id}`,
    description: `Strategic initiative ${id}`,
    status: "active",
    created_at: "2026-10-12T00:00:00.000Z",
    updated_at: "2026-10-12T00:00:00.000Z",
    ...overrides,
  };
}

export function makeConversation(id: string, overrides: Record<string, any> = {}) {
  return {
    id,
    title: `Chat Session ${id}`,
    summary: `Summary of chat ${id}`,
    summary_upto: "msg-1",
    created_at: "2026-10-12T00:00:00.000Z",
    updated_at: "2026-10-12T00:00:00.000Z",
    ...overrides,
  };
}

export function makeMessage(id: string, conversation_id: string, overrides: Record<string, any> = {}) {
  return {
    id,
    conversation_id,
    role: "user",
    content: `Hello world message ${id}`,
    tools: "[]",
    status: "complete",
    error: null,
    created_at: "2026-10-12T00:00:00.000Z",
    ...overrides,
  };
}

export function makeAutomation(id: string, overrides: Record<string, any> = {}) {
  return {
    id,
    name: `Daily Digest ${id}`,
    kind: "reminder",
    message: "Time for standup",
    schedule: { type: "daily", time: "09:00" },
    enabled: true,
    created_at: "2026-10-12T00:00:00.000Z",
    updated_at: "2026-10-12T00:00:00.000Z",
    ...overrides,
  };
}
