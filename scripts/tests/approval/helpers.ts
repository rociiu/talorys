import { Database as BunSqlite } from "bun:sqlite";
import { Database } from "../../../apps/agent/src/db/database";
import { migrate } from "../../../apps/agent/src/db/migrations";
import { TaskRepository } from "../../../apps/agent/src/db/repositories/tasks";
import { PendingActionRepository } from "../../../apps/agent/src/db/repositories/pending-actions";
import { ConversationRepository } from "../../../apps/agent/src/db/repositories/conversations";
import { NoteRepository, ProjectRepository } from "../../../apps/agent/src/db/repositories/notes";
import { MemoryRepository } from "../../../apps/agent/src/db/repositories/memories";
import { AutomationRepository, NotificationRepository } from "../../../apps/agent/src/db/repositories/automations";
import { ActivityLog } from "../../../apps/agent/src/services/usage";
import { ALL_TOOLS, ToolExecutor, type ToolContext, type ToolDefinition } from "../../../apps/agent/src/tools";

export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Expected condition to be true: ${message}`);
  }
}

export function assertEquals<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(`Expected ${JSON.stringify(expected)} but received ${JSON.stringify(actual)}${message ? ` (${message})` : ""}`);
  }
}

export function assertMatch(actual: string, pattern: RegExp, message?: string): void {
  if (!pattern.test(actual)) {
    throw new Error(`Expected "${actual}" to match ${pattern}${message ? ` (${message})` : ""}`);
  }
}

export async function assertRejects(fn: () => Promise<unknown> | unknown, pattern?: RegExp | string, message?: string): Promise<Error> {
  try {
    await fn();
  } catch (err: any) {
    if (pattern) {
      const msg = err?.message || String(err);
      if (typeof pattern === "string") {
        if (!msg.includes(pattern)) {
          throw new Error(`Expected error message to include "${pattern}" but got "${msg}"${message ? ` (${message})` : ""}`);
        }
      } else {
        if (!pattern.test(msg)) {
          throw new Error(`Expected error message to match ${pattern} but got "${msg}"${message ? ` (${message})` : ""}`);
        }
      }
    }
    return err;
  }
  throw new Error(`Expected function to reject/throw an error${message ? ` (${message})` : ""}`);
}

export interface TestEnv {
  bunDb: BunSqlite;
  db: Database;
  services: {
    db: Database;
    bunDb: BunSqlite;
    tasks: TaskRepository;
    pendingActions: PendingActionRepository;
    conversations: ConversationRepository;
    notes: NoteRepository;
    projects: ProjectRepository;
    memories: MemoryRepository;
    automationsRepo: AutomationRepository;
    notifications: NotificationRepository;
    activity: ActivityLog;
    automations: {
      get: (id: string) => any;
      delete: (id: string) => Promise<void>;
    };
  };
  ctx: ToolContext;
  conversation: { id: string; title: string };
  executor: ToolExecutor;
  createExecutor: (tools?: ToolDefinition[], limits?: { maxToolCalls: number }, overrideCtx?: Partial<ToolContext>) => ToolExecutor;
}

export function createTestEnv(opts: {
  timezone?: string;
  mode?: "chat" | "scheduled";
  conversationId?: string;
  maxToolCalls?: number;
  tools?: ToolDefinition[];
} = {}): TestEnv {
  const bunDb = new BunSqlite(":memory:");
  bunDb.run("PRAGMA foreign_keys = ON;");

  const storage: any = {
    sql: {
      exec(query: string, ...params: any[]) {
        const isSelect = /^\s*(SELECT|PRAGMA)/i.test(query);
        if (isSelect) {
          const rows = bunDb.query(query).all(...params);
          return { toArray: () => rows, rowsWritten: 0 };
        } else {
          const res = bunDb.run(query, params);
          return { toArray: () => [], rowsWritten: res.changes };
        }
      },
    },
    transactionSync(fn: any) {
      return bunDb.transaction(fn)();
    },
  };

  const db = new Database(storage);
  migrate(db);

  const automationsRepo = new AutomationRepository(db);

  const services = {
    db,
    bunDb,
    tasks: new TaskRepository(db),
    pendingActions: new PendingActionRepository(db),
    conversations: new ConversationRepository(db),
    notes: new NoteRepository(db),
    projects: new ProjectRepository(db),
    memories: new MemoryRepository(db),
    automationsRepo,
    notifications: new NotificationRepository(db),
    activity: new ActivityLog(db),
    automations: {
      get: (id: string) => automationsRepo.get(id),
      list: () => automationsRepo.list(),
      create: async (input: any) => {
        return automationsRepo.create({
          ...input,
          next_run: input.schedule?.at ?? new Date(Date.now() + 60_000).toISOString(),
          schedule: typeof input.schedule === "string" ? input.schedule : JSON.stringify(input.schedule),
        });
      },
      delete: async (id: string) => {
        automationsRepo.delete(id);
      },
    },
  };

  const conversation = services.conversations.create("Default Test Conversation");

  const ctx: ToolContext = {
    services: services as any,
    timezone: opts.timezone ?? "Asia/Seoul",
    mode: opts.mode ?? "chat",
    conversationId: "conversationId" in opts ? opts.conversationId : conversation.id,
  };

  const createExecutor = (
    tools: ToolDefinition[] = opts.tools ?? ALL_TOOLS,
    limits: { maxToolCalls: number } = { maxToolCalls: opts.maxToolCalls ?? 10 },
    overrideCtx?: Partial<ToolContext>,
  ) => {
    return new ToolExecutor(tools, { ...ctx, ...overrideCtx }, limits);
  };

  const executor = createExecutor();

  return {
    bunDb,
    db,
    services,
    ctx,
    conversation,
    executor,
    createExecutor,
  };
}
