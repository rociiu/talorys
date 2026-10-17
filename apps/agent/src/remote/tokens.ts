import {
  MAX_REMOTE_TOKENS,
  REMOTE_TOKEN_PREFIX,
  type RemoteScope,
  type RemoteTokenInfo,
  hmacSha256Hex,
  randomToken,
  remoteTokenCreateSchema,
} from "@talorys/shared";
import type { z } from "zod";
import { type Database, newId, now } from "../db/database";
import { AppError, ValidationError } from "../api/errors";
import { SESSION_IDLE_MS } from "../auth/auth-service";
import type { SettingsService } from "../services/settings";

/** Internal settings key, outside the exported Settings object, so a backup can neither carry nor set it. */
const ENABLED_KEY = "remote.enabled";
/** last_used_at is rewritten at most this often per token. */
const TOUCH_INTERVAL_MS = 60_000;
const MAX_TOKEN_LENGTH = 200;

/** Failed Bearer attempts per client count over this window. */
export const REMOTE_AUTH_WINDOW_MS = 15 * 60_000;
export const MAX_REMOTE_AUTH_FAILURES = 10;
/** Soft per-token limit: a fixed window held in memory, so it resets when the Durable Object restarts. */
export const REMOTE_RATE_WINDOW_MS = 60_000;
export const REMOTE_REQUESTS_PER_WINDOW = 120;
/** Daily auth failure counts are kept this many days. */
const AUTH_FAILURE_DAYS_KEPT = 30;
/** Daily remote-write counts are kept this many days. */
const WRITE_DAYS_KEPT = 30;
/** At most one remote.request activity row per token in this window (mirrors auth-failure coalesce). */
export const REMOTE_WRITE_ACTIVITY_WINDOW_MS = REMOTE_AUTH_WINDOW_MS;

function utcDay(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

interface TokenRow extends RemoteTokenInfo {
  token_hash: string;
}

export interface RemoteCaller {
  id: string;
  name: string;
  scope: RemoteScope;
}

/**
 * Named personal access tokens for machine clients. Off by default. Like sessions, the
 * database stores only HMAC(SESSION_SECRET, token): the plaintext is returned once by
 * create() and cannot be recovered from storage.
 */
export class RemoteTokenService {
  private readonly windows = new Map<string, { start: number; count: number }>();
  /** tokenId → start of the current write-activity coalesce window. */
  private readonly writeActivityWindows = new Map<string, number>();

  constructor(
    private readonly db: Database,
    private readonly settings: SettingsService,
    private readonly sessionSecret: string | undefined,
  ) {}

  isEnabled(): boolean {
    return this.settings.getJson<boolean>(ENABLED_KEY) === true;
  }

  /** Turning remote access off suspends every token; turning it back on restores them. */
  setEnabled(on: boolean): void {
    this.settings.setJson(ENABLED_KEY, on);
  }

  private secret(): string | null {
    return (this.sessionSecret?.length ?? 0) >= 32 ? this.sessionSecret! : null;
  }

  count(): number {
    return this.db.one<{ n: number }>(`SELECT count(*) AS n FROM tal_remote_tokens`)?.n ?? 0;
  }

  list(): RemoteTokenInfo[] {
    return this.db.all<RemoteTokenInfo>(
      `SELECT id, name, scope, hint, created_at, last_used_at FROM tal_remote_tokens ORDER BY created_at, rowid`,
    );
  }

  /**
   * Mints a token. When `sessionId` is given (the owner session that asked), it must still be
   * current at insert time, so a request authenticated before a password change cannot mint after it.
   */
  async create(input: z.input<typeof remoteTokenCreateSchema>, sessionId?: string | null): Promise<RemoteTokenInfo & { token: string }> {
    const parsed = remoteTokenCreateSchema.safeParse(input);
    if (!parsed.success) throw ValidationError.fromZod(parsed.error);
    const { name, scope } = parsed.data;
    const secret = this.secret();
    if (!secret) throw new AppError("NOT_CONFIGURED", "SESSION_SECRET must be set (at least 32 characters) before creating remote access tokens.");
    if (!this.isEnabled()) throw new AppError("FORBIDDEN", "Remote access is turned off. Turn it on in Settings first.");
    const token = REMOTE_TOKEN_PREFIX + randomToken(32);
    const hash = await hmacSha256Hex(secret, token);
    // Checks and insert run synchronously after the hash, so concurrent creates cannot pass the cap together.
    return this.db.transaction(() => {
      if (sessionId !== undefined && !this.sessionCurrent(sessionId)) {
        throw new AppError("UNAUTHORIZED", "Your session ended. Sign in again to create an access token.");
      }
      if (!this.isEnabled()) throw new AppError("FORBIDDEN", "Remote access is turned off. Turn it on in Settings first.");
      if (this.count() >= MAX_REMOTE_TOKENS) {
        throw new AppError("FORBIDDEN", `You can have at most ${MAX_REMOTE_TOKENS} remote access tokens. Revoke one first.`);
      }
      if (this.db.one(`SELECT 1 AS x FROM tal_remote_tokens WHERE lower(trim(name)) = lower(?)`, name)) {
        throw new AppError("CONFLICT", "A token with this name already exists.");
      }
      const info: RemoteTokenInfo = { id: newId(), name, scope, hint: token.slice(-4), created_at: now(), last_used_at: null };
      this.db.run(
        `INSERT INTO tal_remote_tokens (id, name, token_hash, hint, scope, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        info.id, info.name, hash, info.hint, info.scope, info.created_at,
      );
      return { ...info, token };
    });
  }

  private sessionCurrent(sessionId: string | null): boolean {
    if (!sessionId) return false;
    const row = this.db.one<{ expires_at: string; last_seen_at: string }>(
      `SELECT expires_at, last_seen_at FROM tal_sessions WHERE id = ?`,
      sessionId,
    );
    const nowMs = Date.now();
    return !!row && Date.parse(row.expires_at) > nowMs && Date.parse(row.last_seen_at) + SESSION_IDLE_MS > nowMs;
  }

  /** The token's identity when remote access is on and the token exists; otherwise null. */
  async validate(raw: string | undefined | null): Promise<RemoteCaller | null> {
    if (!this.isEnabled()) return null;
    const secret = this.secret();
    if (!secret || !raw || raw.length > MAX_TOKEN_LENGTH || !raw.startsWith(REMOTE_TOKEN_PREFIX)) return null;
    const hash = await hmacSha256Hex(secret, raw);
    const row = this.db.one<TokenRow>(`SELECT * FROM tal_remote_tokens WHERE token_hash = ?`, hash);
    if (!row) return null;
    const nowMs = Date.now();
    if (!row.last_used_at || nowMs - Date.parse(row.last_used_at) > TOUCH_INTERVAL_MS) {
      this.db.run(`UPDATE tal_remote_tokens SET last_used_at = ? WHERE id = ?`, new Date(nowMs).toISOString(), row.id);
    }
    return { id: row.id, name: row.name, scope: row.scope };
  }

  // ---------- Rate limiting ----------

  /** Throws RATE_LIMITED when the client has too many recent failed Bearer attempts, even with a good token. */
  assertAuthAllowed(client: string): void {
    const nowMs = Date.now();
    this.db.run(`DELETE FROM tal_remote_auth_failures WHERE at < ?`, nowMs - 24 * 3600_000);
    const row = this.db.one<{ n: number; oldest: number | null }>(
      `SELECT count(*) AS n, min(at) AS oldest FROM tal_remote_auth_failures WHERE client = ? AND at > ?`,
      client,
      nowMs - REMOTE_AUTH_WINDOW_MS,
    );
    if ((row?.n ?? 0) < MAX_REMOTE_AUTH_FAILURES) return;
    // Counted for telemetry only: adding a throttle row here would extend the lockout.
    this.countAuthFailure();
    const retryAfter = Math.max(1, Math.ceil(((row?.oldest ?? nowMs) + REMOTE_AUTH_WINDOW_MS - nowMs) / 1000));
    throw new AppError("RATE_LIMITED", "Too many failed access token attempts. Please wait before trying again.", { retry_after: retryAfter }, {
      "retry-after": String(retryAfter),
    });
  }

  /** Counts one rejected Bearer attempt. True when it is the client's first in the current window. */
  recordAuthFailure(client: string): boolean {
    const nowMs = Date.now();
    const prior = this.db.one<{ n: number }>(
      `SELECT count(*) AS n FROM tal_remote_auth_failures WHERE client = ? AND at > ?`,
      client,
      nowMs - REMOTE_AUTH_WINDOW_MS,
    )?.n ?? 0;
    this.db.run(`INSERT INTO tal_remote_auth_failures (client, at) VALUES (?, ?)`, client, nowMs);
    this.countAuthFailure();
    return prior === 0;
  }

  /** Rejected Bearer attempts today (UTC), throttled ones included. */
  authFailuresToday(): number {
    return this.db.one<{ failures: number }>(`SELECT failures FROM tal_remote_auth_failure_days WHERE day = ?`, utcDay())?.failures ?? 0;
  }

  private countAuthFailure(): void {
    const day = utcDay();
    this.db.run(
      `INSERT INTO tal_remote_auth_failure_days (day, failures) VALUES (?, 1)
       ON CONFLICT(day) DO UPDATE SET failures = failures + 1`,
      day,
    );
    this.db.run(`DELETE FROM tal_remote_auth_failure_days WHERE day < ?`, utcDay(new Date(Date.now() - AUTH_FAILURE_DAYS_KEPT * 86400_000)));
  }

  /**
   * Counts one remote write toward the daily per-token counter. True when this token should
   * also get a coalesced `remote.request` activity row (first write in the coalesce window).
   */
  recordWrite(tokenId: string): boolean {
    this.countWrite(tokenId);
    const nowMs = Date.now();
    const start = this.writeActivityWindows.get(tokenId);
    if (start !== undefined && nowMs - start < REMOTE_WRITE_ACTIVITY_WINDOW_MS) return false;
    this.writeActivityWindows.set(tokenId, nowMs);
    return true;
  }

  /** Remote writes today (UTC) for one token, or across all tokens when omitted. */
  writesToday(tokenId?: string): number {
    if (tokenId) {
      return this.db.one<{ writes: number }>(
        `SELECT writes FROM tal_remote_write_days WHERE day = ? AND token_id = ?`,
        utcDay(),
        tokenId,
      )?.writes ?? 0;
    }
    return this.db.one<{ writes: number }>(
      `SELECT coalesce(sum(writes), 0) AS writes FROM tal_remote_write_days WHERE day = ?`,
      utcDay(),
    )?.writes ?? 0;
  }

  private countWrite(tokenId: string): void {
    const day = utcDay();
    this.db.run(
      `INSERT INTO tal_remote_write_days (day, token_id, writes) VALUES (?, ?, 1)
       ON CONFLICT(day, token_id) DO UPDATE SET writes = writes + 1`,
      day,
      tokenId,
    );
    this.db.run(
      `DELETE FROM tal_remote_write_days WHERE day < ?`,
      utcDay(new Date(Date.now() - WRITE_DAYS_KEPT * 86400_000)),
    );
  }

  /** Counts one request against the token's window; throws RATE_LIMITED past the limit. */
  assertWithinRate(tokenId: string): void {
    const nowMs = Date.now();
    let window = this.windows.get(tokenId);
    if (!window || nowMs - window.start >= REMOTE_RATE_WINDOW_MS) {
      window = { start: nowMs, count: 0 };
      this.windows.set(tokenId, window);
    }
    if (++window.count <= REMOTE_REQUESTS_PER_WINDOW) return;
    const retryAfter = Math.max(1, Math.ceil((window.start + REMOTE_RATE_WINDOW_MS - nowMs) / 1000));
    throw new AppError("RATE_LIMITED", "Too many requests for this access token.", { retry_after: retryAfter }, {
      "retry-after": String(retryAfter),
    });
  }

  /** Deletes the token, destroying the credential. */
  revoke(id: string): boolean {
    this.windows.delete(id);
    this.writeActivityWindows.delete(id);
    return this.db.run(`DELETE FROM tal_remote_tokens WHERE id = ?`, id).changes > 0;
  }

  revokeAll(): number {
    this.windows.clear();
    this.writeActivityWindows.clear();
    return this.db.run(`DELETE FROM tal_remote_tokens`).changes;
  }
}
