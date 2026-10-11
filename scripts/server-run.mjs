#!/usr/bin/env node
import { spawn, execSync } from "node:child_process";
import { join } from "node:path";

const root = "/home/wasuphj/talorys";
const wrangler = join(root, "node_modules/wrangler/bin/wrangler.js");
const env = { ...process.env, WRANGLER_SEND_METRICS: "false" };

let agentProc = null;
let pagesProc = null;
let relayProc = null;
let computerProc = null;
let exiting = false;

function cleanup() {
  if (exiting) return;
  exiting = true;
  console.log("[talorys-server] Shutting down all services...");

  if (computerProc && !computerProc.killed) {
    try { computerProc.kill("SIGTERM"); } catch (_) {}
  }
  if (relayProc && !relayProc.killed) {
    try { relayProc.kill("SIGTERM"); } catch (_) {}
  }
  if (agentProc && !agentProc.killed) {
    try { process.kill(-agentProc.pid, "SIGTERM"); } catch (_) {
      try { agentProc.kill("SIGTERM"); } catch (_) {}
    }
  }
  if (pagesProc && !pagesProc.killed) {
    try { process.kill(-pagesProc.pid, "SIGTERM"); } catch (_) {
      try { pagesProc.kill("SIGTERM"); } catch (_) {}
    }
  }

  try {
    execSync("fuser -k 28787/tcp 28788/tcp 28789/tcp 8790/tcp 2>/dev/null || true");
    execSync("docker rm -f talorys-computer-sandbox 2>/dev/null || true");
  } catch (_) {}
}

process.on("SIGHUP", () => {
  console.log("[talorys-server] SIGHUP received, ignoring...");
});
process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("SIGTERM", () => { cleanup(); process.exit(0); });
process.on("exit", cleanup);

// Step 0: Ensure ports are completely clean before startup
try {
  execSync("fuser -k 28787/tcp 28788/tcp 28789/tcp 8790/tcp 2>/dev/null || true");
} catch (_) {}

// Step 1: Start Bridge Relay
console.log("[talorys-server] Starting Bridge Relay on 172.17.0.1:8790 -> 127.0.0.1:28788 & 28789...");
relayProc = spawn("python3", ["/home/wasuphj/.local/bin/talorys-relay"], {
  stdio: ["ignore", "pipe", "pipe"]
});
relayProc.stdout.on("data", (d) => process.stdout.write(`[relay] ${d}`));
relayProc.stderr.on("data", (d) => process.stderr.write(`[relay-err] ${d}`));
relayProc.on("exit", (code, signal) => {
  console.error(`[talorys-server] Relay process exited with code=${code}, signal=${signal}`);
  if (!exiting) { cleanup(); process.exit(1); }
});

// Step 1.5: Start Computer Manager on port 28789
console.log("[talorys-server] Starting Computer Manager on port 28789...");
computerProc = spawn(process.execPath, [join(root, "services/computer-manager/dist/server.mjs")], {
  cwd: root,
  env,
  stdio: ["ignore", "pipe", "pipe"]
});
computerProc.stdout.on("data", (d) => process.stdout.write(`[computer] ${d}`));
computerProc.stderr.on("data", (d) => process.stderr.write(`[computer-err] ${d}`));
computerProc.on("exit", (code, signal) => {
  console.error(`[talorys-server] Computer Manager exited with code=${code}, signal=${signal}`);
});

// Step 2: Start Agent Worker
console.log("[talorys-server] Starting Talorys Agent Worker on port 28787...");
agentProc = spawn(process.execPath, [
  wrangler, "dev", "--local", "--port", "28787",
  "--persist-to", join(root, ".wrangler/state")
], {
  cwd: join(root, "apps/agent"),
  env,

  stdio: ["ignore", "pipe", "pipe"]
});
agentProc.stdout.on("data", (d) => process.stdout.write(`[agent] ${d}`));
agentProc.stderr.on("data", (d) => process.stderr.write(`[agent-err] ${d}`));
agentProc.on("exit", (code, signal) => {
  console.error(`[talorys-server] Agent process exited with code=${code}, signal=${signal}`);
  if (!exiting) { cleanup(); process.exit(1); }
});

// Step 3: Start Pages Frontend/API
setTimeout(() => {
  if (exiting) return;
  console.log("[talorys-server] Starting Talorys Pages Frontend on port 28788...");
  pagesProc = spawn(process.execPath, [
    wrangler, "pages", "dev", "dist", "--port", "28788",
    "--persist-to", join(root, ".wrangler/pages-state")
  ], {
    cwd: join(root, "apps/web"),
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  pagesProc.stdout.on("data", (d) => process.stdout.write(`[pages] ${d}`));
  pagesProc.stderr.on("data", (d) => process.stderr.write(`[pages-err] ${d}`));
  pagesProc.on("exit", (code, signal) => {
    console.error(`[talorys-server] Pages process exited with code=${code}, signal=${signal}`);
    if (!exiting) { cleanup(); process.exit(1); }
  });
}, 2500);
