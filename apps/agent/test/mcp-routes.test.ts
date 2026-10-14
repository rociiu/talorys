import { expect, it } from "vitest";
import { client, inAgent, loggedIn } from "./helpers";
import { fakeMcpServer } from "./mcp-helpers";
import type { McpServerView } from "@talorys/shared";

it("requires an owner session and CSRF", async () => {
  expect((await client().call("/api/mcp")).status).toBe(401);
  const c = await loggedIn();
  const res = await c.call("/api/mcp/servers", {
    method: "POST",
    body: { name: "fake", url: "https://mcp.example.com" },
    headers: { "x-talorys-request": "" },
  });
  expect(res.status).toBe(403);
});
it("validates URL, header and config ceilings", async () => {
  const c = await loggedIn();
  for (const body of [
    { name: "f", url: "https://10.0.0.1" },
    { name: "f", url: "https://mcp.example.com", auth: { header: "Invalid Header", value: "secret" } },
  ]) {
    expect((await c.call("/api/mcp/servers", { method: "POST", body })).status).toBe(400);
  }
  expect((await c.call("/api/mcp/config", { method: "PUT", body: { maxCallsPerTurn: 11 } })).status).toBe(400);
  expect((await c.call("/api/mcp/config", { method: "PUT", body: { maxResultChars: 20001 } })).status).toBe(400);
  const res = await c.call("/api/mcp/config", { method: "PUT", body: { maxCallsPerTurn: 10, maxResultChars: 20000 } });
  expect(await res.json()).toEqual({ config: { maxCallsPerTurn: 10, maxResultChars: 20000 } });
});
it("adds, clears auth, changes policy and deletes tools", async () => {
  await inAgent((a) => {
    a.services.mcp.fetcher = fakeMcpServer().fetcher;
  });
  const c = await loggedIn();
  const added = await c.call("/api/mcp/servers", {
    method: "POST",
    body: { name: "fake", url: "https://mcp.example.com", auth: { value: "route-secret" } },
  });
  expect(added.status).toBe(201);
  const { server } = (await added.json()) as { server: McpServerView };
  expect(server.auth).toEqual({ header: "Authorization" });
  const policy = await c.call(`/api/mcp/servers/${server.id}/tools/echo`, { method: "PATCH", body: { policy: "off" } });
  expect(await policy.json()).toMatchObject({ server: { tools: [{ name: "echo", policy: "off" }] } });
  const cleared = await c.call(`/api/mcp/servers/${server.id}`, { method: "PATCH", body: { auth: null } });
  expect(await cleared.json()).toMatchObject({ server: { auth: null } });
  await inAgent((a) => {
    expect(a.services.mcp.repository.get(server.id).auth_header_value).toBeNull();
  });
  const removed = await c.call(`/api/mcp/servers/${server.id}`, { method: "DELETE" });
  expect(await removed.json()).toEqual({ deleted: true });
  await inAgent((a) => {
    expect(a.services.mcp.repository.listTools(server.id)).toEqual([]);
  });
});
it("refuses an 11th server", async () => {
  await inAgent((a) => {
    a.services.mcp.fetcher = fakeMcpServer({ failWith: 500 }).fetcher;
  });
  const c = await loggedIn();
  for (let i = 0; i < 10; i++)
    expect((await c.call("/api/mcp/servers", { method: "POST", body: { name: `s${i}`, url: "https://mcp.example.com" } })).status).toBe(201);
  expect((await c.call("/api/mcp/servers", { method: "POST", body: { name: "extra", url: "https://mcp.example.com" } })).status).toBe(400);
  const res = await c.json<{ servers: McpServerView[] }>("/api/mcp");
  expect(res.servers).toHaveLength(10);
});
