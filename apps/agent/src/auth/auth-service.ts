import {
  type SessionInfo,
  checkPasswordStrength,
  hashPassword,
  hmacSha256Hex,
  isPasswordHash,
  randomToken,
  sha256Hex,
  timingSafeEqual,
  verifyPassword,
} from "@talorys/shared";
import type { Database } from "../db/database";
import type { SettingsService } from "../services/settings";
import { AppError, ValidationError } from "../api/errors";

export const SESSION_TTL_MS = 30 * 24 * 3600_000; // absolute lifetime
export const SESSION_IDLE_MS = 14 * 24 * 3600_000; // idle timeout
const TOUCH_INTERVAL_MS = 5 * 60_000;

export const LOGIN_WINDOW_MS = 15 * 60_000;
export const MAX_FAILURES_PER_CLIENT = 5;
export const MAX_FAILURES_GLOBAL = 25;
/** A network with a successful sign-in this recent is the owner's, and exempt from the global cap. */
export const TRUSTED_CLIENT_MS = 30 * 24 * 3600_000;

const OVERRIDE_KEY = "auth.password_override";
const FINGERPRINT_KEY = "auth.secret_fingerprint";

interface SessionRow {
  id: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  user_agent: string;
}

export interface AuthSecrets {
  passwordHash?: string;
  /** Plain owner password, for deploys that cannot hash it ahead of time. Used only without a valid passwordHash. */
  password?: string;
  sessionSecret?: string;
}

/**
 * Single-owner authentication.
 *
 * The installer stores a PBKDF2 hash of the owner password as the Worker secret
 * OWNER_PASSWORD_HASH; a one-Worker deploy may set the plain OWNER_PASSWORD
 * instead. Password changes from the UI are stored as an override in the
 * Durable Object. Resetting the password via the CLI replaces the secret,
 * which changes its fingerprint: the override is discarded and all sessions revoked.
 *
 * Session tokens are random 256-bit values held only in an HttpOnly cookie. The
 * database stores HMAC(SESSION_SECRET, token), so a storage leak cannot be replayed.
 */
export class AuthService {
  constructor(
    private readonly db: Database,
    private readonly settings: SettingsService,
    private readonly secrets: AuthSecrets,
  ) {}

  private secretHash(): string | null {
    return isPasswordHash(this.secrets.passwordHash) ? this.secrets.passwordHash! : null;
  }

  /** A valid hash, or a plain password that passes the same strength check as the installer. */
  passwordConfigured(): boolean {
    const { password } = this.secrets;
    return this.secretHash() !== null || (!!password && checkPasswordStrength(password) === null);
  }

  isConfigured(): boolean {
    return this.passwordConfigured() && (this.secrets.sessionSecret?.length ?? 0) >= 32;
  }

  private requireConfigured(): { sessionSecret: string } {
    if (!this.isConfigured()) {
      throw new AppError(
        "NOT_CONFIGURED",
        "Owner credentials are not configured. Run the Talorys installer, or set a strong OWNER_PASSWORD and SESSION_SECRET with `wrangler secret put`.",
      );
    }
    return { sessionSecret: this.secrets.sessionSecret! };
  }

  /** Detects a CLI password reset (secret changed) and invalidates stale state, remote tokens included. */
  async syncSecretFingerprint(): Promise<void> {
    const { sessionSecret } = this.requireConfigured();
    const secret = this.secretHash() ?? `plain$${await hmacSha256Hex(sessionSecret, this.secrets.password!)}`;
    const fingerprint = (await sha256Hex(secret)).slice(0, 32);
    const stored = this.settings.getJson<string>(FINGERPRINT_KEY);
    if (stored === fingerprint) return;
    this.db.transaction(() => {
      if (stored !== null) {
        this.settings.delete(OVERRIDE_KEY);
        this.db.run(`DELETE FROM tal_sessions`);
        this.db.run(`DELETE FROM tal_remote_tokens`);
      }
      this.settings.setJson(FINGERPRINT_KEY, fingerprint);
    });
  }

  private async checkPassword(password: string): Promise<boolean> {
    const hash = this.settings.getJson<string>(OVERRIDE_KEY) ?? this.secretHash();
    if (hash) return verifyPassword(password, hash);
    const { sessionSecret } = this.requireConfigured();
    const encode = (value: string) => new TextEncoder().encode(value);
    const [given, expected] = await Promise.all([
      hmacSha256Hex(sessionSecret, password.normalize("NFKC")),
      hmacSha256Hex(sessionSecret, this.secrets.password!.normalize("NFKC")),
    ]);
    return timingSafeEqual(encode(given), encode(expected));
  }

  // ---------- Rate limiting ----------

  private recentFailures(client?: string): number {
    const since = Date.now() - LOGIN_WINDOW_MS;
    const row = client
      ? this.db.one<{ n: number }>(`SELECT count(*) AS n FROM tal_login_attempts WHERE success = 0 AND at > ? AND client = ?`, since, client)
      : this.db.one<{ n: number }>(`SELECT count(*) AS n FROM tal_login_attempts WHERE success = 0 AND at > ?`, since);
    return row?.n ?? 0;
  }

  /** True when this client signed in successfully within TRUSTED_CLIENT_MS: one of the owner's own networks. */
  private isTrustedClient(client: string): boolean {
    const since = Date.now() - TRUSTED_CLIENT_MS;
    return !!this.db.one(`SELECT 1 AS x FROM tal_login_attempts WHERE success = 1 AND client = ? AND at > ? LIMIT 1`, client, since);
  }

  /**
   * Throws RATE_LIMITED when the client has too many recent failures, or when a distributed
   * attack has tripped the global cap. The owner's recent networks are exempt from the global
   * cap only, so strangers cannot lock the owner out; their per-client limit still applies.
   */
  assertLoginAllowed(client: string): void {
    const nowMs = Date.now();
    // Failures matter for a day; successes are kept as long as they mark a trusted network.
    this.db.run(`DELETE FROM tal_login_attempts WHERE (success = 0 AND at < ?) OR at < ?`, nowMs - 24 * 3600_000, nowMs - TRUSTED_CLIENT_MS);
    const clientBlocked = this.recentFailures(client) >= MAX_FAILURES_PER_CLIENT;
    if (clientBlocked || (this.recentFailures() >= MAX_FAILURES_GLOBAL && !this.isTrustedClient(client))) {
      const oldest = this.db.one<{ at: number }>(
        `SELECT min(at) AS at FROM tal_login_attempts WHERE success = 0 AND at > ?`,
        Date.now() - LOGIN_WINDOW_MS,
      );
      const retryAfter = Math.max(1, Math.ceil(((oldest?.at ?? Date.now()) + LOGIN_WINDOW_MS - Date.now()) / 1000));
      throw new AppError("RATE_LIMITED", "Too many failed attempts. Please wait before trying again.", { retry_after: retryAfter }, {
        "retry-after": String(retryAfter),
      });
    }
  }

  /**
   * Checks the limit and records the attempt as a failure in one synchronous step,
   * before the (async) password check. Otherwise concurrent requests could all pass
   * the check while PBKDF2 runs and bypass the limit. Returns the attempt id.
   */
  private beginAttempt(client: string): number {
    this.assertLoginAllowed(client);
    return this.db.one<{ id: number }>(
      `INSERT INTO tal_login_attempts (client, success, at) VALUES (?, 0, ?) RETURNING id`,
      client,
      Date.now(),
    )!.id;
  }

  private markAttemptSucceeded(attemptId: number): void {
    this.db.run(`UPDATE tal_login_attempts SET success = 1 WHERE id = ?`, attemptId);
  }

  // ---------- Login / sessions ----------

  async login(password: string, client: string, userAgent: string): Promise<{ token: string; expiresAt: Date }> {
    this.requireConfigured();
    await this.syncSecretFingerprint();
    const attempt = this.beginAttempt(client);
    const ok = await this.checkPassword(password);
    if (!ok) throw new AppError("UNAUTHORIZED", "Incorrect password.");
    this.markAttemptSucceeded(attempt);
    return this.createSession(userAgent);
  }

  private async sessionId(token: string): Promise<string> {
    return hmacSha256Hex(this.requireConfigured().sessionSecret, token);
  }

  async createSession(userAgent: string): Promise<{ token: string; expiresAt: Date }> {
    const token = randomToken(32);
    const id = await this.sessionId(token);
    const ts = new Date();
    const expiresAt = new Date(ts.getTime() + SESSION_TTL_MS);
    this.db.run(
      `INSERT INTO tal_sessions (id, created_at, last_seen_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)`,
      id, ts.toISOString(), ts.toISOString(), expiresAt.toISOString(), userAgent.slice(0, 300),
    );
    // Cap concurrent sessions; drop the least recently used beyond 20.
    this.db.run(`DELETE FROM tal_sessions WHERE id NOT IN (SELECT id FROM tal_sessions ORDER BY last_seen_at DESC LIMIT 20)`);
    return { token, expiresAt };
  }

  /** Returns the session id when the token is valid; otherwise null. */
  async validate(token: string | undefined | null): Promise<string | null> {
    if (!token || token.length > 200 || !this.isConfigured()) return null;
    await this.syncSecretFingerprint();
    const id = await this.sessionId(token);
    const row = this.db.one<SessionRow>(`SELECT * FROM tal_sessions WHERE id = ?`, id);
    if (!row) return null;
    const nowMs = Date.now();
    if (Date.parse(row.expires_at) <= nowMs || Date.parse(row.last_seen_at) + SESSION_IDLE_MS <= nowMs) {
      this.db.run(`DELETE FROM tal_sessions WHERE id = ?`, id);
      return null;
    }
    if (nowMs - Date.parse(row.last_seen_at) > TOUCH_INTERVAL_MS) {
      this.db.run(`UPDATE tal_sessions SET last_seen_at = ? WHERE id = ?`, new Date(nowMs).toISOString(), id);
    }
    return id;
  }

  revoke(sessionId: string): void {
    this.db.run(`DELETE FROM tal_sessions WHERE id = ?`, sessionId);
  }

  revokeAllExcept(sessionId: string | null): number {
    return this.db.run(`DELETE FROM tal_sessions WHERE id != ?`, sessionId ?? "").changes;
  }

  listSessions(currentId: string | null): SessionInfo[] {
    return this.db
      .all<SessionRow>(`SELECT * FROM tal_sessions ORDER BY last_seen_at DESC`)
      .map((s) => ({ ...s, id: s.id.slice(0, 16), current: s.id === currentId }));
  }

  /** Revokes a session by the shortened public id shown in the UI. */
  revokeByPublicId(publicId: string): boolean {
    if (!/^[0-9a-f]{16}$/.test(publicId)) return false;
    return this.db.run(`DELETE FROM tal_sessions WHERE substr(id, 1, 16) = ?`, publicId).changes > 0;
  }

  async changePassword(current: string, next: string, keepSessionId: string | null, client: string): Promise<void> {
    this.requireConfigured();
    await this.syncSecretFingerprint();
    const attempt = this.beginAttempt(client);
    if (!(await this.checkPassword(current))) {
      throw new AppError("UNAUTHORIZED", "Current password is incorrect.");
    }
    this.markAttemptSucceeded(attempt);
    const problem = checkPasswordStrength(next);
    if (problem) throw new ValidationError(problem);
    const hash = await hashPassword(next);
    this.db.transaction(() => {
      this.settings.setJson(OVERRIDE_KEY, hash);
      this.revokeAllExcept(keepSessionId);
      this.db.run(`DELETE FROM tal_remote_tokens`);
    });
  }
}
