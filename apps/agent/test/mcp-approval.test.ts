import { expect, it } from "vitest";
import { inAgent, loggedIn } from "./helpers";
import { addFake, executor, fakeMcpServer } from "./mcp-helpers";
import { ALL_TOOLS, runApprovedAction } from "../src/tools";
import { AgentRunner } from "../src/agent/runner";
import { MockAIProvider } from "../src/ai/mock";

it("proposes without calling, then approves exactly once and surfaces stored result", async () => {
  const id = await inAgent(async (a) => {
    const s = a.services;
    const fake = await addFake(s, { tools: [{ name: "append", result: "done" }] });
    const ex = executor(s);
    expect(await ex.execute("mcp_fake_append", { text: "x" }, "c")).toMatchObject({ status: "awaiting_owner_approval" });
    const action = ex.approvalFor("c")!;
    expect(action.preview).toBe('{\n  "text": "x"\n}');
    expect(fake.calls).toHaveLength(0);
    const ctx = { services: s, timezone: "UTC", mode: "chat" as const };
    const result = await runApprovedAction([...ALL_TOOLS, ...s.mcp.toolsForApproval()], ctx, action.id);
    expect(result.status).toBe("approved");
    expect(result.result).toContain("done");
    expect(s.pendingActions.get(action.id)!.result).toBe(result.result);
    expect(fake.calls).toHaveLength(1);
    await expect(runApprovedAction(s.mcp.toolsForApproval(), ctx, action.id)).rejects.toThrow("already handled");
    expect(fake.calls).toHaveLength(1);
    return action.id;
  });
  const c = await loggedIn();
  const res = await c.call(`/api/actions/${id}/approve`, { method: "POST", body: {} });
  expect(res.status).toBe(409);
});
it("refuses approval when URL changes between proposal and approval", async () =>
  inAgent(async (a) => {
    const s = a.services;
    const fake = await addFake(s, { tools: [{ name: "append" }] });
    const ex = executor(s);
    await ex.execute("mcp_fake_append", { text: "x" }, "c");
    // Simulate a configuration change retaining the cached tools, to exercise snapshot binding.
    s.mcp.repository.update(fake.server.id, { url: "https://other.example.com/mcp" });
    const action = await runApprovedAction(s.mcp.toolsForApproval(), { services: s, timezone: "UTC", mode: "chat" }, ex.approvalFor("c")!.id);
    expect(action.status).toBe("failed");
    expect(action.error).toContain("changed after it was proposed");
    expect(fake.calls).toHaveLength(0);
  }));
it("off tools are unavailable and scheduled runs cannot use MCP tools", async () =>
  inAgent(async (a) => {
    const s = a.services;
    const fake = await addFake(s);
    const scheduled = executor(s, "scheduled");
    expect(scheduled.available()).toEqual([]);
    await expect(scheduled.execute("mcp_fake_echo", { text: "hi" })).rejects.toThrow("not available");
    const runner = new AgentRunner(s, new MockAIProvider(0));
    const response = await runner.runScheduledPrompt('call fake tool echo with {"text":"hi"}');
    expect(response).toContain("Demo mode");
    expect(fake.calls).toHaveLength(0);
    s.mcp.repository.setToolPolicy(fake.server.id, "echo", "off");
    await expect(executor(s).execute("mcp_fake_echo", { text: "hi" })).rejects.toThrow("not available");
  }));
it("enforces shared per-turn cap across different MCP tools", async () =>
  inAgent(async (a) => {
    const s = a.services;
    const fake = await addFake(s, { tools: ["one", "two", "three", "four"].map((name) => ({ name, readOnly: true })) });
    const ex = executor(s);
    for (const name of ["one", "two", "three"]) await ex.execute(`mcp_fake_${name}`, { text: name });
    await expect(ex.execute("mcp_fake_four", { text: "four" })).rejects.toThrow("per-turn");
    expect(fake.calls).toHaveLength(3);
  }));
it("cancel aborts a hanging fake", async () =>
  inAgent(async (a) => {
    const s = a.services;
    const { server } = await addFake(s);
    s.mcp.fetcher = fakeMcpServer({ hang: true }).fetcher;
    const controller = new AbortController();
    const call = s.mcp.call(server.id, "echo", { text: "hi" }, controller.signal);
    controller.abort();
    await expect(call).rejects.toThrow("cancelled");
    expect(s.mcp.repository.view(server.id).calls_today).toBe(1);
  }));
it("approval route returns the result", async () => {
  const id = await inAgent(async (a) => {
    await addFake(a.services, { tools: [{ name: "append", result: "saved x" }] });
    const ex = executor(a.services);
    await ex.execute("mcp_fake_append", { text: "x" }, "c");
    return ex.approvalFor("c")!.id;
  });
  const c = await loggedIn();
  const res = await c.call(`/api/actions/${id}/approve`, { method: "POST", body: {} });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ action: { status: "approved", result: expect.stringContaining("saved x") } });
});

it("approval cannot switch to a different remote tool with the same sanitized name", async () =>
  inAgent(async (a) => {
    const s = a.services;
    const original = await addFake(s, { tools: [{ name: "append_log" }] });
    const ex = executor(s);
    await ex.execute("mcp_fake_append_log", { text: "x" }, "c");
    const replacement = fakeMcpServer({ tools: [{ name: "append.log" }] });
    s.mcp.fetcher = replacement.fetcher;
    await s.mcp.refresh(original.server.id);
    const result = await runApprovedAction(s.mcp.toolsForApproval(), { services: s, timezone: "UTC", mode: "chat" }, ex.approvalFor("c")!.id);
    expect(result.status).toBe("failed");
    expect(original.calls).toHaveLength(0);
    expect(replacement.calls).toHaveLength(0);
  }));
