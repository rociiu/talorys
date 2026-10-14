import { mcpConfigPatchSchema, mcpPolicySchema, mcpServerCreateSchema, mcpServerPatchSchema, MCP_LIMITS } from "@talorys/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../api/app";
import { body } from "../api/middleware";

export const mcpRoutes = new Hono<AppEnv>();
mcpRoutes.get("/mcp", (c) => {
  const mcp = c.env.agent.services.mcp;
  return c.json({ servers: mcp.list(), config: mcp.config(), limits: MCP_LIMITS });
});
mcpRoutes.post("/mcp/servers", async (c) => {
  const input = await body(c, mcpServerCreateSchema, 16 * 1024);
  return c.json({ server: await c.env.agent.services.mcp.add(input) }, 201);
});
mcpRoutes.patch("/mcp/servers/:id", async (c) => {
  const input = await body(c, mcpServerPatchSchema, 16 * 1024);
  return c.json({ server: await c.env.agent.services.mcp.update(c.req.param("id"), input) });
});
mcpRoutes.delete("/mcp/servers/:id", (c) => {
  c.env.agent.services.mcp.remove(c.req.param("id"));
  return c.json({ deleted: true });
});
mcpRoutes.post("/mcp/servers/:id/test", async (c) => c.json(await c.env.agent.services.mcp.test(c.req.param("id"))));
mcpRoutes.post("/mcp/servers/:id/refresh", async (c) => c.json({ server: await c.env.agent.services.mcp.refresh(c.req.param("id")) }));
mcpRoutes.patch("/mcp/servers/:id/tools/:name", async (c) => {
  const { policy } = await body(c, z.object({ policy: mcpPolicySchema }), 16 * 1024);
  const mcp = c.env.agent.services.mcp;
  mcp.repository.setToolPolicy(c.req.param("id"), c.req.param("name"), policy);
  return c.json({ server: mcp.repository.view(c.req.param("id")) });
});
mcpRoutes.put("/mcp/config", async (c) => {
  const input = await body(c, mcpConfigPatchSchema, 16 * 1024);
  return c.json({ config: c.env.agent.services.mcp.setConfig(input) });
});
