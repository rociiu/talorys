/**
 * The browser push services a subscription may point at. Exact hosts, or parents whose
 * subdomains are all that service (Apple and Microsoft use per-region hosts).
 * Extend this when a browser ships a new push service.
 */
const PUSH_HOSTS = ["fcm.googleapis.com", "updates.push.services.mozilla.com"];
const PUSH_HOST_PARENTS = ["push.apple.com", "notify.windows.com"];

/** True for a known push service host, matched on whole labels (no `evil-push.apple.com.example`). */
export function isPushServiceHost(host: string): boolean {
  return PUSH_HOSTS.includes(host) || PUSH_HOST_PARENTS.some((parent) => host === parent || host.endsWith(`.${parent}`));
}

/**
 * Push endpoints come from the browser, so they are untrusted URLs the Worker will POST to.
 * Only the real push services are accepted (Chrome/Edge on Android: FCM, Firefox: Mozilla,
 * Safari/iOS: Apple, Edge on Windows: WNS), over https on the default port, without credentials.
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
  if (url.port) return "Push endpoint must use the default https port.";
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!isPushServiceHost(host)) return `Push endpoint must be a known browser push service; "${host}" is not one.`;
  return null;
}
