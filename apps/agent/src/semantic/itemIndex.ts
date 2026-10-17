import type { Usage } from "../ai/provider";
import { type Database, now } from "../db/database";
import { UsageService } from "../services/usage";
import { ITEM_EMBEDDINGS_PER_DAY, type SemanticConfig } from "./config";
import { conservativeEmbeddingTokens, contentHash } from "./embeddings";
import { DEFAULT_MAX_EMBED, type IndexerContext } from "./indexer";
import {
  type ItemPartMeta,
  type ItemType,
  deleteItemParts,
  itemVectorMeta,
  purgeOrphanItemVectors,
  touchItemSource,
  upsertItemVectors,
} from "./itemStore";
import { automationText, itemSourceStamp, noteParts, taskText } from "./itemText";
import { ensureSemanticSchema, tableExists } from "./migrations";

/** Default item embedding requests per UTC day, counted apart from the shared memory cap. */
export { ITEM_EMBEDDINGS_PER_DAY };
/** Estimated item tokens embedded per UTC day (about 537.5 bge-m3 neurons). */
export const ITEM_TOKENS_PER_DAY = 500_000;

export interface ItemCaps {
  requests: number;
  tokens: number;
}

export const ITEM_CAPS: ItemCaps = { requests: ITEM_EMBEDDINGS_PER_DAY, tokens: ITEM_TOKENS_PER_DAY };

/** The item caps for `config`: its saved daily request cap and the fixed token cap. */
export function itemCaps(config: Pick<SemanticConfig, "maxItemEmbeddingsPerDay">): ItemCaps {
  return { requests: config.maxItemEmbeddingsPerDay ?? ITEM_EMBEDDINGS_PER_DAY, tokens: ITEM_TOKENS_PER_DAY };
}

/** Item embedding requests and estimated tokens recorded in `tal_semantic_item_usage` for a UTC day. */
export function itemUsageToday(db: Database, day: string): { requests: number; tokens: number } {
  if (!tableExists(db, "tal_semantic_item_usage")) return { requests: 0, tokens: 0 };
  const row = db.one<{ requests: number; tokens: number }>(`SELECT requests, tokens FROM tal_semantic_item_usage WHERE day = ?`, day);
  return { requests: row?.requests ?? 0, tokens: row?.tokens ?? 0 };
}

/**
 * Reserves one item embedding request for the longest leading run of `textTokens` that fits the
 * day's token cap and returns its length; 0 means capped until the next UTC day. Check and record
 * happen in one synchronous step, so concurrent passes cannot overrun. Never touches the shared
 * `tal_semantic_usage` counter that memory recall draws on.
 */
export function reserveItemEmbedding(db: Database, day: string, textTokens: number[], caps: ItemCaps = ITEM_CAPS): number {
  if (textTokens.length === 0 || !tableExists(db, "tal_semantic_item_usage")) return 0;
  const used = itemUsageToday(db, day);
  if (used.requests >= caps.requests) return 0;
  let n = 0;
  let total = used.tokens;
  while (n < textTokens.length && total + Math.round(textTokens[n]!) <= caps.tokens) total += Math.round(textTokens[n++]!);
  if (n === 0) return 0;
  db.run(
    `INSERT INTO tal_semantic_item_usage (day, requests, tokens) VALUES (?, 1, ?)
     ON CONFLICT(day) DO UPDATE SET requests = requests + 1, tokens = tokens + excluded.tokens`,
    day,
    total - used.tokens,
  );
  return n;
}

/**
 * Moves a day's reserved item tokens by `delta`, once a call reports what it really embedded;
 * the counter never drops below 0. Each caller corrects only its own reservation.
 */
export function adjustItemTokens(db: Database, day: string, delta: number): void {
  if (!delta || !tableExists(db, "tal_semantic_item_usage")) return;
  db.run(`UPDATE tal_semantic_item_usage SET tokens = MAX(0, tokens + ?) WHERE day = ?`, Math.round(delta), day);
}

/**
 * Corrects a successful item call's reservation to its reported input token count; an
 * estimate-only usage (or none) keeps the reservation.
 */
export function correctItemTokens(db: Database, day: string, reserved: number, usage: Usage | undefined): void {
  if (usage && usage.inputTokens.estimated === 0) adjustItemTokens(db, day, usage.inputTokens.reported - reserved);
}

export interface PendingItem {
  type: ItemType;
  id: string;
  part: number;
  text: string;
  hash: string;
  /** Stored with the vector so an unchanged row is skipped: a note's updated_at, or `itemSourceStamp` for a task or automation. */
  sourceUpdatedAt: string;
}

export interface ItemPassReport {
  embedded: number;
  /** Item parts still waiting for a current vector after this pass. */
  pending: number;
  purged: number;
  capped?: true;
  skipped?: "disabled" | "no-embedder";
  error?: string;
}

const CHANGE_CHECK_SOURCES = {
  task: { table: "tal_tasks", columns: "s.id, s.title, s.description, s.updated_at" },
  automation: { table: "tal_automations", columns: "s.id, s.name, s.message, s.updated_at" },
  note: { table: "tal_notes", columns: "s.id, s.title, s.content, s.updated_at" },
} as const;

/**
 * The change check's candidates, filtered in SQL: rows never indexed, rows with a vector from
 * another model or (when `dims` is known) another size, and rows whose `updated_at` stamp differs
 * from the one stored at their last index. A task or automation compares its part 0 against
 * `itemSourceStamp`; a note is a candidate when any of its parts is stale. Comparing for
 * inequality rather than "newer" also catches an edit that lands on an equal or earlier
 * timestamp. With `full`, or before the vector table exists, every row.
 */
export function changedItemRows<T>(db: Database, type: ItemType, model: string, dims = 0, full = false): T[] {
  const { table, columns } = CHANGE_CHECK_SOURCES[type];
  if (full || !tableExists(db, "tal_semantic_item_vectors")) return db.all<T>(`SELECT ${columns} FROM ${table} s`);
  const knownDims = dims > 0 ? 1 : 0;
  if (type === "note") {
    return db.all<T>(
      `SELECT ${columns} FROM ${table} s
       WHERE NOT EXISTS (SELECT 1 FROM tal_semantic_item_vectors v WHERE v.item_type = 'note' AND v.item_id = s.id)
          OR EXISTS (SELECT 1 FROM tal_semantic_item_vectors v WHERE v.item_type = 'note' AND v.item_id = s.id
                     AND (v.model <> ? OR (? = 1 AND v.dims <> ?) OR v.source_updated_at <> s.updated_at))`,
      model,
      knownDims,
      dims,
    );
  }
  return db.all<T>(
    `SELECT ${columns} FROM ${table} s
     LEFT JOIN tal_semantic_item_vectors v ON v.item_type = ? AND v.item_id = s.id AND v.part = 0
     WHERE v.item_id IS NULL OR v.model <> ? OR (? = 1 AND v.dims <> ?) OR v.source_updated_at <> ? || s.updated_at`,
    type,
    model,
    knownDims,
    dims,
    itemSourceStamp(type, ""),
  );
}

/** Pending parts are embedded tasks first, then automations, note titles and note bodies. */
const GROUP_ORDER = { task: 0, automation: 1, noteTitle: 2, noteBody: 3 } as const;

/**
 * Item parts without a current vector for `model`, among the rows `changedItemRows` selects: no row, a row from another model or (when
 * `dims` is known) another size, or one whose content hash no longer matches. A task or
 * automation is hashed only when its stored stamp differs from `itemSourceStamp` (or `full` is
 * set); a match records the new stamp. A note is re-chunked only when its updated_at differs from
 * the stored one (or `full` is set). Re-chunking deletes the parts past the note's new length and,
 * when nothing changed, records the new updated_at; `touched` counts those items and `hashed` the
 * texts hashed. With `readOnly` nothing is written: the same parts are reported, `touched` still
 * counts what a writing check would record, and a shrunk note keeps its extra parts until the next
 * pass. Needs the schema.
 */
export async function pendingItems(
  db: Database,
  model: string,
  dims = 0,
  opts: { full?: boolean; readOnly?: boolean } = {},
): Promise<{ pending: PendingItem[]; touched: number; hashed: number }> {
  const current = (m: ItemPartMeta) => m.model === model && (dims <= 0 || m.dims === dims);
  const ranked: (PendingItem & { group: number })[] = [];
  let hashed = 0;
  let touched = 0;
  const check = async (group: number, item: Omit<PendingItem, "hash">, stored: ItemPartMeta | undefined): Promise<boolean> => {
    const hash = await contentHash(item.text);
    hashed++;
    if (stored && current(stored) && stored.content_hash === hash) return false;
    ranked.push({ ...item, hash, group });
    return true;
  };
  // A task or automation whose stamp matches its current vector is skipped before building its text.
  const checkStamped = async (type: "task" | "automation", id: string, stamp: string, stored: ItemPartMeta | undefined, text: () => string) => {
    if (!opts.full && stored && current(stored) && stored.source_updated_at === stamp) return;
    const item = { type, id, part: 0, text: text(), sourceUpdatedAt: stamp };
    if (await check(GROUP_ORDER[type], item, stored)) return;
    if (stored!.source_updated_at !== stamp) {
      if (!opts.readOnly) touchItemSource(db, type, id, stamp);
      touched++;
    }
  };

  const taskMeta = itemVectorMeta(db, "task");
  const tasks = changedItemRows<{ id: string; title: string; description: string; updated_at: string }>(db, "task", model, dims, opts.full);
  for (const t of tasks) {
    const stored = taskMeta.get(t.id)?.find((p) => p.part === 0);
    await checkStamped("task", t.id, itemSourceStamp("task", t.updated_at), stored, () => taskText(t));
  }

  const automationMeta = itemVectorMeta(db, "automation");
  const automations = changedItemRows<{ id: string; name: string; message: string; updated_at: string }>(
    db,
    "automation",
    model,
    dims,
    opts.full,
  );
  for (const a of automations) {
    const stored = automationMeta.get(a.id)?.find((p) => p.part === 0);
    await checkStamped("automation", a.id, itemSourceStamp("automation", a.updated_at), stored, () => automationText(a));
  }

  const noteMeta = itemVectorMeta(db, "note");
  const notes = changedItemRows<{ id: string; title: string; content: string; updated_at: string }>(db, "note", model, dims, opts.full);
  for (const n of notes) {
    const stored = noteMeta.get(n.id) ?? [];
    if (!opts.full && stored.length > 0 && stored.every((p) => current(p) && p.source_updated_at === n.updated_at)) continue;
    const byPart = new Map(stored.map((p) => [p.part, p]));
    const parts = noteParts(n);
    let changed = 0;
    for (const [part, { text }] of parts.entries()) {
      const item = { type: "note" as const, id: n.id, part, text, sourceUpdatedAt: n.updated_at };
      if (await check(part === 0 ? GROUP_ORDER.noteTitle : GROUP_ORDER.noteBody, item, byPart.get(part))) changed++;
    }
    if (!opts.readOnly && stored.some((p) => p.part >= parts.length)) deleteItemParts(db, "note", n.id, parts.length);
    if (changed === 0 && stored.some((p) => p.source_updated_at !== n.updated_at)) {
      if (!opts.readOnly) touchItemSource(db, "note", n.id, n.updated_at);
      touched++;
    }
  }

  ranked.sort(
    (a, b) =>
      a.group - b.group ||
      (a.sourceUpdatedAt < b.sourceUpdatedAt ? -1 : a.sourceUpdatedAt > b.sourceUpdatedAt ? 1 : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) ||
      a.part - b.part,
  );
  return { pending: ranked.map(({ group: _, ...item }) => item), touched, hashed };
}

interface ItemPassOptions {
  maxEmbed?: number;
  full?: boolean;
  caps?: ItemCaps;
}

/** A pass queued behind the running one: the latest caller's context and caps, the largest batch, full if any caller asked. */
interface ItemFollowUp {
  ctx: IndexerContext;
  maxEmbed: number;
  full: boolean;
  caps?: ItemCaps;
  promise: Promise<ItemPassReport>;
}

interface ItemPassState {
  running: Promise<ItemPassReport>;
  next?: ItemFollowUp;
}

/**
 * The running item pass per database and at most one follow-up, so no part is embedded twice.
 * Kept apart from the memory indexer's guard, so an item pass never delays a memory pass.
 */
const itemPasses = new WeakMap<Database, ItemPassState>();

/**
 * Brings the item vectors in line with tasks, notes and automations: purges orphans, then embeds
 * up to `maxEmbed` pending parts in one call, counted against the separate item cap. A call
 * during a running pass gets one follow-up pass that starts once it settles; later callers share
 * it. Never rejects; embed failures leave the parts pending and are reported in `error`.
 */
export function runItemPass(ctx: IndexerContext, opts: ItemPassOptions = {}): Promise<ItemPassReport> {
  const maxEmbed = opts.maxEmbed ?? DEFAULT_MAX_EMBED;
  const full = opts.full ?? false;
  const state = itemPasses.get(ctx.db);
  if (!state) return startItemPass(ctx, maxEmbed, full, opts.caps);
  if (state.next) {
    state.next.ctx = ctx;
    state.next.maxEmbed = Math.max(state.next.maxEmbed, maxEmbed);
    state.next.full ||= full;
    state.next.caps = opts.caps;
  } else {
    const next = { ctx, maxEmbed, full, caps: opts.caps } as ItemFollowUp;
    next.promise = state.running.then(() => startItemPass(next.ctx, next.maxEmbed, next.full, next.caps));
    state.next = next;
  }
  return state.next.promise;
}

function startItemPass(ctx: IndexerContext, maxEmbed: number, full: boolean, caps?: ItemCaps): Promise<ItemPassReport> {
  const state: ItemPassState = { running: itemPassOnce(ctx, maxEmbed, full, caps) };
  itemPasses.set(ctx.db, state);
  // Runs before a queued follow-up's own reaction, which then replaces this state.
  void state.running.then(() => {
    if (itemPasses.get(ctx.db) === state && !state.next) itemPasses.delete(ctx.db);
  });
  return state.running;
}

async function itemPassOnce({ db, config, embedder }: IndexerContext, maxEmbed: number, full: boolean, caps?: ItemCaps): Promise<ItemPassReport> {
  const report: ItemPassReport = { embedded: 0, pending: 0, purged: 0 };
  try {
    if (!config.enabled) return { ...report, skipped: "disabled" };
    ensureSemanticSchema(db);
    report.purged = purgeOrphanItemVectors(db);
    const { pending } = await pendingItems(db, embedder?.model ?? config.model, embedder?.dims, { full });
    report.pending = pending.length;
    if (!embedder) return { ...report, skipped: "no-embedder" };
    if (pending.length === 0) return report;
    const candidates = pending.slice(0, Math.max(0, maxEmbed));
    if (candidates.length === 0) return report;
    // Reserved before the call (which counts even if it fails), so concurrent passes cannot overrun the item cap.
    const day = UsageService.day();
    const textTokens = candidates.map((p) => conservativeEmbeddingTokens(p.text));
    const n = reserveItemEmbedding(db, day, textTokens, caps ?? itemCaps(config));
    if (n === 0) return { ...report, capped: true };
    const batch = candidates.slice(0, n);
    let usage: Usage | undefined;
    const vectors = await embedder.embed(batch.map((p) => p.text), (reported) => (usage = reported));
    if (vectors.length !== batch.length || vectors.some((v) => v.length !== embedder.dims)) {
      throw new Error(`Embedder returned ${vectors.length} vectors for ${batch.length} texts`);
    }
    correctItemTokens(db, day, textTokens.slice(0, n).reduce((sum, t) => sum + Math.round(t), 0), usage);
    // A note with parts left for a later pass keeps an empty source_updated_at, so that pass re-chunks it.
    const unfinished = new Set(pending.slice(n).filter((p) => p.type === "note").map((p) => p.id));
    const ts = now();
    upsertItemVectors(
      db,
      vectors.map((vector, i) => {
        const p = batch[i]!;
        const sourceUpdatedAt = p.type === "note" && unfinished.has(p.id) ? "" : p.sourceUpdatedAt;
        return { itemType: p.type, itemId: p.id, part: p.part, model: embedder.model, dims: embedder.dims, contentHash: p.hash, sourceUpdatedAt, vector, updatedAt: ts };
      }),
    );
    // Unchanged parts of a finished note still carry its previous updated_at.
    for (const p of batch) if (p.type === "note" && !unfinished.has(p.id)) touchItemSource(db, "note", p.id, p.sourceUpdatedAt);
    report.embedded = vectors.length;
    report.pending -= vectors.length;
    if (n < candidates.length) report.capped = true;
    return report;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("Semantic item pass failed", message);
    return { ...report, error: message };
  }
}

/**
 * Starts an item pass without awaiting it, so a write returns before embedding.
 * The pass is handed to `waitUntil` when the runtime offers one; failures only log.
 */
export function startBackgroundItemPass(
  ctx: IndexerContext,
  waitUntil?: (promise: Promise<unknown>) => void,
  opts: ItemPassOptions = {},
): Promise<void> {
  const pass = runItemPass(ctx, opts).then(
    () => undefined,
    (error) => console.warn("Semantic background item pass failed", error instanceof Error ? error.message : String(error)),
  );
  waitUntil?.(pass);
  return pass;
}

/**
 * Like `startBackgroundItemPass`, but keeps passing in batches until nothing is pending, the item
 * cap is hit, a pass embeds nothing, or a pass fails. Used after enabling, import or a model change.
 */
export function startBackgroundItemBackfill(ctx: IndexerContext, waitUntil?: (promise: Promise<unknown>) => void): Promise<void> {
  const pass = (async () => {
    let report: ItemPassReport;
    do report = await runItemPass(ctx, { maxEmbed: DEFAULT_MAX_EMBED });
    while (report.pending > 0 && report.embedded > 0 && !report.capped && !report.error);
  })().catch((error) => console.warn("Semantic background item backfill failed", error instanceof Error ? error.message : String(error)));
  waitUntil?.(pass);
  return pass;
}

/** Whether an item pass is running for this database. */
export function itemPassRunning(db: Database): boolean {
  return itemPasses.has(db);
}
