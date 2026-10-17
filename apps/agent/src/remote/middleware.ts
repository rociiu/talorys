import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../api/app";
import { AppError } from "../api/errors";
import { clientId } from "../api/middleware";
import { isRemoteAllowed, REMOTE_ID_PATTERN } from "./allowlist";
import type { RemoteCaller } from "./tokens";

const BEARER = /^Bearer (\S+)$/;

/**
 * Id of the created resource in a 201 JSON body: the `id` of its first object-valued property
 * (`task`, `note`, `memory`, `automation`). Unreadable bodies just leave it out.
 */
async function createdId(res: Response): Promise<string | null> {
  try {
    const json = (await res.clone().json()) as Record<string, unknown>;
    for (const value of Object.values(json)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const id = (value as { id?: unknown }).id;
        return typeof id === "string" ? id : null;
      }
    }
  } catch {
    /* not JSON */
  }
  return null;
}

/**
 * One coalesced `remote.request` activity entry for a write (at most one per token per window),
 * plus always a daily counter bump. Summary carries token name and id prefix, method, path,
 * status and the resource id. Never bodies, query strings or the token itself.
 */
async function recordRequest(c: Context<AppEnv>, caller: RemoteCaller, status: number): Promise<void> {
  const log = c.env.agent.services.remote.recordWrite(caller.id);
  if (!log) return;
  const { pathname } = new URL(c.req.url);
  const last = pathname.split("/").pop() ?? "";
  const id = c.req.method === "POST" && status === 201 ? await createdId(c.res) : REMOTE_ID_PATTERN.test(last) ? last : null;
  const summary = `${caller.name} (${caller.id.slice(0, 8)}) ${c.req.method} ${pathname} → ${status}${id ? ` ${id}` : ""}`;
  c.env.agent.services.activity.record("remote.request", summary);
}

/**
 * Bearer authentication for personal access tokens. Fails closed: once an Authorization header
 * is present it must carry a valid token, and a cookie never rescues a bad one. Only a validated
 * token sets `remote`, which is what lets the request skip the CSRF and session checks.
 */
export const remoteAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header("authorization");
  if (header === undefined) {
    c.set("remote", null);
    return next();
  }
  const { auth, remote } = c.env.agent.services;
  const client = clientId(c);
  // Before validation, so a throttled client is refused even with a correct token.
  remote.assertAuthAllowed(client);
  const raw = BEARER.exec(header)?.[1];
  // Without owner credentials the cookie path rejects everything, so a retained token must too.
  // It fails like an invalid token, so the response does not reveal the configuration state.
  const configured = auth.isConfigured();
  if (raw && configured) await auth.syncSecretFingerprint();
  const caller = raw && configured ? await remote.validate(raw) : null;
  if (!caller) {
    // Counts every rejection, a token presented while remote access is off included. The shared
    // activity log gets at most one entry per client per throttle window, and none while remote
    // access is off, so a flood of bad tokens cannot push owner events out of it.
    const first = remote.recordAuthFailure(client);
    if (first && remote.isEnabled()) {
      c.env.agent.services.activity.record("remote.auth_failed", `Rejected access token from client ${client}`);
    }
    throw new AppError("UNAUTHORIZED", "Invalid or revoked access token.");
  }
  remote.assertWithinRate(caller.id);
  const method = c.req.method;
  // Reads are not logged: they would flush the activity log, and `last_used_at` covers them.
  const write = method !== "GET" && method !== "HEAD";
  const deny = async (message: string): Promise<never> => {
    if (write) await recordRequest(c, caller, 403);
    throw new AppError("FORBIDDEN", message);
  };
  if (!isRemoteAllowed(method, new URL(c.req.url).pathname)) await deny("This route is not available to access tokens.");
  if (caller.scope === "read" && write) await deny("This access token is read-only.");
  c.set("remote", caller);
  if (!write) return next();
  let thrown: unknown;
  try {
    await next();
  } catch (error) {
    thrown = error;
    throw error;
  } finally {
    // Hono normally turns a handler error into `c.res`; the catch covers one that escapes.
    const status = thrown === undefined ? c.res.status : thrown instanceof AppError ? thrown.status : 500;
    await recordRequest(c, caller, status);
  }
};
