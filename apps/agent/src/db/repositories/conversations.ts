import { type ChatMessage, type Conversation, type ToolActivity, toolActivitySchema } from "@talorys/shared";
import { type Database, likePattern, newId, now } from "../database";
import { NotFoundError } from "../../api/errors";

interface MessageRow {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  tools: string;
  status: ChatMessage["status"];
  error: string | null;
  created_at: string;
  source: "chat" | "import";
}

export interface ConversationRecord extends Conversation {
  summary: string | null;
  summary_upto: string | null;
}

/** Decodes stored tool activity, dropping malformed entries (e.g. from an imported backup). */
export function decodeTools(raw: unknown): ToolActivity[] {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = toolActivitySchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

function toMessage(row: MessageRow): ChatMessage {
  return { ...row, tools: decodeTools(row.tools) };
}

export class ConversationRepository {
  constructor(private readonly db: Database) {}

  list(opts: { q?: string; limit?: number } = {}): Conversation[] {
    if (opts.q) {
      const pattern = likePattern(opts.q);
      return this.db.all<Conversation>(
        `SELECT c.id, c.title, c.created_at, c.updated_at,
           (SELECT count(*) FROM tal_messages m WHERE m.conversation_id = c.id) AS message_count
         FROM tal_conversations c
         WHERE c.title LIKE ? ESCAPE '\\'
            OR EXISTS (SELECT 1 FROM tal_messages m WHERE m.conversation_id = c.id AND m.content LIKE ? ESCAPE '\\')
         ORDER BY c.updated_at DESC LIMIT ?`,
        pattern, pattern, opts.limit ?? 50,
      );
    }
    return this.db.all<Conversation>(
      `SELECT c.id, c.title, c.created_at, c.updated_at,
         (SELECT count(*) FROM tal_messages m WHERE m.conversation_id = c.id) AS message_count
       FROM tal_conversations c ORDER BY c.updated_at DESC LIMIT ?`,
      opts.limit ?? 200,
    );
  }

  get(id: string): ConversationRecord | null {
    return this.db.one<ConversationRecord>(`SELECT * FROM tal_conversations WHERE id = ?`, id);
  }

  require(id: string): ConversationRecord {
    const c = this.get(id);
    if (!c) throw new NotFoundError("Conversation not found");
    return c;
  }

  create(title = "New conversation"): ConversationRecord {
    const ts = now();
    const c: ConversationRecord = { id: newId(), title, created_at: ts, updated_at: ts, summary: null, summary_upto: null };
    this.db.run(
      `INSERT INTO tal_conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      c.id, c.title, c.created_at, c.updated_at,
    );
    return c;
  }

  rename(id: string, title: string): ConversationRecord {
    this.require(id);
    this.db.run(`UPDATE tal_conversations SET title = ?, updated_at = ? WHERE id = ?`, title, now(), id);
    return this.require(id);
  }

  touch(id: string): void {
    this.db.run(`UPDATE tal_conversations SET updated_at = ? WHERE id = ?`, now(), id);
  }

  setSummary(id: string, summary: string, upto: string): void {
    this.db.run(`UPDATE tal_conversations SET summary = ?, summary_upto = ? WHERE id = ?`, summary, upto, id);
  }

  delete(id: string): void {
    this.require(id);
    this.db.transaction(() => {
      this.db.run(`DELETE FROM tal_messages WHERE conversation_id = ?`, id);
      this.db.run(`DELETE FROM tal_conversations WHERE id = ?`, id);
    });
  }

  deleteAll(): number {
    return this.db.transaction(() => {
      this.db.run(`DELETE FROM tal_messages`);
      return this.db.run(`DELETE FROM tal_conversations`).changes;
    });
  }

  messages(conversationId: string, opts: { limit?: number; after?: string } = {}): ChatMessage[] {
    const rows = opts.after
      ? this.db.all<MessageRow>(
          `SELECT * FROM tal_messages WHERE conversation_id = ? AND created_at > ? ORDER BY created_at ASC, rowid ASC`,
          conversationId, opts.after,
        )
      : this.db.all<MessageRow>(
          `SELECT * FROM (SELECT *, rowid AS rid FROM tal_messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)
           ORDER BY created_at ASC, rid ASC`,
          conversationId, opts.limit ?? 500,
        );
    return rows.map(toMessage);
  }

  addMessage(input: {
    conversation_id: string;
    role: "user" | "assistant";
    content: string;
    tools?: ToolActivity[];
    status?: ChatMessage["status"];
    error?: string | null;
    id?: string;
  }): ChatMessage {
    const message: ChatMessage = {
      id: input.id ?? newId(),
      conversation_id: input.conversation_id,
      role: input.role,
      content: input.content,
      tools: input.tools ?? [],
      status: input.status ?? "complete",
      error: input.error ?? null,
      created_at: now(),
      source: "chat",
    };
    this.db.run(
      `INSERT INTO tal_messages (id, conversation_id, role, content, tools, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      message.id, message.conversation_id, message.role, message.content, JSON.stringify(message.tools),
      message.status, message.error, message.created_at,
    );
    this.touch(input.conversation_id);
    return message;
  }

  deleteMessage(id: string): void {
    this.db.run(`DELETE FROM tal_messages WHERE id = ?`, id);
  }

  lastMessage(conversationId: string): ChatMessage | null {
    const row = this.db.one<MessageRow>(
      `SELECT * FROM tal_messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      conversationId,
    );
    return row ? toMessage(row) : null;
  }
}
