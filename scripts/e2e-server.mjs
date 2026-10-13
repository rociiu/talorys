// Starts an isolated local stack for Playwright: agent Worker, Pages Function proxy and Vite,
// with fresh persisted state in .wrangler/e2e-state so tests never touch development data.
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const state = join(root, ".wrangler/e2e-state");
rmSync(state, { recursive: true, force: true });
const wrangler = join(root, "node_modules/wrangler/bin/wrangler.js");
const env = { ...process.env, WRANGLER_SEND_METRICS: "false" };
const procs = [];
const start = (args, cwd) => procs.push(spawn(process.execPath, args, { cwd: join(root, cwd), env, stdio: "inherit" }));
const stop = () => {
  for (const p of procs) p.kill("SIGTERM");
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("exit", stop);

/** Resolves once something answers on the port (any HTTP status), or rejects after `ms`. */
async function listening(port, ms = 60_000) {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await new Promise((r) => setTimeout(r, 250))) {
    try {
      await fetch(`http://127.0.0.1:${port}/`);
      return;
    } catch {}
  }
  throw new Error(`Nothing listening on port ${port} after ${ms} ms`);
}

// The two wrangler processes are started one after the other: started together, both runtimes
// can pick the same free internal port and one fails with "bind(): Address already in use".
start([wrangler, "dev", "--local", "--port", "8787", "--persist-to", state], "apps/agent");
await listening(8787);
start([wrangler, "pages", "dev", "dist", "--port", "8788", "--persist-to", `${state}-pages`], "apps/web");
start([join(root, "node_modules/vite/bin/vite.js"), "--port", "5173", "--strictPort"], "apps/web");
