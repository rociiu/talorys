import type { Env } from "../env";
import type { Services } from "../services/container";
import { selectRelevantMemories } from "../agent/memory";
import { readSemanticConfig, writeSemanticConfig, type SemanticConfig } from "./config";
import type { RunnerExtensions } from "./hooks";
import { fitItemLines, selectSemanticItems } from "./itemRecall";
import { ensureSemanticSchema } from "./migrations";
import { type SemanticContext, createSemanticContext, selectSemanticMemories } from "./recall";
import { semanticTools } from "./tools";

export type { RunnerExtensions } from "./hooks";

/** Services whose semantic config key was absent (never enabled) at last read. */
const neverEnabled = new WeakMap<Services, boolean>();

/** Forgets the cached never-enabled result; call after every config write or delete. */
export function invalidateSemanticCache(services: Services): void {
  neverEnabled.delete(services);
}

/**
 * The stored semantic config, or null when the feature was never enabled. The
 * never-enabled answer is cached per services object, so untouched installs pay
 * one settings read until `invalidateSemanticCache` is called.
 */
export function cachedSemanticConfig(services: Services): SemanticConfig | null {
  if (neverEnabled.get(services)) return null;
  const config = readSemanticConfig(services.settings, services.db);
  if (config === null) neverEnabled.set(services, true);
  return config;
}

/** Installer-written Worker var; "on" seeds the feature once on a fresh install. */
export const SEMANTIC_DEFAULT_VAR = "TALORYS_SEMANTIC_DEFAULT";

/**
 * Applies the installer's opt-in once: when the var is "on" and the config key is
 * absent, enables the feature and logs it. A present key (including one the owner
 * turned off, or a corrupt one) always wins, so Settings stays the source of truth.
 */
export function seedSemanticDefault(services: Services, env: Env): boolean {
  if ((env as Env & Partial<Record<typeof SEMANTIC_DEFAULT_VAR, string>>)[SEMANTIC_DEFAULT_VAR] !== "on") return false;
  if (cachedSemanticConfig(services) !== null) return false;
  writeSemanticConfig(services.settings, { enabled: true }, services.db);
  invalidateSemanticCache(services);
  services.activity.record("semantic.seeded", "Semantic recall enabled from the installer default");
  return true;
}

/**
 * The runner's item hook: recalled item lines that fit the memory budget. Never throws; on any
 * error the prompt simply has no items section.
 */
export function semanticItemSelector(ctx: SemanticContext): NonNullable<RunnerExtensions["selectItems"]> {
  return async (query, memories, budget) => {
    try {
      return fitItemLines(selectSemanticItems(ctx, query), memories, budget);
    } catch (error) {
      console.warn("Semantic item recall failed", error instanceof Error ? error.message : String(error));
      return [];
    }
  };
}

/**
 * Runner extensions for the semantic module, or undefined when the feature is off so
 * the runner keeps its upstream behaviour. Never throws: a failure here must not break chat.
 * `background` keeps work started by a turn alive after it returns.
 */
export function semanticExtensions(
  services: Services,
  env: Env,
  background?: (work: Promise<unknown>) => void,
): RunnerExtensions | undefined {
  try {
    seedSemanticDefault(services, env);
    const config = cachedSemanticConfig(services);
    if (!config?.enabled) return undefined;
    ensureSemanticSchema(services.db);
    const ctx = createSemanticContext(services, env, config, background);
    return {
      // Recall must never fail a turn; on any error the upstream keyword selection stands in.
      selectMemories: async (query) => {
        try {
          return await selectSemanticMemories(ctx, query);
        } catch (error) {
          console.warn("Semantic recall failed; using keyword recall", error instanceof Error ? error.message : String(error));
          return selectRelevantMemories(services.memories, query);
        }
      },
      selectItems: semanticItemSelector(ctx),
      tools: semanticTools(ctx),
    };
  } catch (error) {
    console.warn("Semantic extensions unavailable", error);
    return undefined;
  }
}
