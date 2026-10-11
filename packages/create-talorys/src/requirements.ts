import { exec as defaultExec, type Exec } from "./exec";
import { CliError } from "./errors";

export const MIN_NODE = [22, 0] as const;

export function checkNodeVersion(version = process.versions.node): void {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) {
    throw new CliError(`Node.js ${MIN_NODE.join(".")} or newer is required (found ${version}).`, "Install the current LTS from https://nodejs.org and try again.");
  }
}

export interface DetectedCli {
  name: string;
  version: string | null;
}

/** Reports globally installed Cloudflare CLIs (informational; the bundled cf is used for deployment). */
export async function detectGlobalClis(execFn: Exec = defaultExec): Promise<DetectedCli[]> {
  const found: DetectedCli[] = [];
  for (const name of ["wrangler", "cf"]) {
    try {
      const r = await execFn(name, ["--version"], { timeoutMs: 15_000 });
      if (r.code === 0) found.push({ name, version: r.stdout.trim().split("\n").pop()?.trim() ?? null });
    } catch {
      /* not installed */
    }
  }
  return found;
}

export function detectPackageManager(): string {
  const ua = process.env.npm_config_user_agent ?? "";
  return ua.split(" ")[0]?.split("/")[0] || "npm";
}
