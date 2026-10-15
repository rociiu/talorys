import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../api/app";
import { AppError } from "../api/errors";
import type { Database } from "../db/database";
import { body, query } from "../api/middleware";
import { UsageService } from "../services/usage";
import {
  DEFAULT_SEMANTIC_CONFIG,
  type SemanticConfig,
  deleteSemanticConfig,
  semanticConfigPatchSchema,
  writeSemanticConfig,
} from "./config";
import { MockEmbedder, createEmbedder, embeddingsToday } from "./embeddings";
import { cachedSemanticConfig, invalidateSemanticCache } from "./index";
import {
  type IndexReport,
  pendingMemories,
  purgeAllVectors,
  purgeVector,
  runIndexer,
  startBackgroundBackfill,
  startBackgroundIndex,
} from "./indexer";
import {
  ITEM_TYPES,
  type ItemType,
  countIndexedItems,
  countItemVectors,
  deleteAllItemVectors,
  deleteItemParts,
  dropItemVectorCache,
  purgeOrphanItemVectors,
} from "./itemStore";
import { dropSemanticData, ensureSemanticSchema, semanticSchema, tableExists } from "./migrations";
import { LAZY_INDEX_BATCH, type SemanticContext, createSemanticContext, hybridSearch, rrf, savedAt } from "./recall";
import { type ItemPassReport, itemPassRunning, itemUsageToday, pendingItems, runItemPass, startBackgroundItemPass } from "./itemIndex";
import { automationKeywordHits, prepareSurfaceSearch, scanItemVectors } from "./itemSearch";
import { countVectors, deleteAllVectors, dropVectorCache } from "./vectorStore";

/**
 * Semantic recall API, mounted before `systemRoutes` and `dataRoutes` so its `/memories`
 * and `/import` middleware wraps the upstream handlers. Inherits session, CSRF and security
 * headers from `createApi`.
 */
export const semanticRoutes = new Hono<AppEnv>();

/** The enabled config with its schema in place; 409 CONFLICT while the feature is off. */
function requireEnabled(c: Context<AppEnv>): SemanticConfig {
  const s = c.env.agent.services;
  const config = cachedSemanticConfig(s);
  if (!config?.enabled) throw new AppError("CONFLICT", "Semantic memory recall is turned off.");
  ensureSemanticSchema(s.db);
  return config;
}

// ---------- Middleware around upstream memory writes ----------

const isSuccess = (status: number) => status >= 200 && status < 300;

/** The Durable Object's `waitUntil`, when the runtime exposes one. */
function waitUntilOf(c: Context<AppEnv>): ((promise: Promise<unknown>) => void) | undefined {
  const state = (c.env.agent as unknown as { ctx?: { waitUntil?: (promise: Promise<unknown>) => void } }).ctx;
  return typeof state?.waitUntil === "function" ? (promise) => state.waitUntil!(promise) : undefined;
}

/**
 * Runs after the upstream handler has produced its response. Errors are logged and
 * swallowed: a memory write never fails or changes because of this module.
 */
function afterWrite(c: Context<AppEnv>, config: SemanticConfig, purge?: (db: Database) => void): void {
  try {
    if (!isSuccess(c.res.status)) return;
    const s = c.env.agent.services;
    if (purge) purge(s.db);
    else if (config.enabled) startBackgroundIndex(createSemanticContext(s, c.env.env, config), waitUntilOf(c));
  } catch (error) {
    console.warn("Semantic on-save hook failed", error instanceof Error ? error.message : String(error));
  }
}

/** The stored config, or null when never enabled or unreadable, so the upstream write always runs. */
function writeConfig(c: Context<AppEnv>): SemanticConfig | null {
  try {
    return cachedSemanticConfig(c.env.agent.services);
  } catch (error) {
    console.warn("Semantic config unreadable", error instanceof Error ? error.message : String(error));
    return null;
  }
}

semanticRoutes.use("/memories", async (c, next) => {
  const config = writeConfig(c);
  await next();
  if (config === null) return;
  if (c.req.method === "DELETE") afterWrite(c, config, purgeAllVectors);
  else if (c.req.method === "POST") afterWrite(c, config);
});

semanticRoutes.use("/memories/*", async (c, next) => {
  const config = writeConfig(c);
  await next();
  if (config === null) return;
  if (c.req.method === "DELETE") {
    const id = decodeURIComponent(c.req.path.slice(c.req.path.lastIndexOf("/") + 1));
    afterWrite(c, config, (db) => purgeVector(db, id));
  } else if (c.req.method === "PATCH" || c.req.method === "POST") {
    // PATCH edits; POST under /memories/* covers "correct" (a new version) and reviews. The indexer
    // only embeds what's pending, so status-only changes cost nothing.
    afterWrite(c, config);
  }
});

semanticRoutes.use("/import", async (c, next) => {
  const config = writeConfig(c);
  await next();
  if (config === null || c.req.method !== "POST") return;
  afterWrite(c, config);
  // A full item pass: re-chunks every note and, by purging orphans first, drops vectors of items a restore removed.
  try {
    if (config.enabled && isSuccess(c.res.status)) {
      void startBackgroundItemPass(createSemanticContext(c.env.agent.services, c.env.env, config), waitUntilOf(c), { full: true });
    }
  } catch (error) {
    console.warn("Semantic import item pass failed", error instanceof Error ? error.message : String(error));
  }
});

// ---------- Middleware around upstream task, note and automation deletes ----------

const ITEM_ROUTES: [string, ItemType][] = [
  ["tasks", "task"],
  ["notes", "note"],
  ["automations", "automation"],
];

/**
 * After a successful item delete: removes the item's vectors (or, without an id, every orphaned
 * one), even while the feature is off. Saves and edits embed nothing here; the next chat turn or
 * search embeds whatever changed.
 */
function afterItemDelete(c: Context<AppEnv>, type: ItemType, id: string | null): void {
  try {
    if (!isSuccess(c.res.status)) return;
    const s = c.env.agent.services;
    if (id) deleteItemParts(s.db, type, id);
    else purgeOrphanItemVectors(s.db);
  } catch (error) {
    console.warn("Semantic item on-save hook failed", error instanceof Error ? error.message : String(error));
  }
}

for (const [segment, type] of ITEM_ROUTES) {
  const hook = async (c: Context<AppEnv>, next: () => Promise<void>) => {
    if (c.req.method !== "DELETE") return next();
    const config = writeConfig(c);
    await next();
    if (config === null) return;
    const parts = c.req.path.split("/");
    const at = parts.indexOf(segment);
    const id = at >= 0 && parts[at + 1] ? decodeURIComponent(parts[at + 1]!) : null;
    afterItemDelete(c, type, id);
  };
  semanticRoutes.use(`/${segment}`, hook);
  semanticRoutes.use(`/${segment}/*`, hook);
}

/**
 * Owner approval of any agent-proposed action: a deleted task, note or automation leaves no
 * vectors behind, even while the feature is off.
 */
semanticRoutes.use("/actions/*", async (c, next) => {
  const approving = c.req.method === "POST" && c.req.path.endsWith("/approve");
  const config = approving ? writeConfig(c) : null;
  await next();
  if (config === null || !isSuccess(c.res.status)) return;
  try {
    purgeOrphanItemVectors(c.env.agent.services.db);
  } catch (error) {
    console.warn("Semantic approve item purge failed", error instanceof Error ? error.message : String(error));
  }
});

/**
 * Owner approval of an agent-proposed `forget_memory`: upstream's approve route deletes the
 * memory, then this deletes its vector in the same request. Forgetting is a real delete, so it
 * runs even while the feature is off; the vector stays when the memory still exists (the
 * action failed or was already handled).
 */
semanticRoutes.use("/actions/*", async (c, next) => {
  const parts = c.req.path.split("/");
  const approving = c.req.method === "POST" && parts.at(-1) === "approve";
  let target: string | null = null;
  try {
    const stored = approving ? c.env.agent.services.pendingActions.get(decodeURIComponent(parts.at(-2) ?? "")) : null;
    target = stored?.tool === "forget_memory" ? stored.target_id : null;
  } catch (error) {
    console.warn("Semantic approve lookup failed", error instanceof Error ? error.message : String(error));
  }
  const config = target === null ? null : writeConfig(c);
  await next();
  if (target === null || config === null) return;
  const memoryId = target;
  afterWrite(c, config, (db) => {
    if (!c.env.agent.services.memories.get(memoryId)) purgeVector(db, memoryId);
  });
});

// ---------- Config, status and data ----------

semanticRoutes.get("/semantic/config", (c) => {
  const config = cachedSemanticConfig(c.env.agent.services);
  return c.json({ config, ever_enabled: config !== null });
});

semanticRoutes.put("/semantic/config", async (c) => {
  const patch = await body(c, semanticConfigPatchSchema);
  const s = c.env.agent.services;
  const previous = cachedSemanticConfig(s);
  const config = writeSemanticConfig(s.settings, patch, s.db);
  invalidateSemanticCache(s);
  if (config.model !== previous?.model) {
    dropVectorCache(s.db);
    dropItemVectorCache(s.db);
  }
  // A new model (or turning the feature on) leaves every memory pending; embed them in the background.
  if (config.enabled && (config.model !== previous?.model || !previous?.enabled)) {
    try {
      void startBackgroundBackfill(createSemanticContext(s, c.env.env, config), waitUntilOf(c));
    } catch (error) {
      console.warn("Semantic backfill trigger failed", error instanceof Error ? error.message : String(error));
    }
  }
  return c.json({ config });
});

/** Counts for the Settings card. Never embeds, never creates tables and never writes. */
semanticRoutes.get("/semantic/status", async (c) => {
  const s = c.env.agent.services;
  const config = cachedSemanticConfig(s);
  const enabled = config?.enabled ?? false;
  const model = config?.model ?? DEFAULT_SEMANTIC_CONFIG.model;
  const embedder = createEmbedder(c.env.env, s.settings, model);
  const schema = config === null ? null : semanticSchema(s.db);
  const current = embedder?.model ?? model;
  const items = schema && tableExists(s.db, "tal_semantic_item_vectors");
  return c.json({
    enabled,
    ever_enabled: config !== null,
    schema,
    embedder: embedder instanceof MockEmbedder ? "mock" : embedder ? "workers-ai" : "none",
    vectors: schema ? countVectors(s.db, current) : 0,
    pending: !enabled ? 0 : schema ? (await pendingMemories(s.db, current, embedder?.dims)).length : s.memories.count(),
    embeddings_today: schema ? embeddingsToday(s.db, UsageService.day()) : 0,
    cap: config?.maxEmbeddingsPerDay ?? DEFAULT_SEMANTIC_CONFIG.maxEmbeddingsPerDay,
    items: {
      vectors: items ? countItemVectors(s.db, current) : 0,
      pending: enabled && items ? (await pendingItems(s.db, current, embedder?.dims, { readOnly: true })).pending.length : 0,
      by_type: items ? countIndexedItems(s.db, current, embedder?.dims ?? 0) : { task: 0, note: 0, automation: 0 },
      items_today: items ? itemUsageToday(s.db, UsageService.day()).requests : 0,
      items_cap: config?.maxItemEmbeddingsPerDay ?? DEFAULT_SEMANTIC_CONFIG.maxItemEmbeddingsPerDay,
      indexing: enabled && itemPassRunning(s.db),
    },
  });
});

/** Drops every `tal_sem%` table and the config key; memories are untouched. */
semanticRoutes.delete("/semantic/data", async (c) => {
  await body(c, z.object({ confirm: z.literal("DELETE") }));
  const s = c.env.agent.services;
  dropSemanticData(s.db);
  dropVectorCache(s.db);
  deleteSemanticConfig(s.settings);
  invalidateSemanticCache(s);
  return c.json({ deleted: true });
});

const SEARCH_TYPES = ["memory", "task", "note", "automation"] as const;
type SearchType = (typeof SEARCH_TYPES)[number];

const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).default(10).transform((n) => Math.min(n, 50)),
  types: z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined) return undefined;
      const types = new Set<SearchType>();
      for (const part of raw.split(",").map((t) => t.trim()).filter(Boolean)) {
        if (!(SEARCH_TYPES as readonly string[]).includes(part)) {
          ctx.addIssue({ code: "custom", message: `Unknown type "${part}"; use ${SEARCH_TYPES.join(", ")}.` });
          return z.NEVER;
        }
        types.add(part as SearchType);
      }
      if (types.size === 0) {
        ctx.addIssue({ code: "custom", message: `No type given; use ${SEARCH_TYPES.join(", ")}.` });
        return z.NEVER;
      }
      return types;
    }),
});

/** One task, note or automation hit on the debug route. */
interface ItemSearchHit {
  type: ItemType;
  id: string;
  title: string;
  cosine: number | null;
  fused: number;
  match: "keyword" | "meaning" | "both";
}

/**
 * Raw retrieval for one item type: vector hits above the floors fused by RRF with the upstream
 * keyword list. No status filter applies, but items deleted since their vector was stored are skipped.
 */
function itemSearchHits(
  sem: SemanticContext,
  type: ItemType,
  vector: Float32Array | null,
  q: string,
  limit: number,
): ItemSearchHit[] {
  const s = sem.services;
  const keyword =
    type === "task"
      ? s.tasks.list({ q, limit }).map((t) => t.id)
      : type === "note"
        ? s.notes.search(q, limit).map((n) => n.id)
        : automationKeywordHits(sem, q).map((a) => a.id);
  const cosines = new Map((vector ? scanItemVectors(sem, type, vector) : []).map((h) => [h.id, h.cosine]));
  const keywordIds = new Set(keyword);
  const fused = rrf([[...cosines.keys()], keyword]);
  const title = (id: string): string | null =>
    type === "task" ? (s.tasks.get(id)?.title ?? null) : type === "note" ? (s.notes.get(id)?.title ?? null) : (s.automations.get(id)?.name ?? null);
  const out: ItemSearchHit[] = [];
  for (const [id, score] of [...fused].sort((a, b) => b[1] - a[1] || (cosines.get(b[0]) ?? -1) - (cosines.get(a[0]) ?? -1))) {
    if (out.length >= limit) break;
    const name = title(id);
    if (name === null) continue;
    const cosine = cosines.get(id) ?? null;
    out.push({ type, id, title: name, cosine, fused: score, match: cosine === null ? "keyword" : keywordIds.has(id) ? "both" : "meaning" });
  }
  return out;
}

/**
 * Hybrid hits for a query. Embedding failures and the cap degrade to keyword-only hits. With
 * `types`, hits for each listed type follow, tagged with `type`; without it the response is memory hits only.
 */
semanticRoutes.get("/semantic/search", async (c) => {
  const config = requireEnabled(c);
  const { q, limit, types } = query(c, searchQuerySchema);
  const s = c.env.agent.services;
  const timezone = s.settings.get().timezone;
  const sem = createSemanticContext(s, c.env.env, config);
  const memoryHits =
    types && !types.has("memory")
      ? []
      : (await hybridSearch(sem, q, { limit })).map(({ memory: m, cosine, fused }) => ({
          ...(types ? { type: "memory" as const } : {}),
          id: m.id,
          content: m.content,
          category: m.category,
          cosine,
          fused,
          saved: savedAt(m.updated_at, timezone),
        }));
  if (!types) return c.json({ hits: memoryHits });
  const itemTypes = ITEM_TYPES.filter((t) => types.has(t));
  const vector = itemTypes.length ? await prepareSurfaceSearch(sem, q) : null;
  return c.json({ hits: [...memoryHits, ...itemTypes.flatMap((t) => itemSearchHits(sem, t, vector, q, limit))] });
});

/**
 * Drops every memory and item vector and re-embeds in batches until done, capped, or a pass
 * embeds nothing: memories first, then tasks, notes and automations against the item cap.
 */
semanticRoutes.post("/semantic/reindex", async (c) => {
  const config = requireEnabled(c);
  const s = c.env.agent.services;
  const ctx = createSemanticContext(s, c.env.env, config);
  deleteAllVectors(s.db);
  deleteAllItemVectors(s.db);
  // Every pass awaited here starts after the delete: a call during a running pass gets its follow-up.
  let embedded = 0;
  let report: IndexReport;
  do {
    report = await runIndexer(ctx, { maxEmbed: LAZY_INDEX_BATCH });
    embedded += report.embedded;
  } while (report.pending > 0 && !report.capped && report.embedded > 0);
  const pending = (await pendingMemories(s.db, ctx.embedder?.model ?? config.model, ctx.embedder?.dims)).length;
  let itemsEmbedded = 0;
  let items: ItemPassReport;
  let full = true;
  do {
    items = await runItemPass(ctx, { maxEmbed: LAZY_INDEX_BATCH, full });
    itemsEmbedded += items.embedded;
    full = false;
  } while (items.pending > 0 && !items.capped && !items.error && items.embedded > 0);
  const itemsPending = (await pendingItems(s.db, ctx.embedder?.model ?? config.model, ctx.embedder?.dims)).pending.length;
  return c.json({
    embedded,
    pending,
    capped: report.capped ?? false,
    surfaces: { embedded: itemsEmbedded, pending: itemsPending },
    ...(report.error ? { error: report.error } : report.skipped ? { error: report.skipped } : {}),
  });
});
