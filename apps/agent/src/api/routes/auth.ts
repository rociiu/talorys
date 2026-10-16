import { changePasswordSchema, loginSchema } from "@talorys/shared";
import { Hono } from "hono";
import type { AppEnv } from "../app";
import { body, clientId, readSessionToken, sessionCookie } from "../middleware";
import { AppError } from "../errors";

export const authRoutes = new Hono<AppEnv>();

authRoutes.post("/login", async (c) => {
  const { password } = await body(c, loginSchema, 4096);
  const auth = c.env.agent.services.auth;
  const { token, expiresAt } = await auth.login(password, clientId(c), c.req.header("user-agent") ?? "");
  c.env.agent.services.activity.record("auth.login", "Signed in");
  c.header("set-cookie", sessionCookie(c, token, expiresAt));
  return c.json({ authenticated: true, expires_at: expiresAt.toISOString() });
});

authRoutes.post("/logout", (c) => {
  const sessionId = c.get("sessionId");
  if (sessionId) c.env.agent.services.auth.revoke(sessionId);
  c.header("set-cookie", sessionCookie(c, "", null));
  return c.json({ authenticated: false });
});

authRoutes.get("/session", (c) => {
  const s = c.env.agent.services;
  const authenticated = !!c.get("sessionId");
  if (!authenticated && readSessionToken(c)) c.header("set-cookie", sessionCookie(c, "", null));
  const settings = s.settings.get();
  return c.json({
    authenticated,
    configured: s.auth.isConfigured(),
    agent_name: authenticated ? settings.agentName : undefined,
    theme: authenticated ? settings.theme : undefined,
    language: authenticated ? settings.language : undefined,
  });
});

authRoutes.get("/sessions", (c) => c.json({ sessions: c.env.agent.services.auth.listSessions(c.get("sessionId")) }));

authRoutes.delete("/sessions/:id", (c) => {
  const ok = c.env.agent.services.auth.revokeByPublicId(c.req.param("id"));
  if (!ok) throw new AppError("NOT_FOUND", "Session not found");
  return c.json({ revoked: true });
});

authRoutes.post("/sessions/revoke-others", (c) => {
  const count = c.env.agent.services.auth.revokeAllExcept(c.get("sessionId"));
  return c.json({ revoked: count });
});

authRoutes.post("/password", async (c) => {
  const input = await body(c, changePasswordSchema, 4096);
  const s = c.env.agent.services;
  await s.auth.changePassword(input.current_password, input.new_password, c.get("sessionId"), clientId(c));
  s.activity.record("auth.password_changed", "Password changed; other sessions signed out and access tokens revoked");
  return c.json({ changed: true });
});
