// The Worker serves apps/web/dist as static assets, so `wrangler dev` (and the agent tests)
// need the directory to exist. In development Vite serves the UI on :5173 instead.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
const dir = new URL("../apps/web/dist/", import.meta.url);
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL("index.html", dir), "<!doctype html><p>Run the Vite dev server on :5173.</p>");
}
