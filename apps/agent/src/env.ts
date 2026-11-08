import type { TalorysAgent } from "./agent/talorys-agent";

export interface Env {
  AI?: Ai;
  TalorysAgent: DurableObjectNamespace<TalorysAgent>;
  /** PBKDF2 hash of the owner password, set by the installer as a Worker secret. */
  OWNER_PASSWORD_HASH?: string;
  /** Plain owner password, for deploys that cannot set the hash (a one-Worker deploy). Ignored when the hash is set; a weak one counts as not configured. */
  OWNER_PASSWORD?: string;
  /** Random 256-bit secret used to key session token hashes. Worker secret. */
  SESSION_SECRET?: string;
  /**
   * Web Push (VAPID) key pair, base64url: the uncompressed public point and the private scalar.
   * Set by the installer as Worker secrets; without them push is unavailable and nothing else changes.
   */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  /** Contact sent to push services ("mailto:..." or "https://..."). Defaults to the app's own URL. */
  VAPID_SUBJECT?: string;
  /**
   * Random secret that encrypts remote MCP server credentials at rest. Worker secret, set by the
   * installer. Without it, servers that need a bearer token can't be added; nothing else changes.
   */
  MCP_CREDENTIAL_KEY?: string;
  /** "off" turns remote MCP servers off for this deployment. */
  TALORYS_MCP?: string;
  /** Most MCP tools enabled at once (default 20, at most 64). */
  TALORYS_MCP_MAX_TOOLS?: string;
  /**
   * API keys for the built-in web search (Worker secrets). Web search stays off until the owner
   * picks a provider whose key is set; without keys nothing changes.
   */
  TAVILY_API_KEY?: string;
  EXA_API_KEY?: string;
  /** "development" enables local-only conveniences (mock AI, http cookies). Never set in production. */
  TALORYS_ENV?: string;
  /** Development only: use the deterministic mock AI provider. */
  TALORYS_MOCK_AI?: string;
  /** Development only: extra allowed origins (comma separated), e.g. the Vite dev server. */
  TALORYS_DEV_ORIGINS?: string;
  /** Installer defaults: the owner's timezone and chosen agent name. */
  TALORYS_DEFAULT_TIMEZONE?: string;
  TALORYS_AGENT_NAME?: string;
  /** Informational, written by the installer. */
  TALORYS_INSTALLATION_ID?: string;
  TALORYS_DEPLOYED_VERSION?: string;
}
