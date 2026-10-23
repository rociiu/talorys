import { CSRF_HEADER, DEV_SESSION_COOKIE, SESSION_COOKIE } from "@talorys/shared";
import type { Context, MiddlewareHandler } from "hono";
import type { z } from "zod";
import type { AppEnv } from "./app";
import { AppError, ValidationError } from "./errors";

/** Routes reachable without a session. Nothing here can claim ownership or read owner data. */
const PUBLIC_ROUTES = new Set(["GET /api/health", "POST /api/auth/login", "GET /api/auth/session"]);

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.res.headers.set("cache-control", "no-store");
  c.res.headers.set("x-content-type-options", "nosniff");
  c.res.headers.set("referrer-policy", "same-origin");
};

function isDevelopment(c: Context<AppEnv>): boolean {
  return c.env.env.TALORYS_ENV === "development";
}

function allowedOrigins(c: Context<AppEnv>): Set<string> {
  const origins = new Set([new URL(c.req.url).origin]);
  if (isDevelopment(c)) {
    for (const o of (c.env.env.TALORYS_DEV_ORIGINS ?? "").split(",")) if (o.trim()) origins.add(o.trim());
  }
  return origins;
}

/**
 * CSRF defence in depth for state-changing requests:
 *  1. SameSite=Strict session cookie (set at login),
 *  2. a custom request header that cross-site forms cannot send without a CORS preflight (never granted),
 *  3. Origin / Sec-Fetch-Site verification.
 */
export const csrfProtection: MiddlewareHandler<AppEnv> = async (c, next) => {
  // Set only after `remoteAuth` validated a token; a header alone never skips this check.
  if (c.get("remote")) return next();
  if (SAFE_METHODS.has(c.req.method)) return next();
  if (c.req.header(CSRF_HEADER) !== "1") {
    throw new AppError("FORBIDDEN", "Missing CSRF header.");
  }
  const origin = c.req.header("origin");
  if (origin) {
    if (!allowedOrigins(c).has(origin)) throw new AppError("FORBIDDEN", "Cross-origin request rejected.");
  } else {
    const site = c.req.header("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") throw new AppError("FORBIDDEN", "Cross-site request rejected.");
  }
  return next();
};

export function sessionCookieName(c: Context<AppEnv>): string {
  return new URL(c.req.url).protocol === "https:" ? SESSION_COOKIE : DEV_SESSION_COOKIE;
}

export function readSessionToken(c: Context<AppEnv>): string | null {
  const header = c.req.header("cookie");
  if (!header) return null;
  const name = sessionCookieName(c);
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) {
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        // Not something this app ever issued (it encodes the token), so treat it as no session.
        return null;
      }
    }
  }
  return null;
}

export function sessionCookie(c: Context<AppEnv>, token: string, expires: Date | null): string {
  const secure = new URL(c.req.url).protocol === "https:";
  const attrs = [
    `${sessionCookieName(c)}=${expires ? encodeURIComponent(token) : ""}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    expires ? `Expires=${expires.toUTCString()}` : "Max-Age=0",
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("remote")) {
    c.set("sessionId", null);
    return next();
  }
  const route = `${c.req.method} ${new URL(c.req.url).pathname.replace(/\/$/, "")}`;
  const token = readSessionToken(c);
  const sessionId = token ? await c.env.agent.services.auth.validate(token) : null;
  c.set("sessionId", sessionId);
  if (!sessionId && !PUBLIC_ROUTES.has(route)) {
    throw new AppError("UNAUTHORIZED", "Please sign in.");
  }
  return next();
};

/** Parses and validates a JSON body with a Zod schema, with a size limit. */
export async function body<S extends z.ZodType>(c: Context<AppEnv>, schema: S, maxBytes = 256 * 1024): Promise<z.infer<S>> {
  const length = Number(c.req.header("content-length") ?? "0");
  if (length > maxBytes) throw new ValidationError("Request body too large.");
  let raw: unknown;
  try {
    const text = await readLimited(c.req.raw, maxBytes);
    raw = text ? JSON.parse(text) : {};
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new ValidationError("Request body must be valid JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error);
  return parsed.data;
}

/**
 * Reads a body as UTF-8, counting bytes as they arrive and cancelling once past the limit.
 * Content-Length alone is not enough: a streamed body has none and would be read in full.
 */
async function readLimited(request: Request, maxBytes: number): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ValidationError("Request body too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export function query<S extends z.ZodType>(c: Context<AppEnv>, schema: S): z.infer<S> {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) throw ValidationError.fromZod(parsed.error);
  return parsed.data;
}

export function clientId(c: Context<AppEnv>): string {
  // Set by Cloudflare's edge and not spoofable by clients; absent only in local development.
  return clientKey(c.req.header("cf-connecting-ip") ?? "local");
}

function ipv4Octets(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

/** Eight hextets, or null when `addr` is not an IPv6 address. A trailing dotted quad is two hextets. */
function expandIPv6(addr: string): number[] | null {
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const pieces = (half: string): number[] | null => {
    if (!half) return [];
    const out: number[] = [];
    for (const part of half.split(":")) {
      if (part.includes(".")) {
        const octets = ipv4Octets(part);
        if (!octets) return null;
        out.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
      } else if (/^[0-9a-f]{1,4}$/.test(part)) {
        out.push(Number.parseInt(part, 16));
      } else {
        return null;
      }
    }
    return out;
  };
  const left = pieces(halves[0] ?? "");
  const right = halves.length === 2 ? pieces(halves[1] ?? "") : [];
  if (!left || !right) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  return [...left, ...Array(missing).fill(0), ...right];
}

/**
 * Rate-limit key for a client IP. IPv6 is grouped by /64: one subscriber usually holds a
 * whole /64 and could otherwise rotate addresses for a fresh allowance on every guess.
 * IPv4-mapped addresses (::ffff:192.0.2.1, ::ffff:c000:201, and the expanded form) stay
 * per IPv4 address, or they all collapse into the same ::/64 bucket as ::1.
 */
export function clientKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  const addr = ip.toLowerCase().split("%")[0]!;
  const groups = expandIPv6(addr);
  if (groups) {
    const mapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
    if (mapped) {
      const hi = groups[6]!;
      const lo = groups[7]!;
      return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
    }
    return `${groups.slice(0, 4).map((g) => g.toString(16)).join(":")}::/64`;
  }
  const [head = "", tail = ""] = addr.split("::");
  const left = head ? head.split(":") : [];
  const right = addr.includes("::") && tail ? tail.split(":") : [];
  const zeros = addr.includes("::") ? Array(Math.max(0, 8 - left.length - right.length)).fill("0") : [];
  return `${[...left, ...zeros, ...right].slice(0, 4).map((g) => (Number.parseInt(g, 16) || 0).toString(16)).join(":")}::/64`;
}
