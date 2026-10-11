// Starts an isolated local stack for Playwright: the Talorys Worker and Vite,
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
const procs = [
  spawn(process.execPath, [wrangler, "dev", "--local", "--port", "8787", "--persist-to", state], { cwd: join(root, "apps/agent"), env, stdio: "inherit" }),
  spawn(process.execPath, [join(root, "node_modules/vite/bin/vite.js"), "--port", "5173", "--strictPort"], { cwd: join(root, "apps/web"), env, stdio: "inherit" }),
];
const stop = () => {
  for (const p of procs) p.kill("SIGTERM");
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("exit", stop);
