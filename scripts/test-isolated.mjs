import { spawn } from "node:child_process";
import { join } from "node:path";

const root = "/home/wasuphj/talorys";
const wrangler = join(root, "node_modules/wrangler/bin/wrangler.js");
const env = { ...process.env, WRANGLER_SEND_METRICS: "false" };

console.log("Starting agent on 28787...");
const agent = spawn(process.execPath, [
  wrangler, "dev", "--local", "--port", "28787",
  "--persist-to", join(root, ".wrangler/state")
], {
  cwd: join(root, "apps/agent"),
  env,
  stdio: ["ignore", "pipe", "pipe"]
});
agent.stdout.on("data", d => console.log("[agent]", d.toString().trim()));
agent.stderr.on("data", d => console.error("[agent-err]", d.toString().trim()));

setTimeout(async () => {
  console.log("Starting pages on 28788...");
  const pages = spawn(process.execPath, [
    wrangler, "pages", "dev", "dist", "--port", "28788",
    "--persist-to", join(root, ".wrangler/pages-state")
  ], {
    cwd: join(root, "apps/web"),
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  pages.stdout.on("data", d => console.log("[pages]", d.toString().trim()));
  pages.stderr.on("data", d => console.error("[pages-err]", d.toString().trim()));

  setTimeout(async () => {
    try {
      const res = await fetch("http://127.0.0.1:28788/api/health");
      const text = await res.text();
      console.log("[VERIFY] Health status:", res.status, "body:", text);
    } catch (e) {
      console.error(e);
    } finally {
      agent.kill();
      pages.kill();
      process.exit(0);
    }
  }, 7000);
}, 3000);
