import type { RemoteScope } from "@talorys/shared";
import { Hono } from "hono";
import type { TalorysAgent } from "../agent/talorys-agent";
import type { Env } from "../env";
import { errorResponse, NotFoundError } from "./errors";
import { csrfProtection, requireSession, securityHeaders } from "./middleware";
import { authRoutes } from "./routes/auth";
import { chatRoutes } from "./routes/chat";
import { dataRoutes } from "./routes/data";
import { automationRoutes } from "./routes/automations";
import { systemRoutes } from "./routes/system";
import { semanticRoutes } from "../semantic/routes";
import { pushRoutes } from "../push/routes";
import { remoteAuth } from "../remote/middleware";
import { remoteRoutes } from "../remote/routes";

export interface AppEnv {
  Bindings: { agent: TalorysAgent; env: Env };
  Variables: {
    sessionId: string | null;
    /** The validated access token behind a Bearer request; null for cookie and anonymous requests. */
    remote: { id: string; name: string; scope: RemoteScope } | null;
  };
}

/**
 * The private HTTP API. It runs inside the owner's Durable Object, next to the
 * SQLite database it serves, so no data ever leaves the private backend.
 */
export function createApi() {
  const app = new Hono<AppEnv>().basePath("/api");

  app.onError((err) => errorResponse(err));
  app.notFound(() => errorResponse(new NotFoundError("Unknown API route")));

  app.use("*", securityHeaders);
  // Before CSRF and session: a validated token skips both, a bad one fails closed.
  app.use("*", remoteAuth);
  app.use("*", csrfProtection);
  app.use("*", requireSession);

  // First, so its middleware wraps the upstream /memories and /import handlers.
  app.route("/", semanticRoutes);
  app.route("/", systemRoutes);
  app.route("/auth", authRoutes);
  app.route("/", chatRoutes);
  app.route("/", dataRoutes);
  app.route("/", automationRoutes);
  app.route("/", pushRoutes);
  app.route("/", remoteRoutes);

  return app;
}
