import { type Database, now } from "../db/database";
import { estimateTokens } from "../ai/provider";
import { UsageService } from "../services/usage";
import type { SemanticConfig } from "./config";
import { type Embedder, contentHash, embeddingText, reserveEmbedding } from "./embeddings";
import { ensureSemanticSchema } from "./migrations";
import { deleteAllVectors, deleteVector, purgeOrphanVectors, upsertVectors, vectorMeta } from "./vectorStore";

/** Most memories embedded in one indexer run, and so in one embed call. */
export const DEFAULT_MAX_EMBED = 50;

export interface IndexerContext {
  db: Database;
  config: SemanticConfig;
  embedder: Embedder | null;
}

export interface IndexReport {
  embedded: number;
  /** Memories still waiting for a current vector after this run. */
  pending: number;
  purged: number;
  capped?: true;
  skipped?: "disabled" | "no-embedder";
  error?: string;
}

export interface PendingMemory {
  id: string;
  text: string;
  hash: string;
}

/**
 * Memories without a current vector for `model`: no row, a row from another model or (when
 * `dims` is known) another size, or one whose content hash no longer matches. Oldest update
 * first. Needs the schema.
 */
export async function pendingMemories(db: Database, model: string, dims = 0): Promise<PendingMemory[]> {
  const meta = vectorMeta(db);
  const rows = db.all<{ id: string; content: string; category: string }>(
    `SELECT id, content, category FROM tal_memories ORDER BY updated_at ASC, id ASC`,
  );
  const pending: PendingMemory[] = [];
  for (const row of rows) {
    const text = embeddingText(row);
    const hash = await contentHash(text);
    const v = meta.get(row.id);
    if (v?.model !== model || (dims > 0 && v.dims !== dims) || v.content_hash !== hash) pending.push({ id: row.id, text, hash });
  }
  return pending;
}

/** Deletes vectors whose memory no longer exists. */
export function purgeOrphans(db: Database): number {
  return purgeOrphanVectors(db);
}

/** Deletes the vector for one forgotten memory. Runs even while the feature is off: forgetting is real. */
export function purgeVector(db: Database, memoryId: string): void {
  deleteVector(db, memoryId);
}

/** Deletes every vector, after the owner clears all memories. */
export function purgeAllVectors(db: Database): void {
  deleteAllVectors(db);
}

/** A pass queued behind the running one; it takes the latest caller's context and the largest batch. */
interface FollowUp {
  ctx: IndexerContext;
  maxEmbed: number;
  promise: Promise<IndexReport>;
}

interface IndexerState {
  running: Promise<IndexReport>;
  next?: FollowUp;
}

/** The running pass per database and at most one follow-up, so no memory is embedded twice. */
const passes = new WeakMap<Database, IndexerState>();

/**
 * Brings the vector store in line with `tal_memories`: purges orphans, then embeds
 * up to `maxEmbed` pending memories in one call, counted against `maxEmbeddingsPerDay`.
 * A call during a running pass gets one follow-up pass that starts once it settles, so a
 * memory saved mid-pass is still embedded; later callers share that follow-up.
 * Never rejects; embed failures leave the memories pending and are reported in `error`.
 */
export function runIndexer(ctx: IndexerContext, opts: { maxEmbed?: number } = {}): Promise<IndexReport> {
  const maxEmbed = opts.maxEmbed ?? DEFAULT_MAX_EMBED;
  const state = passes.get(ctx.db);
  if (!state) return startPass(ctx, maxEmbed);
  if (state.next) {
    state.next.ctx = ctx;
    state.next.maxEmbed = Math.max(state.next.maxEmbed, maxEmbed);
  } else {
    const next = { ctx, maxEmbed } as FollowUp;
    next.promise = state.running.then(() => startPass(next.ctx, next.maxEmbed));
    state.next = next;
  }
  return state.next.promise;
}

function startPass(ctx: IndexerContext, maxEmbed: number): Promise<IndexReport> {
  const state: IndexerState = { running: indexOnce(ctx, maxEmbed) };
  passes.set(ctx.db, state);
  // Runs before a queued follow-up's own reaction, which then replaces this state.
  void state.running.then(() => {
    if (passes.get(ctx.db) === state && !state.next) passes.delete(ctx.db);
  });
  return state.running;
}

async function indexOnce({ db, config, embedder }: IndexerContext, maxEmbed: number): Promise<IndexReport> {
  const report: IndexReport = { embedded: 0, pending: 0, purged: 0 };
  try {
    if (!config.enabled) return { ...report, skipped: "disabled" };
    ensureSemanticSchema(db);
    report.purged = purgeOrphans(db);
    const pending = await pendingMemories(db, embedder?.model ?? config.model, embedder?.dims);
    report.pending = pending.length;
    if (!embedder) return { ...report, skipped: "no-embedder" };
    if (pending.length === 0) return report;
    const batch = pending.slice(0, Math.max(0, maxEmbed));
    if (batch.length === 0) return report;
    const texts = batch.map((p) => p.text);
    // Reserved before the call (which counts even if it fails), so a concurrent query embedding cannot overrun the cap.
    if (!reserveEmbedding(db, UsageService.day(), config.maxEmbeddingsPerDay, texts.reduce((n, t) => n + estimateTokens(t), 0))) {
      return { ...report, capped: true };
    }
    const vectors = await embedder.embed(texts);
    if (vectors.length !== batch.length || vectors.some((v) => v.length !== embedder.dims)) {
      throw new Error(`Embedder returned ${vectors.length} vectors for ${batch.length} texts`);
    }
    const ts = now();
    upsertVectors(
      db,
      vectors.map((vector, i) => ({
        memoryId: batch[i]!.id,
        model: embedder.model,
        dims: embedder.dims,
        contentHash: batch[i]!.hash,
        vector,
        updatedAt: ts,
      })),
    );
    report.embedded = vectors.length;
    report.pending -= vectors.length;
    return report;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("Semantic indexer failed", message);
    return { ...report, error: message };
  }
}

/**
 * Starts an indexer run without awaiting it, so a memory write returns before embedding.
 * The pass is handed to `waitUntil` when the runtime offers one; failures only log.
 */
export function startBackgroundIndex(ctx: IndexerContext, waitUntil?: (promise: Promise<unknown>) => void): Promise<void> {
  const pass = runIndexer(ctx).then(
    () => undefined,
    (error) => console.warn("Semantic background index failed", error instanceof Error ? error.message : String(error)),
  );
  waitUntil?.(pass);
  return pass;
}

/**
 * Like `startBackgroundIndex`, but keeps indexing in batches until nothing is pending,
 * the daily cap is hit, a pass embeds nothing, or a pass fails. Used after a model change.
 */
export function startBackgroundBackfill(ctx: IndexerContext, waitUntil?: (promise: Promise<unknown>) => void): Promise<void> {
  const pass = (async () => {
    let report: IndexReport;
    do report = await runIndexer(ctx, { maxEmbed: DEFAULT_MAX_EMBED });
    while (report.pending > 0 && report.embedded > 0 && !report.capped && !report.error);
  })().catch((error) => console.warn("Semantic background backfill failed", error instanceof Error ? error.message : String(error)));
  waitUntil?.(pass);
  return pass;
}
