import { pushSubscribeSchema, pushUnsubscribeSchema } from "@talorys/shared";
import { Hono } from "hono";
import type { AppEnv } from "../api/app";
import { AppError, NotFoundError, ValidationError } from "../api/errors";
import { body } from "../api/middleware";
import { endpointProblem } from "./endpoint";

/** Owner-only Web Push routes. Session and CSRF checks apply as for every other API route. */
export const pushRoutes = new Hono<AppEnv>();

pushRoutes.get("/push", (c) => c.json(c.env.agent.services.push.status()));

pushRoutes.post("/push/subscriptions", async (c) => {
  const s = c.env.agent.services;
  if (!s.push.configured()) throw new AppError("NOT_CONFIGURED", "Push notifications are not set up on this deployment yet.");
  const input = await body(c, pushSubscribeSchema, 8 * 1024);
  const problem = endpointProblem(input.endpoint);
  if (problem) throw new ValidationError(problem);
  const label = input.label || deviceLabel(c.req.header("user-agent") ?? "");
  const device = s.push.subscriptions.save({
    endpoint: input.endpoint,
    p256dh: input.keys.p256dh,
    auth: input.keys.auth,
    label,
    origin: new URL(c.req.url).origin,
  });
  s.activity.record("push.subscribed", `Notifications turned on for ${label}`);
  return c.json({ device, status: s.push.status() });
});

/** Called by a browser turning push off for itself, which only knows its own endpoint. */
pushRoutes.post("/push/unsubscribe", async (c) => {
  const s = c.env.agent.services;
  const input = await body(c, pushUnsubscribeSchema, 8 * 1024);
  s.push.subscriptions.removeByEndpoint(input.endpoint);
  return c.json(s.push.status());
});

pushRoutes.delete("/push/subscriptions/:id", (c) => {
  const s = c.env.agent.services;
  if (!s.push.subscriptions.remove(c.req.param("id"))) throw new NotFoundError("Device not found.");
  s.activity.record("push.removed", "Removed a device from notifications");
  return c.json(s.push.status());
});

pushRoutes.post("/push/test", async (c) => {
  const s = c.env.agent.services;
  if (!s.push.configured()) throw new AppError("NOT_CONFIGURED", "Push notifications are not set up on this deployment yet.");
  const result = await s.push.sendToAll({ title: s.settings.get().agentName, body: "Test notification: push works on this device.", url: "/" });
  return c.json({ result, status: s.push.status() });
});

/** A readable default name such as "Safari on iPhone", from the subscribing browser's user agent. */
export function deviceLabel(ua: string): string {
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android"
    : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari" : "";
  return [browser, os].filter(Boolean).join(" on ") || "Browser";
}
