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
const agentPort = process.env.TALORYS_E2E_AGENT_PORT || "38787";
const pagesPort = process.env.TALORYS_E2E_PAGES_PORT || "38788";
const vitePort = process.env.TALORYS_E2E_VITE_PORT || "5173";
const env = { ...process.env, WRANGLER_SEND_METRICS: "false" };

const procs = [
  spawn(process.execPath, [wrangler, "dev", "--local", "--port", agentPort, "--persist-to", state], {
    cwd: join(root, "apps/agent"),
    env,
    stdio: "inherit",
  }),
  spawn(process.execPath, [join(root, "node_modules/vite/bin/vite.js"), "--port", vitePort, "--strictPort"], {
    cwd: join(root, "apps/web"),
    env: { ...env, TALORYS_API_PROXY: `http://127.0.0.1:${agentPort}` },
    stdio: "inherit",
  }),
];
const stop = () => {
  for (const p of procs) p.kill("SIGTERM");
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("exit", stop);
