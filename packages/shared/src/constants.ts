export const TALORYS_VERSION = "0.1.7";

/** Stable identity of the single owner's agent inside the private DO namespace. */
export const AGENT_INSTANCE_NAME = "personal-agent";

/**
 * Default Workers AI model. Verified on developers.cloudflare.com/workers-ai/models:
 * Cloudflare-hosted, supports function calling and streaming, 131k context.
 */
export const DEFAULT_MODEL = "@cf/zai-org/glm-4.7-flash";

export const BACKUP_FORMAT = "talorys-backup";
export const BACKUP_VERSION = 1;

export const SESSION_COOKIE = "__Host-talorys_session";
export const DEV_SESSION_COOKIE = "talorys_session";

/** Header sent by the SPA on every API call. Simple-request CSRF can't set custom headers. */
export const CSRF_HEADER = "x-talorys-request";

export const GITHUB_URL = "https://github.com/rociiu/talorys";

/** Languages the web UI ships messages for. English is the default and the fallback for missing keys. */
export const LANGUAGES = ["en", "ko"] as const;
export type Language = (typeof LANGUAGES)[number];

export const DEFAULT_LIMITS = {
  maxOutputTokens: 1024,
  maxToolCalls: 6,
  maxAgentIterations: 4,
  maxContextTokens: 6000,
  maxScheduledAiRunsPerDay: 6,
  maxAiRequestsPerDay: 200,
} as const;

/** Memory history defaults: rule-based conflict detection on, AI conflict check off. */
export const DEFAULT_MEMORY_HISTORY = {
  conflictReview: true,
  aiConflictCheck: false,
} as const;

/** Hard ceilings the owner cannot exceed through settings. */
export const LIMIT_CEILINGS = {
  maxOutputTokens: 4096,
  maxToolCalls: 20,
  maxAgentIterations: 10,
  maxContextTokens: 32000,
  maxScheduledAiRunsPerDay: 48,
  maxAiRequestsPerDay: 2000,
} as const;
