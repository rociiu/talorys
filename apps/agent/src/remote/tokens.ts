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
import type { SettingsService } from "../services/settings";

/** Internal settings key, outside the exported Settings object, so a backup can neither carry nor set it. */
const ENABLED_KEY = "remote.enabled";
/** last_used_at is rewritten at most this often per token. */
const TOUCH_INTERVAL_MS = 60_000;
const MAX_TOKEN_LENGTH = 200;

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

  async create(input: z.input<typeof remoteTokenCreateSchema>): Promise<RemoteTokenInfo & { token: string }> {
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

  /** Deletes the token, destroying the credential. */
  revoke(id: string): boolean {
    return this.db.run(`DELETE FROM tal_remote_tokens WHERE id = ?`, id).changes > 0;
  }

  revokeAll(): number {
    return this.db.run(`DELETE FROM tal_remote_tokens`).changes;
  }
}
