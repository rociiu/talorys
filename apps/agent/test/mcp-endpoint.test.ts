import { expect, it } from "vitest";
import { mcpUrlProblem } from "../src/mcp/endpoint";
import { guardedFetch } from "../src/mcp/client";

it.each([
  "http://mcp.example.com",
  "https://10.0.0.1",
  "https://[::1]",
  "https://localhost",
  "https://x.internal",
  "https://metadata.google.internal",
  "https://x.local",
  "https://x.home.arpa",
  "https://a:b@mcp.example.com",
  "https://single",
  "https://127.1",
  "https://2130706433",
  "https://0x7f000001",
  "https://x.localhost.",
  "https://x.internal..",
])("refuses private/IP-literal URL %s", (url) => {
  expect(mcpUrlProblem(url)).not.toBeNull();
});
it("accepts public HTTPS and explicitly gated local development", () => {
  expect(mcpUrlProblem("https://mcp.example.com/mcp?x=1")).toBeNull();
  expect(mcpUrlProblem("http://localhost:8790", { allowLocal: true })).toBeNull();
  expect(mcpUrlProblem("http://127.0.0.1:8790", { allowLocal: true })).toBeNull();
  expect(mcpUrlProblem("http://127.0.0.1:8790")).not.toBeNull();
  expect(mcpUrlProblem("http://10.0.0.1:8790", { allowLocal: true })).not.toBeNull();
});
it("forces manual redirects and refuses redirects and oversized responses", async () => {
  const seen: unknown[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    seen.push(init?.redirect);
    return new Response(null, { status: 302 });
  };
  await expect(guardedFetch(fetcher, false)("https://mcp.example.com")).rejects.toThrow("redirects");
  expect(seen).toEqual(["manual"]);
  const large: typeof fetch = async () => new Response("", { headers: { "content-length": "1048577" } });
  await expect(guardedFetch(large, false)("https://mcp.example.com")).rejects.toThrow("too large");
});
it("stops reading a response with no Content-Length once it passes 1 MiB", async () => {
  let pulled = 0;
  const chunk = new Uint8Array(64 * 1024);
  const streamed: typeof fetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulled === 64) return controller.close(); // 4 MiB in total
          pulled++;
          controller.enqueue(chunk);
        },
      }),
    );
  const response = await guardedFetch(streamed, false)("https://mcp.example.com");
  expect(response.headers.get("content-length")).toBeNull();
  await expect(response.arrayBuffer()).rejects.toThrow("too large");
  expect(pulled).toBeLessThan(24);
  // A small streamed response still reads normally.
  const small: typeof fetch = async () => new Response(new Blob(["ok"]).stream());
  expect(await (await guardedFetch(small, false)("https://mcp.example.com")).text()).toBe("ok");
});
