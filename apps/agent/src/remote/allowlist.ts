/** A resource id in an allowlisted path: a UUID, as `newId()` mints them. */
export const REMOTE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Path segments a token can never reach, even if a future pattern would match them. */
export const REMOTE_DENIED_SEGMENTS: readonly string[] = ["reviews", "history", "correct", "status", "notifications", "import", "export"];

const COLLECTIONS = new Set(["tasks", "notes", "automations", "memories"]);
const COLLECTION_METHODS = new Set(["GET", "POST"]);
const ITEM_METHODS = new Set(["GET", "PATCH", "DELETE"]);
const EXACT = new Set(["GET /api/semantic/search", "GET /api/health"]);

/**
 * Default deny: true only for the method and exact raw pathname pairs a Bearer token may call.
 * HEAD counts as GET. The pathname is matched as sent, so a percent-encoded or trailing-slash
 * variant of an allowed route is denied rather than decoded into one.
 */
export function isRemoteAllowed(method: string, path: string): boolean {
  const m = method === "HEAD" ? "GET" : method;
  const segments = path.split("/");
  if (segments.some((s) => REMOTE_DENIED_SEGMENTS.includes(s))) return false;
  if (EXACT.has(`${m} ${path}`)) return true;
  const [empty, api, collection, id, ...rest] = segments;
  if (empty !== "" || api !== "api" || !collection || !COLLECTIONS.has(collection) || rest.length) return false;
  if (id === undefined) return COLLECTION_METHODS.has(m);
  return REMOTE_ID_PATTERN.test(id) && ITEM_METHODS.has(m);
}
