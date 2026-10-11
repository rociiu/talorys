import type { ChatMessage, PendingAction } from "@talorys/shared";
import { type Database, newId, now } from "../database";

/** How long the owner has to approve a proposed destructive action. */
export const PENDING_ACTION_TTL_MS = 30 * 60_000;

export interface StoredPendingAction {
  id: string;
  conversation_id: string;
  tool: string;
  target_id: string;
  summary: string;
  status: "pending" | "approved" | "cancelled" | "failed";
  error: string | null;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
}

function present(row: StoredPendingAction): PendingAction {
  const expired = row.status === "pending" && row.expires_at <= now();
  return { id: row.id, summary: row.summary, status: expired ? "expired" : row.status, error: row.error, expires_at: row.expires_at };
}

/**
 * Destructive actions proposed by the agent. The agent can only create them; running one
 * requires the owner to approve that exact id through the API.
 */
export class PendingActionRepository {
  constructor(private readonly db: Database) {}

  create(input: { conversation_id: string; tool: string; target_id: string; summary: string }): PendingAction {
    const createdAt = now();
    const row: StoredPendingAction = {
      id: newId(),
      ...input,
      status: "pending",
      error: null,
      created_at: createdAt,
      expires_at: new Date(Date.parse(createdAt) + PENDING_ACTION_TTL_MS).toISOString(),
      resolved_at: null,
    };
    this.db.run(
      `INSERT INTO tal_pending_actions (id, conversation_id, tool, target_id, summary, status, error, created_at, expires_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?, NULL)`,
      row.id, row.conversation_id, row.tool, row.target_id, row.summary, row.created_at, row.expires_at,
    );
    this.db.run(`DELETE FROM tal_pending_actions WHERE status = 'pending' AND expires_at < ?`, createdAt);
    this.db.run(`DELETE FROM tal_pending_actions WHERE created_at < ?`, new Date(Date.now() - 30 * 86_400_000).toISOString());
    return present(row);
  }

  get(id: string): StoredPendingAction | null {
    return this.db.one<StoredPendingAction>(`SELECT * FROM tal_pending_actions WHERE id = ?`, id);
  }

  view(id: string): PendingAction | null {
    const row = this.get(id);
    return row ? present(row) : null;
  }

  /**
   * Atomically moves a pending, unexpired action to `status`. Returns false if it was
   * already resolved or has expired, so an action can run at most once.
   */
  resolve(id: string, status: "approved" | "cancelled"): boolean {
    const at = now();
    return (
      this.db.run(
        `UPDATE tal_pending_actions SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending' AND expires_at > ?`,
        status, at, id, at,
      ).changes === 1
    );
  }

  /**
   * Cleans up expired pending actions past their expiration date.
   * If olderThanMs is provided, only deletes actions that expired at least olderThanMs ago.
   */
  cleanupExpired(olderThanMs: number = 0): number {
    const threshold = new Date(Date.now() - olderThanMs).toISOString();
    return this.db.run(
      `DELETE FROM tal_pending_actions WHERE status = 'pending' AND expires_at < ?`,
      threshold,
    ).changes;
  }

  /** Refreshes approval cards stored on messages with each action's current status. */
  withCurrentStatus(messages: ChatMessage[]): ChatMessage[] {
    if (!Array.isArray(messages)) return [];
    return messages.map((m) =>
      m?.tools && Array.isArray(m.tools) && m.tools.some((t) => t?.approval)
        ? { ...m, tools: m.tools.map((t) => (t?.approval ? { ...t, approval: this.view(t.approval.id) ?? t.approval } : t)) }
        : m,
    );
  }

  markFailed(id: string, error?: string | null): void {
    const at = now();
    const safeError = typeof error === "string" ? error.slice(0, 300) : String(error ?? "The action failed.").slice(0, 300);
    this.db.run(
      `UPDATE tal_pending_actions SET status = 'failed', error = ?, resolved_at = COALESCE(resolved_at, ?) WHERE id = ?`,
      safeError,
      at,
      id,
    );
  }
}
