import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../api/app";
import { AppError } from "../api/errors";
import { isRemoteAllowed } from "./allowlist";

const BEARER = /^Bearer (\S+)$/;

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
  const raw = BEARER.exec(header)?.[1];
  if (raw && auth.isConfigured()) await auth.syncSecretFingerprint();
  const caller = raw ? await remote.validate(raw) : null;
  if (!caller) throw new AppError("UNAUTHORIZED", "Invalid or revoked access token.");
  const method = c.req.method;
  if (!isRemoteAllowed(method, new URL(c.req.url).pathname)) {
    throw new AppError("FORBIDDEN", "This route is not available to access tokens.");
  }
  if (caller.scope === "read" && method !== "GET" && method !== "HEAD") {
    throw new AppError("FORBIDDEN", "This access token is read-only.");
  }
  c.set("remote", caller);
  return next();
};
