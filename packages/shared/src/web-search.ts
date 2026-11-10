import { z } from "zod";

/** Search APIs the built-in web_search tool can use. Each needs its own key, set as a Worker secret. */
export const WEB_SEARCH_PROVIDERS = ["tavily", "exa"] as const;
export type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number];

/** The Worker secret that holds each provider's API key. */
export const WEB_SEARCH_KEY_SECRETS: Record<WebSearchProvider, string> = {
  tavily: "TAVILY_API_KEY",
  exa: "EXA_API_KEY",
};

export const WEB_SEARCH_PROVIDER_NAMES: Record<WebSearchProvider, string> = {
  tavily: "Tavily",
  exa: "Exa",
};

/** The name of the built-in web search tool. */
export const WEB_SEARCH_TOOL = "web_search";

/**
 * `approve` shows each query on an approval card and searches only after the owner approves it;
 * `auto` searches at once and is the owner's decision to let queries leave without review.
 */
export const WEB_SEARCH_POLICIES = ["approve", "auto"] as const;
export type WebSearchPolicy = (typeof WEB_SEARCH_POLICIES)[number];

export const webSearchSettingsSchema = z.object({
  /** "off" (the default) offers no tool and sends nothing. */
  provider: z.enum(["off", ...WEB_SEARCH_PROVIDERS]),
  policy: z.enum(WEB_SEARCH_POLICIES),
});
export type WebSearchSettings = z.infer<typeof webSearchSettingsSchema>;

export const DEFAULT_WEB_SEARCH: WebSearchSettings = { provider: "off", policy: "approve" };

/** Which providers this deployment has a key for. Keys themselves never leave the backend. */
export interface WebSearchStatus {
  providers: { id: WebSearchProvider; name: string; configured: boolean; secret: string }[];
}
