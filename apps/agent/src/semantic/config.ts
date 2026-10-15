import { z } from "zod";
import type { Database } from "../db/database";
import type { SettingsService } from "../services/settings";
import { ValidationError } from "../api/errors";
import { ensureSemanticSchema } from "./migrations";

/** `tal_settings` key holding the semantic recall config. Absent means never enabled. */
export const SEMANTIC_CONFIG_KEY = "semantic.recall";

export const semanticConfigSchema = z.object({
  enabled: z.boolean(),
  model: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^@(cf|hf)\/[\w.\-/]+$/, "Must be a Workers AI model id"),
  maxEmbeddingsPerDay: z.number().int().min(0).max(10_000),
  /** Item embedding requests per UTC day for tasks, notes and automations, apart from the memory cap. */
  maxItemEmbeddingsPerDay: z.number().int().min(0).max(10_000),
  vectorFloor: z.object({
    absolute: z.number().min(0).max(1),
    relative: z.number().min(0).max(1),
    /** Lowest cosine for a top-k fallback hit; never above `absolute`. */
    backstop: z.number().min(0).max(1),
  }),
});

export type SemanticConfig = z.infer<typeof semanticConfigSchema>;

type VectorFloor = SemanticConfig["vectorFloor"];

const BGE_M3_FLOOR: VectorFloor = { absolute: 0.55, relative: 0.1, backstop: 0.4 };
const BGE_EN_FLOOR: VectorFloor = { absolute: 0.5, relative: 0.1, backstop: 0.35 };

/** Floor defaults per embedding model; the English bge models score higher cosines than bge-m3. */
export const MODEL_FLOOR_DEFAULTS: Record<string, VectorFloor> = {
  "@cf/baai/bge-m3": BGE_M3_FLOOR,
  "@cf/baai/bge-small-en-v1.5": BGE_EN_FLOOR,
  "@cf/baai/bge-base-en-v1.5": BGE_EN_FLOOR,
  "@cf/baai/bge-large-en-v1.5": BGE_EN_FLOOR,
};

/** A copy of the model's floor defaults; unknown models get the bge-m3 values. */
export function floorDefaultsFor(model: string): VectorFloor {
  return { ...(MODEL_FLOOR_DEFAULTS[model] ?? BGE_M3_FLOOR) };
}

const sameFloor = (a: VectorFloor, b: VectorFloor) =>
  a.absolute === b.absolute && a.relative === b.relative && a.backstop === b.backstop;

/** The default daily item embedding request cap. */
export const ITEM_EMBEDDINGS_PER_DAY = 50;

export const DEFAULT_SEMANTIC_CONFIG: SemanticConfig = {
  enabled: false,
  model: "@cf/baai/bge-m3",
  maxEmbeddingsPerDay: 500,
  maxItemEmbeddingsPerDay: ITEM_EMBEDDINGS_PER_DAY,
  vectorFloor: floorDefaultsFor("@cf/baai/bge-m3"),
};

/** The default model before bge-m3. Stored with its untouched 0.5/0.1 floors, it reads as the new defaults. */
export const LEGACY_DEFAULT_MODEL = "@cf/baai/bge-small-en-v1.5";
const LEGACY_DEFAULT_FLOOR = { absolute: 0.5, relative: 0.1 };

/** True for a stored legacy model whose floors are absent or exactly the legacy defaults. */
function isLegacyDefault(model: unknown, floor: unknown): boolean {
  if (model !== LEGACY_DEFAULT_MODEL) return false;
  if (floor === undefined) return true;
  if (!floor || typeof floor !== "object" || Array.isArray(floor)) return false;
  const f = floor as Record<string, unknown>;
  return (
    Object.keys(f).length === 2 && f.absolute === LEGACY_DEFAULT_FLOOR.absolute && f.relative === LEGACY_DEFAULT_FLOOR.relative
  );
}

/** A partial update; fields outside the config fields are stripped. */
export const semanticConfigPatchSchema = semanticConfigSchema
  .extend({ vectorFloor: semanticConfigSchema.shape.vectorFloor.partial() })
  .partial();

export type SemanticConfigPatch = z.input<typeof semanticConfigPatchSchema>;

const defaults = (enabled = false): SemanticConfig => ({
  ...DEFAULT_SEMANTIC_CONFIG,
  vectorFloor: { ...DEFAULT_SEMANTIC_CONFIG.vectorFloor },
  enabled,
});

const defined = <T extends object>(obj: T): Partial<T> =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;

/**
 * Returns the stored config merged over the defaults, or null when the key is absent
 * (the feature was never enabled). Unknown fields are ignored. A present but invalid
 * value reads as the defaults, keeping `enabled` when it is a boolean. Pass `db` to tell an unparseable stored value from an absent key.
 * A stored untouched legacy default (bge-small with floors 0.5/0.1) reads with the current
 * default model and floors; the stored value itself is never rewritten. A stored floor without
 * `backstop` gets the stored model's default one, lowered to `absolute` when that is below it,
 * and an invalid stored model reads as the default model.
 */
export function readSemanticConfig(settings: SettingsService, db?: Database): SemanticConfig | null {
  const stored = settings.getJson<unknown>(SEMANTIC_CONFIG_KEY);
  if (stored === null) {
    const present = db?.one(`SELECT key FROM tal_settings WHERE key = ?`, SEMANTIC_CONFIG_KEY) ?? null;
    return present ? defaults() : null;
  }
  if (typeof stored !== "object" || Array.isArray(stored)) return defaults();
  const raw = stored as Record<string, unknown>;
  const partial = isLegacyDefault(raw.model, raw.vectorFloor)
    ? { ...raw, model: DEFAULT_SEMANTIC_CONFIG.model, vectorFloor: { ...DEFAULT_SEMANTIC_CONFIG.vectorFloor } }
    : raw;
  const enabled = typeof partial.enabled === "boolean" ? partial.enabled : false;
  const parsedModel = semanticConfigSchema.shape.model.safeParse(partial.model);
  const model = parsedModel.success ? parsedModel.data : DEFAULT_SEMANTIC_CONFIG.model;
  const floor = partial.vectorFloor;
  const parsed = semanticConfigSchema.safeParse({
    ...DEFAULT_SEMANTIC_CONFIG,
    ...partial,
    model,
    vectorFloor: {
      ...floorDefaultsFor(model),
      ...(floor && typeof floor === "object" && !Array.isArray(floor) ? floor : {}),
    },
  });
  if (!parsed.success) return defaults(enabled);
  // A config stored before the backstop existed may hold an absolute floor under the default backstop.
  const f = parsed.data.vectorFloor;
  if (f.backstop > f.absolute) {
    const storedBackstop = floor && typeof floor === "object" && "backstop" in floor;
    if (storedBackstop) return defaults(enabled);
    f.backstop = f.absolute;
  }
  return parsed.data;
}

/**
 * The config a patch would produce, without storing it. Throws ValidationError on invalid values.
 * A model change without `vectorFloor` moves default floors to the new model's defaults;
 * custom floors are kept.
 */
export function mergeSemanticConfig(current: SemanticConfig | null, patch: SemanticConfigPatch): SemanticConfig {
  const parsedPatch = semanticConfigPatchSchema.safeParse(patch);
  if (!parsedPatch.success) throw ValidationError.fromZod(parsedPatch.error);
  const base = current ?? defaults();
  const { vectorFloor, ...rest } = parsedPatch.data;
  const resetFloor =
    vectorFloor === undefined &&
    rest.model !== undefined &&
    rest.model !== base.model &&
    sameFloor(base.vectorFloor, floorDefaultsFor(base.model));
  const parsed = semanticConfigSchema.safeParse({
    ...base,
    ...defined(rest),
    vectorFloor: resetFloor ? floorDefaultsFor(rest.model!) : { ...base.vectorFloor, ...defined(vectorFloor ?? {}) },
  });
  if (!parsed.success) throw ValidationError.fromZod(parsed.error);
  const { absolute, backstop } = parsed.data.vectorFloor;
  if (backstop > absolute) {
    throw new ValidationError(`vectorFloor.backstop (${backstop}) must not be above vectorFloor.absolute (${absolute})`);
  }
  return parsed.data;
}

/**
 * Validates a patch and stores the resulting config (only the config fields).
 * With `db`, enabling creates the schema before the key is written, so a failed
 * migration never records the feature as on.
 */
export function writeSemanticConfig(settings: SettingsService, patch: SemanticConfigPatch, db?: Database): SemanticConfig {
  const next = mergeSemanticConfig(readSemanticConfig(settings, db), patch);
  if (db && next.enabled) ensureSemanticSchema(db);
  settings.setJson(SEMANTIC_CONFIG_KEY, next);
  return next;
}

/** Removes the config key, returning the feature to its never-enabled state. */
export function deleteSemanticConfig(settings: SettingsService): void {
  settings.delete(SEMANTIC_CONFIG_KEY);
}
