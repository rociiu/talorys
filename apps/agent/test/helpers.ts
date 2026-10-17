import { env, exports } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { runInDurableObject } from "cloudflare:test";
import type { TalorysAgent } from "../src/agent/talorys-agent";
import type { Services } from "../src/services/container";
import { ALL_TOOLS, ToolExecutor } from "../src/tools";

/** True when the test pool runs the fake AI (TALORYS_MOCK_AI=1 in development), mirroring how the agent picks its provider. */
export const fakeAi = () => {
  const e = env as unknown as { TALORYS_ENV?: string; TALORYS_MOCK_AI?: string };
  return e.TALORYS_ENV === "development" && e.TALORYS_MOCK_AI === "1";
};

export const BASE = "https://talorys.example.pages.dev";
export const password = () => (env as unknown as { TEST_PASSWORD: string }).TEST_PASSWORD;

let ipCounter = 1;
/** Unique client IP so rate-limit state never leaks between tests. */
export const freshIp = () => `10.0.${Math.floor(ipCounter / 250)}.${ipCounter++ % 250}`;

export interface Client {
  cookie: string | null;
  ip: string;
  call(path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<Response>;
  json<T = any>(path: string, init?: { method?: string; body?: unknown }): Promise<T>;
}

export function client(opts: { ip?: string; cookie?: string | null } = {}): Client {
  const c: Client = {
    cookie: opts.cookie ?? null,
    ip: opts.ip ?? freshIp(),
    async call(path, init = {}) {
      const headers: Record<string, string> = {
        "cf-connecting-ip": c.ip,
        "x-talorys-request": "1",
        origin: BASE,
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(c.cookie ? { cookie: c.cookie } : {}),
        ...init.headers,
      };
      const res = await (exports as unknown as { default: Fetcher }).default.fetch(
        new Request(`${BASE}${path}`, { method: init.method ?? "GET", headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined }),
      );
      const set = res.headers.get("set-cookie");
      if (set) c.cookie = set.split(";")[0]!.endsWith("=") ? null : set.split(";")[0]!;
      return res;
    },
    async json(path, init) {
      const res = await c.call(path, init);
      return (await res.json()) as any;
    },
  };
  return c;
}

export async function loggedIn(): Promise<Client> {
  const c = client();
  const res = await c.call("/api/auth/login", { method: "POST", body: { password: password() } });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  return c;
}

export async function agentStub() {
  return getAgentByName((env as unknown as { TalorysAgent: DurableObjectNamespace<TalorysAgent> }).TalorysAgent, "personal-agent");
}

export async function inAgent<R>(fn: (agent: TalorysAgent) => R | Promise<R>): Promise<R> {
  const stub = await agentStub();
  return runInDurableObject(stub, async (instance: TalorysAgent) => fn(instance));
}

/** Parses an SSE body into events. */
export async function readSse(res: Response): Promise<any[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .map((block) => block.split("\n").find((l) => l.startsWith("data:")))
    .filter(Boolean)
    .map((l) => JSON.parse(l!.slice(5)));
}

/** Proposes a destructive tool call the way a chat turn does and returns the pending action's id. */
export async function proposeAction(s: Services, name: string, input: unknown): Promise<string> {
  const conversation = s.conversations.create();
  const executor = new ToolExecutor(ALL_TOOLS, { services: s, timezone: "UTC", mode: "chat", conversationId: conversation.id }, { maxToolCalls: 4 });
  await executor.execute(name, input, "call-1");
  return executor.approvalFor("call-1")!.id;
}

/** A machine client: sends only `Authorization: Bearer`, no cookie, CSRF header or Origin. */
export function bearer(token: string, opts: { ip?: string } = {}): Client {
  const ip = opts.ip ?? freshIp();
  const c: Client = {
    cookie: null,
    ip,
    async call(path, init = {}) {
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        "cf-connecting-ip": ip,
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...init.headers,
      };
      return (exports as unknown as { default: Fetcher }).default.fetch(
        new Request(`${BASE}${path}`, { method: init.method ?? "GET", headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined }),
      );
    },
    async json(path, init) {
      return (await (await c.call(path, init)).json()) as any;
    },
  };
  return c;
}
