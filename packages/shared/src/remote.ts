import { z } from "zod";

/** What a remote access token may do: `read` calls GET routes only, `write` also changes data. */
export const REMOTE_SCOPES = ["read", "write"] as const;
export type RemoteScope = (typeof REMOTE_SCOPES)[number];

/** Most remote access tokens one owner can hold at once. */
export const MAX_REMOTE_TOKENS = 20;

/** Every remote access token starts with this, so a leaked one is easy to recognise. */
export const REMOTE_TOKEN_PREFIX = "tal_";

export const remoteTokenCreateSchema = z.object({
  name: z.string().trim().min(1).max(64),
  scope: z.enum(REMOTE_SCOPES).optional().default("read"),
});

export const remoteStatusSchema = z.object({ enabled: z.boolean() });

/** A remote access token as the owner sees it. The token itself is shown once, at creation. */
export interface RemoteTokenInfo {
  id: string;
  name: string;
  scope: RemoteScope;
  /** Last 4 characters of the token, shown as `tal_…abcd`. */
  hint: string;
  created_at: string;
  last_used_at: string | null;
}
