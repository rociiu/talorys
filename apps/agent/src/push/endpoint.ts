/** Hosts that only make sense on a private network. */
const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan"];

/**
 * Push endpoints come from the browser, so they are untrusted URLs the Worker will POST to.
 * Real push services (FCM, Mozilla, Apple, WNS) are public HTTPS hostnames, so anything else
 * is refused: other schemes, credentials in the URL, IP literals and private-network names.
 * Returns why the endpoint is refused, or null when it is acceptable.
 */
export function endpointProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "Push endpoint is not a valid URL.";
  }
  if (url.protocol !== "https:") return "Push endpoint must use https.";
  if (url.username || url.password) return "Push endpoint must not contain credentials.";
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  // URL normalises every IPv4 spelling (decimal, hex, octal) to dotted form; IPv6 keeps its brackets.
  if (host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return "Push endpoint must use a hostname, not an IP address.";
  if (!host.includes(".") || host === "localhost" || PRIVATE_SUFFIXES.some((s) => host.endsWith(s))) {
    return "Push endpoint must be a public push service.";
  }
  return null;
}
