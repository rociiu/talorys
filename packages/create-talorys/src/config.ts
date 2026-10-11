import { randomBytes } from "node:crypto";

/** Compatibility date for the generated Worker. */
export const COMPATIBILITY_DATE = "2026-10-01";

/**
 * Durable Object classes, declared with Cloudflare's `exports` lifecycle.
 * The first deploy creates the SQLite-backed namespace; later deploys keep it.
 * Installations created by Wrangler with the `v1` migration
 * (`new_sqlite_classes: ["TalorysAgent"]`) keep their namespace and data when
 * they switch to this declaration. Never remove a class or set a `state` here
 * without a migration plan: that is how a namespace (and the owner's data) is
 * deleted. Must match apps/agent/wrangler.jsonc.
 */
export const DO_EXPORTS = { TalorysAgent: { type: "durable-object", storage: "sqlite" } } as const;

export const DO_BINDING = "TalorysAgent";

/**
 * Static assets for the frontend. Asset requests are served directly by Cloudflare
 * without invoking the Worker; only /api/* runs Worker code. Unknown paths fall
 * back to index.html so client-side routes work on reload.
 * Must match apps/agent/wrangler.jsonc.
 */
export const ASSETS_CONFIG = {
  notFoundHandling: "single-page-application",
  runWorkerFirst: ["/api/*"],
} as const;

/** Where `cf deploy --prebuilt` reads the Build Output, relative to the project directory. */
export const BUILD_OUTPUT_DIR = ".cloudflare/output/v0";
export const WORKER_OUTPUT_DIR = `${BUILD_OUTPUT_DIR}/workers/default`;

export interface ResourceNames {
  installationId: string;
  workerName: string;
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Collision-resistant, DNS-safe installation id (8 chars ≈ 41 bits). */
export function generateInstallationId(bytes = randomBytes(8)): string {
  let id = "";
  for (const b of bytes) id += ALPHABET[b % ALPHABET.length];
  // Must start with a letter for maximum compatibility with naming rules.
  return /^[a-z]/.test(id) ? id : `t${id.slice(1)}`;
}

/**
 * Names for a new installation. Installations created before the single-Worker
 * layout keep the names recorded in their manifest (`talorys-<id>-agent`), because
 * renaming the Worker would detach it from its Durable Object data.
 */
export function resourceNames(installationId: string): ResourceNames {
  if (!/^[a-z][a-z0-9]{3,15}$/.test(installationId)) throw new Error(`Invalid installation id: ${installationId}`);
  return { installationId, workerName: `talorys-${installationId}` };
}

export interface WorkerConfigInput {
  workerName: string;
  installationId: string;
  version: string;
  timezone: string;
  agentName: string;
  /** Emits TALORYS_SEMANTIC_DEFAULT "on" so the agent seeds semantic recall once on first boot. */
  semanticDefault?: boolean;
}

const text = (value: string) => ({ type: "text", value });

/**
 * worker.config.json for the Talorys Worker (cf Build Output): frontend assets,
 * API and the agent Durable Object. Secrets are not declared: cf keeps the
 * Worker's existing secrets on every deploy, and the installer uploads missing
 * ones with the deploy itself.
 */
export function generateWorkerConfig(input: WorkerConfigInput): Record<string, unknown> {
  return {
    name: input.workerName,
    compatibilityDate: COMPATIBILITY_DATE,
    compatibilityFlags: ["nodejs_compat"],
    // The workers.dev URL is the app's address. Preview URLs stay off so old versions are never reachable.
    workersDev: true,
    previewUrls: false,
    observability: { enabled: true },
    assets: ASSETS_CONFIG,
    env: {
      AI: { type: "ai" },
      [DO_BINDING]: { type: "durable-object", worker: input.workerName, exportName: "TalorysAgent" },
      TALORYS_INSTALLATION_ID: text(input.installationId),
      TALORYS_DEPLOYED_VERSION: text(input.version),
      TALORYS_DEFAULT_TIMEZONE: text(input.timezone),
      TALORYS_AGENT_NAME: text(input.agentName),
      // Only a Yes adds a var, so a No install's config matches upstream exactly.
      ...(input.semanticDefault ? { TALORYS_SEMANTIC_DEFAULT: text("on") } : {}),
    },
    exports: DO_EXPORTS,
    manifest: { type: "partial", mainModule: "worker.js", modules: {} },
  };
}

/** config.json at the Build Output root. Pins deploys to the installation's account. */
export function generateBuildOutputConfig(input: { accountId: string }): Record<string, unknown> {
  return { accountId: input.accountId, buildContext: { isPreview: false } };
}

export function toJson(config: Record<string, unknown>): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function detectTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
