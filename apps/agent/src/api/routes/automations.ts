import { automationCreateSchema, automationUpdateSchema } from "@talorys/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { Context } from "hono";
import type { AppEnv } from "../app";
import { AppError } from "../errors";
import { body, query } from "../middleware";

export const automationRoutes = new Hono<AppEnv>();

/** Access tokens may not add or change scheduled AI prompts; reminders and digests stay writable. */
function denyRemoteAgentPrompt(c: Context<AppEnv>, kind: string): void {
  if (c.get("remote") && kind === "agent_prompt") {
    throw new AppError("FORBIDDEN", "Access tokens cannot create or change AI prompt automations.");
  }
}

automationRoutes.get("/automations", (c) => {
  const s = c.env.agent.services;
  return c.json({
    automations: s.automations.list(),
    runs: s.automationsRepo.runs({ limit: 50 }),
    failed_runs: s.automationsRepo.runs({ limit: 20, status: "error" }),
    timezone: s.settings.get().timezone,
  });
});

automationRoutes.get("/automations/:id", (c) =>
  c.json({ automation: c.env.agent.services.automationsRepo.require(c.req.param("id")) }),
);

automationRoutes.get("/automations/:id/runs", (c) => {
  const s = c.env.agent.services;
  const id = c.req.param("id");
  s.automationsRepo.require(id);
  const q = query(c, z.object({
    status: z.enum(["success", "error", "skipped", "running"]).optional(),
    before: z.string().max(40).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }));
  const limit = q.limit ?? 25;
  const runs = s.automationsRepo.runs({ automationId: id, status: q.status, before: q.before, limit: limit + 1 });
  return c.json({ runs: runs.slice(0, limit), has_more: runs.length > limit });
});

automationRoutes.post("/automations/:id/run", async (c) => {
  const id = c.req.param("id");
  denyRemoteAgentPrompt(c, c.env.agent.services.automationsRepo.require(id).kind);
  return c.json({ run: await c.env.agent.runAutomationNow(id) });
});

automationRoutes.post("/automations", async (c) => {
  const input = await body(c, automationCreateSchema);
  denyRemoteAgentPrompt(c, input.kind);
  return c.json({ automation: await c.env.agent.services.automations.create(input) }, 201);
});

automationRoutes.patch("/automations/:id", async (c) => {
  const id = c.req.param("id");
  const patch = await body(c, automationUpdateSchema);
  if (c.get("remote")) denyRemoteAgentPrompt(c, c.env.agent.services.automationsRepo.require(id).kind);
  return c.json({ automation: await c.env.agent.services.automations.update(id, patch) });
});

automationRoutes.delete("/automations/:id", async (c) => {
  await c.env.agent.services.automations.delete(c.req.param("id"));
  return c.json({ deleted: true });
});

// ---------- Notification center ----------

automationRoutes.get("/notifications", (c) => {
  const { unread } = query(c, z.object({ unread: z.enum(["1", "0"]).optional() }));
  const s = c.env.agent.services;
  return c.json({ notifications: s.notifications.list({ unreadOnly: unread === "1" }), unread: s.notifications.unreadCount() });
});

automationRoutes.post("/notifications/read", async (c) => {
  const { id } = await body(c, z.object({ id: z.string().max(64).optional() }));
  c.env.agent.services.notifications.markRead(id);
  c.env.agent.refreshUnread();
  return c.json({ unread: c.env.agent.services.notifications.unreadCount() });
});

automationRoutes.delete("/notifications/:id", (c) => {
  c.env.agent.services.notifications.delete(c.req.param("id"));
  c.env.agent.refreshUnread();
  return c.json({ deleted: true });
});
