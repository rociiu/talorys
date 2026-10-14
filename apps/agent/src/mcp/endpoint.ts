/** Reject endpoints that could reach local services or cloud metadata. */
export function mcpUrlProblem(raw: string, { allowLocal = false } = {}): string | null {
  if (raw.length > 2048) return "Server URL is too long.";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "Invalid server URL.";
  }
  if (url.username || url.password) return "URL credentials are not allowed.";
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (allowLocal && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(host) && url.port) return null;
  if (url.protocol !== "https:") return "MCP servers require HTTPS.";
  if (/^[\d.]+$/.test(host) || host.includes(":") || host.includes("[") || !host.includes("."))
    return "IP literals and single-label hosts are not allowed.";
  if (host === "localhost" || /(?:^|\.)(?:localhost|local|internal|home\.arpa)$/.test(host)) return "Private hosts are not allowed.";
  return null;
}
