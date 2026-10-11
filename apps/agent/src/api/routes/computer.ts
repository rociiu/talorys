import { Hono } from "hono";
import type { AppEnv } from "../app";
import { AppError } from "../errors";

const COMPUTER_MANAGER_URL = "http://127.0.0.1:28789";

export const computerRoutes = new Hono<AppEnv>();

async function forwardToManager(path: string, method = "GET", body?: unknown) {
  try {
    const res = await fetch(`${COMPUTER_MANAGER_URL}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new AppError("INTERNAL_ERROR", (data as any)?.error || `Computer manager error (${res.status})`);
    }
    return data;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("INTERNAL_ERROR", `Failed to reach computer manager: ${err instanceof Error ? err.message : String(err)}`);
  }
}

computerRoutes.post("/computer/session/start", async (c) => {
  const data = await forwardToManager("/session/start", "POST");
  return c.json(data);
});

computerRoutes.post("/computer/session/stop", async (c) => {
  const data = await forwardToManager("/session/stop", "POST");
  return c.json(data);
});

computerRoutes.get("/computer/session/status", async (c) => {
  const data = await forwardToManager("/session/status", "GET");
  return c.json(data);
});

computerRoutes.post("/computer/session/take-control", async (c) => {
  const data = await forwardToManager("/session/take-control", "POST");
  return c.json(data);
});

computerRoutes.post("/computer/session/return-control", async (c) => {
  const data = await forwardToManager("/session/return-control", "POST");
  return c.json(data);
});
