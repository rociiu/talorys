import { spawn } from "node:child_process";

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Written to stdin, then stdin is closed. Never logged. */
  input?: string;
  /**
   * Show output live (for flows such as browser login). stdin is ignored so
   * the CLI sees no TTY and never blocks on its own unrelated prompts.
   */
  interactive?: boolean;
  timeoutMs?: number;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Exec = (command: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;

/**
 * Runs a process with an argument array (never through a shell), so values
 * such as names or paths can't be interpreted as shell syntax.
 */
export const exec: Exec = (command, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env } as NodeJS.ProcessEnv,
      stdio: opts.interactive ? ["ignore", "inherit", "inherit"] : ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        child.kill("SIGTERM");
        stderr += `\nTimed out after ${Math.round(opts.timeoutMs! / 1000)}s (network timeout).`;
      }, opts.timeoutMs);
    }
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    if (!opts.interactive && child.stdin) {
      if (opts.input !== undefined) child.stdin.end(opts.input);
      else child.stdin.end();
    }
  });
