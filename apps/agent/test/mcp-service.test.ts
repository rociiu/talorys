import { expect, it } from "vitest";
import { z } from "zod";
import { inAgent, loggedIn, readSse } from "./helpers";
import { addFake, fakeMcpServer } from "./mcp-helpers";
import { discoveredRows } from "../src/mcp/discovery";

it("discovers cached tools and defaults policies from annotations", async () =>
  inAgent(async (a) => {
    const { server } = await addFake(a.services, {
      tools: [
        { name: "read", readOnly: true, description: "x".repeat(1100) },
        { name: "write" },
        { name: "destroy", readOnly: true, destructive: true },
      ],
    });
    expect(server.status).toBe("ok");
    expect(server.tools.find((t) => t.name === "read")).toMatchObject({ policy: "auto", description: "x".repeat(1000) });
    expect(server.tools.filter((t) => t.name !== "read").map((t) => t.policy)).toEqual(["approve", "approve"]);
    expect(a.services.mcp.repository.listTools(server.id)).toHaveLength(3);
  }));
it("drops the 41st tool and rejects unsupported schemas", async () =>
  inAgent(async (a) => {
    const { server } = await addFake(a.services, { tools: Array.from({ length: 41 }, (_, i) => ({ name: `t${i}`, readOnly: true })) });
    expect(server.tools).toHaveLength(40);
    const rows = await discoveredRows(a.services.mcp.repository.get(server.id), [
      { name: "bad", inputSchema: { type: "object", properties: { x: { type: "string", description: "x".repeat(9000) } } } },
    ]);
    expect(rows[0]!.status).toBe("unsupported_schema");
  }));
it("refresh preserves policies, marks missing and resets changed schemas", async () =>
  inAgent(async (a) => {
    const s = a.services;
    const { server } = await addFake(s, { tools: [{ name: "echo", readOnly: true }, { name: "gone" }] });
    s.mcp.repository.setToolPolicy(server.id, "echo", "off");
    s.mcp.fetcher = fakeMcpServer().fetcher;
    const unchanged = await s.mcp.refresh(server.id);
    expect(unchanged.tools.find((t) => t.name === "echo")!.policy).toBe("off");
    expect(unchanged.tools.find((t) => t.name === "gone")!.status).toBe("missing");
    s.mcp.fetcher = fakeMcpServer({ tools: [{ name: "echo", readOnly: true, input: { text: z.number() } }] }).fetcher;
    const changed = await s.mcp.refresh(server.id);
    expect(changed.tools.find((t) => t.name === "echo")!.policy).toBe("approve");
  }));
it.each(["/api/mcp", "/api/export"])("sends auth but keeps its value absent from GET %s", async (route) => {
  const token = "mcp-only-secret-238904";
  await inAgent(async (a) => {
    const fake = await addFake(a.services, {
      requireHeader: ["X-API-Key", token],
      tools: [{ name: "echo", readOnly: true, result: token, description: token }],
    });
    expect(fake.server.status).toBe("ok");
    expect(fake.headers.some((h) => h.get("X-API-Key") === token)).toBe(true);
    const result = await a.services.mcp.call(fake.server.id, "echo", { text: "hi" });
    expect(result).not.toContain(token);
  });
  const c = await loggedIn();
  const res = await c.call(route);
  expect(res.status).toBe(200);
  expect(await res.text()).not.toContain(token);
  const activity = await c.call("/api/activity");
  expect(await activity.text()).not.toContain(token);
});
it("failed discovery creates an error row and chat still completes", async () => {
  await inAgent(async (a) => {
    const { server } = await addFake(a.services, { failWith: 500 });
    expect(server.status).toBe("error");
    expect(server.last_error).toBe("MCP connection failed.");
  });
  const c = await loggedIn();
  const events = await readSse(await c.call("/api/chat", { method: "POST", body: { message: "hello" } }));
  expect(events.at(-1)).toMatchObject({ type: "done", message: { status: "complete" } });
});
it("reserves daily calls before awaiting and refuses the 51st", async () =>
  inAgent(async (a) => {
    const { server } = await addFake(a.services);
    const repo = a.services.mcp.repository;
    for (let i = 0; i < 50; i++) expect(repo.reserveCall(server.id)).toBe(true);
    await expect(a.services.mcp.call(server.id, "echo", { text: "over" })).rejects.toThrow("daily call limit");
    expect(repo.view(server.id).calls_today).toBe(50);
  }));
it("refuses upstream redirects", async () =>
  inAgent(async (a) => {
    const { server } = await addFake(a.services, { failWith: 302 });
    expect(server.status).toBe("error");
  }));

it("redacts escaped reflected secrets before persistence and tool errors", async () =>
  inAgent(async (a) => {
    const token = 'Bearer "quoted\\secret"';
    const { server } = await addFake(a.services, {
      requireHeader: ["Authorization", token],
      tools: [{ name: "echo", readOnly: true, description: token, result: token, isError: true }],
    });
    expect(server.tools[0]!.description).toBe("[secret omitted]");
    await expect(a.services.mcp.call(server.id, "echo", { text: "hi" })).rejects.toThrow("[secret omitted]");
    expect(JSON.stringify(a.services.mcp.list())).not.toContain(JSON.stringify(token).slice(1, -1));
  }));
