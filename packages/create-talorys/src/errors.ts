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

const SECRETISH = /(token|secret|password|authorization|bearer|api[_-]?key)\s*[:=]\s*\S+/gi;

/** Removes ANSI codes and anything that looks like a credential from tool output. */
export function sanitize(output: string, maxLines = 12): string {
  return output
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escape sequences
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(SECRETISH, "$1: [redacted]")
    .split("\n")
    // cf frames its output with clack gutters and error boxes; keep only the text.
    .map((l) => l.replace(/^(?:\s*[│┌└├◆◇■▲])+\s?/u, "").trimEnd())
    .filter((l) => l.trim() && !/^\s*(?:▲|⛅|🪵)/u.test(l) && !l.includes("Proxy environment variables detected"))
    .slice(-maxLines)
    .join("\n");
}

/** Matches a Cloudflare API error code as cf prints it (`[10000]`), or as older tools did (`[code: 10000]`). */
function hasCode(text: string, code: number): boolean {
  return text.includes(`[${code}]`) || text.includes(`[code: ${code}]`);
}

/**
 * Translates common cf / Cloudflare API failures into owner-friendly errors.
 */
export function explainCfFailure(action: string, stderr: string): CliError {
  const text = stderr.toLowerCase();
  const details = sanitize(stderr);
  if (text.includes("not logged in") || hasCode(text, 10000) || text.includes("authentication error")) {
    return new CliError(
      `${action} failed: Cloudflare rejected the credentials.`,
      "Run the installer again to re-authenticate, or check that your account role can edit Workers.",
      details,
    );
  }
  if (text.includes("more than one account available")) {
    return new CliError(`${action} failed: several Cloudflare accounts are available.`, "Pass --account-id to choose one.", details);
  }
  if (text.includes("aborting the upload operation because of conflicts") || text.includes("last updated via the script api")) {
    return new CliError(
      `${action} failed: Cloudflare reports the Worker was changed outside the installer since the last update.`,
      "Nothing was deployed and no data changed. To review and confirm the change, run `npx cf deploy --prebuilt` in your Talorys directory, then re-run the installer. Please also report this on GitHub.",
      details,
    );
  }
  if (text.includes("durable object exports reconciliation failed")) {
    return new CliError(
      `${action} failed: Cloudflare refused the Durable Object configuration.`,
      "Nothing was deployed and your data was not changed. Please report this on GitHub with the details below.",
      details,
    );
  }
  if (hasCode(text, 10001) || text.includes("permission") || text.includes("forbidden") || text.includes("unauthorized")) {
    return new CliError(
      `${action} failed: your Cloudflare login lacks a required permission.`,
      "Talorys needs Workers Scripts:Edit, Workers AI:Read and Account Settings:Read. Ask an account admin, or choose another account.",
      details,
    );
  }
  if (text.includes("workers.dev subdomain")) {
    return new CliError(
      `${action} failed: this Cloudflare account has no workers.dev subdomain yet.`,
      "Choose one (free) in the Cloudflare dashboard under Workers & Pages, or at the onboarding link above, then re-run the installer; it resumes safely.",
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
  if (text.includes("rate limit") || hasCode(text, 971) || text.includes("too many requests")) {
    return new CliError(`${action} failed: Cloudflare rate-limited the request.`, "Wait a minute and re-run the installer; it resumes safely.", details);
  }
  return new CliError(`${action} failed.`, "Re-run the installer to resume. If it keeps failing, run `npx create-talorys@latest doctor`.", details);
}
