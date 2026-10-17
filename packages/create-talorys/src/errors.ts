/** An error with an actionable recovery hint, shown to the owner without a stack trace. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
    readonly details?: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export class CancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "CancelledError";
  }
}

// Quoted values may contain spaces and escaped delimiters.
const SECRETISH = /(token|secret|password|authorization|bearer|api[_-]?key|auth[_-]?key)(["']?)\s*[:=]\s*(?:(?:bearer|basic|token|digest)\s+)?(?:"(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'|\S+)/gi;

/** Removes ANSI codes and anything that looks like a credential from tool output. */
export function sanitize(output: string, maxLines = 12): string {
  return output
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escape sequences
    .replace(/\u001b\[[0-9;]*m/g, "")
    // Authorization headers, especially Digest, can contain several parameters.
    .replace(/(\bauthorization\s*:)[^\r\n]*/gi, "$1 [redacted]")
    .replace(SECRETISH, "$1$2: [redacted]")
    // Only token-like values (a digit or ./~+-= punctuation, or 20+ characters), so "Bearer authentication failed" stays readable.
    .replace(/\bbearer\s+([\w.~+/-]{8,}=*)/gi, (m, v: string) => (/[\d.~+/=-]/.test(v) || v.length >= 20 ? "Bearer [redacted]" : m))
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() && !/^\s*(?:▲|⛅|🪵)/u.test(l) && !l.includes("Proxy environment variables detected"))
    .slice(-maxLines)
    .join("\n");
}

/**
 * Translates common Wrangler / Cloudflare API failures into owner-friendly errors.
 */
export function explainWranglerFailure(action: string, stderr: string): CliError {
  const text = stderr.toLowerCase();
  const details = sanitize(stderr);
  if (text.includes("not logged in") || text.includes("[code: 10000]") || text.includes("authentication error")) {
    return new CliError(
      `${action} failed: Cloudflare rejected the credentials.`,
      "Run the installer again to re-authenticate, or check that your account role can edit Workers and Pages.",
      details,
    );
  }
  if (text.includes("[code: 10001]") || text.includes("permission") || text.includes("forbidden") || text.includes("unauthorized")) {
    return new CliError(
      `${action} failed: your Cloudflare login lacks a required permission.`,
      "Talorys needs Workers Scripts:Edit, Pages:Edit, Workers AI:Read and Account Settings:Read. Ask an account admin, or choose another account.",
      details,
    );
  }
  if (text.includes("durable object") && (text.includes("plan") || text.includes("not allowed") || text.includes("not enabled"))) {
    return new CliError(
      `${action} failed: SQLite-backed Durable Objects are not available on this account.`,
      "SQLite Durable Objects are included in the Workers Free plan. Check the account's Workers settings in the Cloudflare dashboard.",
      details,
    );
  }
  if (/etimedout|econnreset|enotfound|eai_again|network|fetch failed|socket hang up/.test(text)) {
    return new CliError(`${action} failed: network error talking to Cloudflare.`, "Check your connection and re-run the installer; it resumes safely.", details);
  }
  if (text.includes("rate limit") || text.includes("[code: 971]") || text.includes("too many requests")) {
    return new CliError(`${action} failed: Cloudflare rate-limited the request.`, "Wait a minute and re-run the installer; it resumes safely.", details);
  }
  return new CliError(`${action} failed.`, "Re-run the installer to resume. If it keeps failing, run `npx create-talorys@latest doctor`.", details);
}
