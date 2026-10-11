import { getAgentByName } from "agents";
import { AGENT_INSTANCE_NAME } from "@talorys/shared";
import type { Env } from "./env";

export { TalorysAgent } from "./agent/talorys-agent";

/**
 * Worker entry point. The same Worker serves the web app as static assets; with
 * `run_worker_first: ["/api/*"]` only API requests reach this code, so anything
 * else arriving here is refused.
 *
 * Every /api request is forwarded to the single owner agent ("personal-agent").
 * The instance name is fixed server-side; clients cannot choose agent identities.
 * Authentication and authorization happen inside the agent (see api/middleware.ts).
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // A "sub" path segment is the Agents SDK's sub-agent routing marker; Talorys has no sub-agents.
    const isSubAgentPath = url.pathname.split("/").includes("sub");
    if ((!url.pathname.startsWith("/api/") && url.pathname !== "/api") || isSubAgentPath) {
      return Response.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
    }
    // WebSocket upgrades are not part of the API surface.
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return Response.json({ error: { code: "FORBIDDEN", message: "WebSockets are not supported" } }, { status: 400 });
    }
    const agent = await getAgentByName(env.TalorysAgent, AGENT_INSTANCE_NAME);
    return agent.fetch(request);
  },
} satisfies ExportedHandler<Env>;
