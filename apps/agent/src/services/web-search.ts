import {
  WEB_SEARCH_KEY_SECRETS,
  WEB_SEARCH_PROVIDER_NAMES,
  WEB_SEARCH_PROVIDERS,
  type WebSearchPolicy,
  type WebSearchProvider,
  type WebSearchStatus,
} from "@talorys/shared";
import type { Env } from "../env";
import { ToolError } from "../tools/registry";
import type { ActivityLog } from "./usage";
import type { SettingsService } from "./settings";
import { clip } from "./text";

export const WEB_SEARCH_LIMITS = {
  maxResults: 5,
  maxTitle: 200,
  maxExcerpt: 500,
  maxCallsPerTurn: 2,
  timeoutMs: 10_000,
  /** Largest provider response Talorys reads. */
  maxResponseBytes: 512 * 1024,
} as const;

export interface WebSearchResult {
  title: string;
  url: string;
  excerpt: string;
  published?: string;
}

/** The fixed endpoint each provider is called at. Only the query and fixed options are sent. */
const ENDPOINTS: Record<WebSearchProvider, string> = {
  tavily: "https://api.tavily.com/search",
  exa: "https://api.exa.ai/search",
};

function request(provider: WebSearchProvider, key: string, query: string): RequestInit {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (provider === "tavily") {
    headers.authorization = `Bearer ${key}`;
    return {
      method: "POST",
      headers,
      body: JSON.stringify({ query, search_depth: "basic", max_results: WEB_SEARCH_LIMITS.maxResults, include_answer: false, include_raw_content: false, include_images: false }),
    };
  }
  headers["x-api-key"] = key;
  return {
    method: "POST",
    headers,
    body: JSON.stringify({ query, type: "auto", numResults: WEB_SEARCH_LIMITS.maxResults, contents: { text: { maxCharacters: WEB_SEARCH_LIMITS.maxExcerpt } } }),
  };
}

const oneLine = (value: unknown, max: number) => (typeof value === "string" ? clip(value.replace(/\s+/g, " ").trim(), max) : "");

function safeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Reads the provider's results into one shape, dropping anything without a usable http(s) link. */
export function parseResults(provider: WebSearchProvider, body: unknown): WebSearchResult[] {
  const raw = body && typeof body === "object" && Array.isArray((body as { results?: unknown }).results) ? (body as { results: unknown[] }).results : [];
  const out: WebSearchResult[] = [];
  for (const item of raw) {
    if (out.length >= WEB_SEARCH_LIMITS.maxResults) break;
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const url = safeUrl(r.url);
    if (!url) continue;
    const published = provider === "tavily" ? r.published_date : r.publishedDate;
    out.push({
      title: oneLine(r.title, WEB_SEARCH_LIMITS.maxTitle) || new URL(url).host,
      url,
      excerpt: oneLine(provider === "tavily" ? r.content : r.text, WEB_SEARCH_LIMITS.maxExcerpt),
      ...(typeof published === "string" && published ? { published: published.slice(0, 10) } : {}),
    });
  }
  return out;
}

async function readCapped(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > WEB_SEARCH_LIMITS.maxResponseBytes) {
      await reader.cancel();
      throw new ToolError("The search provider sent too much data.");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** What the active web search is right now; null when it is off or the chosen provider has no key. */
export interface ActiveWebSearch {
  provider: WebSearchProvider;
  policy: WebSearchPolicy;
}

/**
 * The built-in web search: one fixed endpoint per provider, called with only the query. It never
 * fetches a page or a URL the model chose.
 */
export class WebSearchService {
  /** Replaced in tests with an offline fake. */
  fetch: typeof fetch = (input, init) => fetch(input, init);

  constructor(
    private readonly env: Pick<Env, "TAVILY_API_KEY" | "EXA_API_KEY">,
    private readonly settings: SettingsService,
    private readonly activity: ActivityLog,
  ) {}

  private key(provider: WebSearchProvider): string | null {
    const value = provider === "tavily" ? this.env.TAVILY_API_KEY : this.env.EXA_API_KEY;
    return value?.trim() ? value.trim() : null;
  }

  configured(provider: WebSearchProvider): boolean {
    return this.key(provider) !== null;
  }

  status(): WebSearchStatus {
    return {
      providers: WEB_SEARCH_PROVIDERS.map((id) => ({ id, name: WEB_SEARCH_PROVIDER_NAMES[id], configured: this.configured(id), secret: WEB_SEARCH_KEY_SECRETS[id] })),
    };
  }

  active(): ActiveWebSearch | null {
    const { provider, policy } = this.settings.get().webSearch;
    if (provider === "off" || !this.configured(provider)) return null;
    return { provider, policy };
  }

  /** Searches with the provider that is active now. Logs the provider and outcome, never the query. */
  async search(query: string, signal?: AbortSignal): Promise<{ provider: WebSearchProvider; results: WebSearchResult[] }> {
    const active = this.active();
    if (!active) throw new ToolError("Web search is turned off.");
    const { provider } = active;
    const name = WEB_SEARCH_PROVIDER_NAMES[provider];
    const started = Date.now();
    const log = (outcome: string) => this.activity.record("web_search.call", `${name} → ${outcome} (${Date.now() - started} ms)`);
    const timeout = AbortSignal.timeout(WEB_SEARCH_LIMITS.timeoutMs);
    let response: Response;
    try {
      response = await this.fetch(ENDPOINTS[provider], { ...request(provider, this.key(provider)!, query), redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    } catch (error) {
      if (signal?.aborted) throw error;
      log(timeout.aborted ? "timed out" : "unreachable");
      throw new ToolError(timeout.aborted ? `${name} didn't answer in time.` : `Couldn't reach ${name}.`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      log(`HTTP ${response.status}`);
      const reason =
        response.status === 401 || response.status === 403 ? `${name} rejected the API key.`
        : response.status === 429 || response.status === 432 || response.status === 402 ? `${name}'s usage limit was reached. Try again later.`
        : `${name} returned an error (HTTP ${response.status}).`;
      throw new ToolError(reason);
    }
    let body: unknown;
    try {
      body = JSON.parse(await readCapped(response));
    } catch (error) {
      log("unreadable response");
      if (error instanceof ToolError) throw error;
      throw new ToolError(`${name} sent a response Talorys couldn't read.`);
    }
    const results = parseResults(provider, body);
    log(`${results.length} result(s)`);
    return { provider, results };
  }
}
