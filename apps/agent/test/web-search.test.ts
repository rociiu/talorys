import { beforeEach, describe, expect, it } from "vitest";
import { inAgent, loggedIn, readSse, type Client } from "./helpers";
import { ToolExecutor } from "../src/tools";
import { webSearchTools } from "../src/tools/web";
import { parseResults, WebSearchService } from "../src/services/web-search";
import { SettingsService } from "../src/services/settings";
import { exportData, importData } from "../src/services/backup";
import { isRemoteAllowed } from "../src/remote/allowlist";

interface FakeSearch {
  requests: { url: string; headers: Record<string, string>; body: any }[];
  respond: (url: string) => Response;
}

const TAVILY_BODY = {
  results: [
    { title: "Node.js 24 is out", url: "https://nodejs.org/en/blog/release/v24.0.0", content: "Node.js 24   ships V8 13.6\nand npm 11.", published_date: "2026-05-06T00:00:00Z" },
    { title: "Bad link", url: "javascript:alert(1)", content: "dropped" },
  ],
};

function fakeSearch(respond: FakeSearch["respond"] = () => Response.json(TAVILY_BODY)): FakeSearch {
  return { requests: [], respond };
}

async function useFake(f: FakeSearch): Promise<void> {
  await inAgent((a) => {
    a.services.webSearch.fetch = async (input, init) => {
      const url = String(input);
      f.requests.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()), body: JSON.parse(String(init?.body)) });
      return f.respond(url);
    };
  });
}

async function chat(c: Client, message: string) {
  return readSse(await c.call("/api/chat", { method: "POST", body: { message } }));
}
const done = (events: any[]) => events.find((e) => e.type === "done").message;
const setWebSearch = (c: Client, webSearch: Record<string, string>) => c.call("/api/settings", { method: "PATCH", body: { webSearch } });

// Settings are shared by the tests in this file; each starts with web search off.
beforeEach(async () => {
  await inAgent((a) => {
    a.services.settings.update({ webSearch: { provider: "off", policy: "approve" } });
  });
});

describe("web search: off by default", () => {
  it("offers no tool, sends nothing and keeps the no-browsing rule", async () => {
    const f = fakeSearch();
    await useFake(f);
    const c = await loggedIn();
    const { settings } = await c.json("/api/settings");
    expect(settings.webSearch).toEqual({ provider: "off", policy: "approve" });
    const message = done(await chat(c, "web search node 24 release"));
    expect(message.tools).toEqual([]);
    expect(f.requests).toEqual([]);
    await inAgent(async (a) => {
      expect(webSearchTools(a.services.webSearch)).toEqual([]);
      const { buildSystemPrompt } = await import("../src/agent/prompt");
      const base = { agentName: "T", timezone: "UTC", now: new Date(), autoMemory: false, memories: [] };
      expect(buildSystemPrompt(base)).toContain("You cannot browse the web");
      expect(buildSystemPrompt({ ...base, webSearch: "auto" })).not.toContain("You cannot browse the web");
      expect(buildSystemPrompt({ ...base, webSearch: "auto" })).toContain("never put the owner's name");
      expect(buildSystemPrompt({ ...base, webSearch: "approve" })).toContain("results reach you in a later turn");
    });
  });

  it("reports which providers have a key without revealing the key", async () => {
    const c = await loggedIn();
    const res = await c.call("/api/web-search");
    const text = await res.text();
    expect(text).not.toContain("tvly-test-key");
    expect(JSON.parse(text).providers).toEqual([
      { id: "tavily", name: "Tavily", configured: true, secret: "TAVILY_API_KEY" },
      { id: "exa", name: "Exa", configured: false, secret: "EXA_API_KEY" },
    ]);
  });

  it("refuses a provider without a key", async () => {
    const c = await loggedIn();
    const res = await setWebSearch(c, { provider: "exa" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.message).toContain("EXA_API_KEY");
    expect((await c.json("/api/settings")).settings.webSearch.provider).toBe("off");
  });
});

describe("web search: searching without asking", () => {
  it("sends only the query to the fixed endpoint and returns cleaned results as third-party data", async () => {
    const f = fakeSearch();
    await useFake(f);
    const c = await loggedIn();
    expect((await setWebSearch(c, { provider: "tavily", policy: "auto" })).status).toBe(200);
    const message = done(await chat(c, "web search node 24 release"));
    expect(message.tools[0]).toMatchObject({ name: "web_search", status: "success", label: "Searching the web for “node 24 release”" });
    expect(message.content).toContain("https://nodejs.org/en/blog/release/v24.0.0");
    expect(message.content).toContain("Node.js 24 ships V8 13.6 and npm 11.");
    expect(message.content).toContain("Third-party web content");
    expect(message.content).not.toContain("javascript:");
    expect(f.requests).toHaveLength(1);
    const [req] = f.requests;
    expect(req!.url).toBe("https://api.tavily.com/search");
    expect(req!.headers.authorization).toBe("Bearer tvly-test-key");
    expect(req!.body).toEqual({ query: "node 24 release", search_depth: "basic", max_results: 5, include_answer: false, include_raw_content: false, include_images: false });
    // Logged with the provider and outcome, never the query.
    const activity = await inAgent((a) => a.services.activity.list(20));
    const call = activity.find((e: any) => e.type === "web_search.call");
    expect(call?.summary).toMatch(/^Tavily → 1 result\(s\)/);
    expect(JSON.stringify(activity)).not.toContain("node 24 release");
  });

  it("turns provider failures into a short error the model can relay", async () => {
    const f = fakeSearch(() => new Response("nope", { status: 401 }));
    await useFake(f);
    const c = await loggedIn();
    await setWebSearch(c, { provider: "tavily", policy: "auto" });
    const message = done(await chat(c, "web search anything"));
    expect(message.tools[0]).toMatchObject({ name: "web_search", status: "error" });
    expect(message.tools[0].error).toContain("Tavily rejected the API key.");
  });

  it("is never offered to scheduled runs", async () => {
    const f = fakeSearch();
    await useFake(f);
    const c = await loggedIn();
    await setWebSearch(c, { provider: "tavily", policy: "auto" });
    await inAgent(async (a) => {
      const tools = webSearchTools(a.services.webSearch);
      expect(tools).toHaveLength(1);
      const scheduled = new ToolExecutor(tools, { services: a.services, timezone: "UTC", mode: "scheduled" }, { maxToolCalls: 4 });
      expect(scheduled.available()).toEqual([]);
      await a.runner().runScheduledPrompt("web search node 24");
    });
    expect(f.requests).toEqual([]);
  });
});

describe("web search: asking first", () => {
  it("proposes the query, searches only after approval, and keeps the result for the model", async () => {
    const f = fakeSearch();
    await useFake(f);
    const c = await loggedIn();
    await setWebSearch(c, { provider: "tavily" });
    const message = done(await chat(c, "web search node 24 release"));
    const approval = message.tools[0].approval;
    expect(approval).toMatchObject({ status: "pending", kind: "external", summary: "Search the web with Tavily for “node 24 release”", preview: "node 24 release" });
    expect(f.requests).toEqual([]);

    const { action } = await c.json(`/api/actions/${approval.id}/approve`, { method: "POST", body: {} });
    expect(action.status).toBe("approved");
    expect(action.result).toContain("1. Node.js 24 is out (2026-05-06)\n   https://nodejs.org/en/blog/release/v24.0.0");
    expect(f.requests.map((r) => r.body.query)).toEqual(["node 24 release"]);
    // Runs once.
    expect((await c.call(`/api/actions/${approval.id}/approve`, { method: "POST", body: {} })).status).toBe(409);
    expect(f.requests).toHaveLength(1);
  });

  it("refuses an approval after web search is turned off", async () => {
    const f = fakeSearch();
    await useFake(f);
    const c = await loggedIn();
    await setWebSearch(c, { provider: "tavily" });
    const approval = done(await chat(c, "web search weather")).tools[0].approval;
    await setWebSearch(c, { provider: "off" });
    const res = await c.call(`/api/actions/${approval.id}/approve`, { method: "POST", body: {} });
    expect(res.status).toBe(404);
    expect(f.requests).toEqual([]);
  });
});

describe("web search: settings and backups", () => {
  it("is never turned on by a backup import", async () => {
    await inAgent(async (a) => {
      const backup = exportData(a.services) as any;
      backup.data.settings.webSearch = { provider: "tavily", policy: "auto" };
      const summary = await importData(a.services, backup);
      expect(summary.ignored_settings).toContain("webSearch");
      expect(a.services.settings.get().webSearch).toEqual({ provider: "off", policy: "approve" });
    });
  });

  it("is out of reach of remote access tokens", () => {
    expect(isRemoteAllowed("GET", "/api/web-search")).toBe(false);
    expect(isRemoteAllowed("PATCH", "/api/settings")).toBe(false);
  });

  it("reads Exa results and drops entries without an http(s) link", () => {
    expect(
      parseResults("exa", {
        results: [
          { title: "  Museum   hours ", url: "https://museum.example/visit", text: "Open Tuesday to Sunday.", publishedDate: "2026-01-02T10:00:00.000Z" },
          { title: "No link" },
          { url: "ftp://files.example/x", text: "dropped" },
          { url: "https://untitled.example/page", text: "x".repeat(900) },
        ],
      }),
    ).toEqual([
      { title: "Museum hours", url: "https://museum.example/visit", excerpt: "Open Tuesday to Sunday.", published: "2026-01-02" },
      { title: "untitled.example", url: "https://untitled.example/page", excerpt: expect.stringMatching(/^x+…?$/) },
    ]);
    expect(parseResults("exa", { results: "nope" })).toEqual([]);
    expect(parseResults("tavily", null)).toEqual([]);
  });

  it("calls Exa with the x-api-key header", async () => {
    await inAgent(async (a) => {
      const settings = new SettingsService(a.services.db);
      const service = new WebSearchService({ EXA_API_KEY: "exa-test" }, settings, a.services.activity);
      const seen: { url: string; headers: Headers; body: any }[] = [];
      service.fetch = async (input, init) => {
        seen.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
        return Response.json({ results: [{ title: "A", url: "https://a.example/", text: "alpha" }] });
      };
      settings.update({ webSearch: { provider: "exa", policy: "auto" } });
      const out = await service.search("alpha");
      settings.update({ webSearch: { provider: "off" } });
      expect(out).toEqual({ provider: "exa", results: [{ title: "A", url: "https://a.example/", excerpt: "alpha" }] });
      expect(seen[0]!.url).toBe("https://api.exa.ai/search");
      expect(seen[0]!.headers.get("x-api-key")).toBe("exa-test");
      expect(seen[0]!.body).toEqual({ query: "alpha", type: "auto", numResults: 5, contents: { text: { maxCharacters: 500 } } });
    });
  });
});
