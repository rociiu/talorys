// Captures README screenshots from a fresh local stack (mock AI, sample data).
// Usage: node scripts/screenshots.mjs   (writes docs/screenshots/*.png)
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "docs/screenshots");
const BASE = "http://localhost:5173";
const PASSWORD = process.env.TALORYS_DEV_PASSWORD || "talorys-dev-password";
mkdirSync(out, { recursive: true });

const server = spawn("sh", ["-c", "node scripts/dev-setup.mjs && node scripts/ensure-dist.mjs && node scripts/e2e-server.mjs"], {
  cwd: root,
  stdio: "ignore",
  detached: true,
});
const stop = () => {
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {}
};
process.on("exit", stop);

async function waitForServer() {
  for (let i = 0; i < 240; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Local stack did not start");
}

async function seed(request) {
  const post = async (path, data) => {
    const res = await request.post(`/api${path}`, { data, headers: { "x-talorys-request": "1", origin: BASE } });
    if (!res.ok()) throw new Error(`${path}: ${res.status()} ${await res.text()}`);
    return res.json();
  };
  const day = (n, h = 9) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + n);
    d.setUTCHours(h, 0, 0, 0);
    return d.toISOString();
  };
  await post("/projects", { name: "Home renovation", description: "Kitchen and garden updates" });
  for (const t of [
    { title: "Call the plumber about the kitchen sink", priority: "high", due_at: day(0, 22) },
    { title: "Review quarterly budget", priority: "medium", due_at: day(0, 23) },
    { title: "Book dentist appointment", priority: "low", due_at: day(1) },
    { title: "Order seeds for the spring garden", priority: "medium", due_at: day(3) },
    { title: "Renew passport", priority: "high", due_at: day(10) },
  ])
    await post("/tasks", t);
  for (const m of [
    { content: "Prefers concise answers with bullet points", category: "preference" },
    { content: "Works as a product designer in Berlin", category: "fact" },
    { content: "Training for a half marathon in May", category: "goal" },
    { content: "Allergic to peanuts", category: "fact" },
    { content: "Morning person: plans the day before 8am", category: "habit" },
  ])
    await post("/memories", m);
  await post("/notes", {
    title: "Garden plan",
    content:
      "## Spring planting\n\n- Tomatoes along the south fence\n- Herbs by the kitchen door: basil, thyme, mint\n- Replace the old lavender\n\n> Start seeds indoors in early March.",
  });
  await post("/notes", { title: "Book ideas", content: "- The Design of Everyday Things\n- Four Thousand Weeks" });
  await post("/automations", { name: "Morning task digest", kind: "task_digest", schedule: { type: "daily", time: "07:30" } });
  await post("/automations", { name: "Stretch break", kind: "reminder", message: "Stand up and stretch.", schedule: { type: "weekly", days: [1, 2, 3, 4, 5], time: "15:00" } });
  await post("/automations", { name: "Water the plants", kind: "reminder", message: "Water the balcony plants.", schedule: { type: "weekly", days: [0, 3], time: "19:00" } });
}

try {
  await waitForServer();
  const browser = await chromium.launch();
  const shoot = async (theme, viewport, name, fn) => {
    const ctx = await browser.newContext({ baseURL: BASE, viewport, colorScheme: theme, deviceScaleFactor: 2, timezoneId: "UTC" });
    const page = await ctx.newPage();
    await fn(page);
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(out, `${name}.png`) });
    await ctx.close();
  };
  const login = async (page) => {
    await page.goto("/");
    await page.getByPlaceholder("Owner password").fill(PASSWORD);
    await page.getByRole("button", { name: "Unlock" }).click();
    await page.getByRole("link", { name: "Ask Talorys", exact: true }).waitFor();
    const dismiss = page.getByRole("region", { name: "Welcome to your personal assistant" }).getByRole("button", { name: "Dismiss", exact: true });
    if (await dismiss.isVisible()) await dismiss.click();
  };

  const desktop = { width: 1280, height: 800 };
  await shoot("light", desktop, "login", (p) => p.goto("/").then(() => p.getByPlaceholder("Owner password").waitFor()));

  const ctx = await browser.newContext({ baseURL: BASE });
  const p0 = await ctx.newPage();
  await login(p0);
  await seed(ctx.request);
  await ctx.close();

  await shoot("light", desktop, "today", async (p) => {
    await login(p);
    await p.getByText("Call the plumber about the kitchen sink").first().waitFor();
  });
  await shoot("light", desktop, "chat", async (p) => {
    await login(p);
    await p.goto("/chat");
    await p.getByRole("textbox", { name: "Message", exact: true }).fill("add task prepare slides for Monday");
    await p.keyboard.press("Enter");
    await p.getByText('Added the task "prepare slides for Monday".').waitFor();
  });
  await shoot("light", desktop, "tasks", async (p) => {
    await login(p);
    await p.goto("/tasks");
    await p.getByText("Call the plumber about the kitchen sink").first().waitFor();
  });
  await shoot("dark", desktop, "memory", async (p) => {
    await login(p);
    await p.goto("/memory");
    await p.getByText("Allergic to peanuts").waitFor();
  });
  await shoot("light", desktop, "automations", async (p) => {
    await login(p);
    await p.goto("/automations");
    await p.getByText("Morning task digest").first().waitFor();
  });
  await shoot("dark", { width: 390, height: 844 }, "mobile", async (p) => {
    await login(p);
    await p.getByText("Call the plumber about the kitchen sink").first().waitFor();
  });
  await browser.close();
  console.log(`Screenshots written to ${out}`);
} finally {
  stop();
}
