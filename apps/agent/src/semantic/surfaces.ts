import { type Automation, type AutomationKind, type ScheduleSpec, type Task, describeSchedule } from "@talorys/shared";
import { type Database, ftsQuery, now } from "../db/database";
import { estimateTokens } from "../ai/provider";
import { UsageService } from "../services/usage";
import { contentHash } from "./embeddings";
import { DEFAULT_MAX_EMBED, type IndexerContext } from "./indexer";
import {
  type ItemPartMeta,
  type ItemType,
  cachedItemVectors,
  deleteItemParts,
  itemVectorMeta,
  purgeOrphanItemVectors,
  touchItemSource,
  upsertItemVectors,
} from "./itemStore";
import { ensureSemanticSchema, tableExists } from "./migrations";
import { CANDIDATES_PER_LIST, type SemanticContext, queryVector, rrf } from "./recall";
import { dot, normalize } from "./vectorStore";

/** Notes longer than this many characters are embedded in chunks instead of one body row. */
export const NOTE_SPLIT_CHARS = 4000;
/** Largest chunk of a long note's body. */
export const NOTE_CHUNK_CHARS = 1200;
/** Chunks embedded per note; text past the last one is left to full-text search. */
export const NOTE_MAX_CHUNKS = 40;

export const AUTOMATION_KIND_LABELS: Record<AutomationKind, string> = {
  reminder: "Reminder",
  task_digest: "Task digest",
  agent_prompt: "Scheduled AI prompt",
};

// These text shapes are hashed and stored as content_hash, so changing one re-embeds every item.

/** The text embedded for a task. Status, priority and due date are left out so they never trigger a re-embed. */
export function taskText(t: { title: string; description: string | null }): string {
  const description = t.description ?? "";
  return description.trim() ? `Task: ${t.title}\n${description.slice(0, 1000)}` : `Task: ${t.title}`;
}

/** The text embedded for an automation. Run state is left out so runs never trigger a re-embed. */
export function automationText(a: { kind: AutomationKind; name: string; message: string; schedule_description: string }): string {
  let text = `${AUTOMATION_KIND_LABELS[a.kind]}: ${a.name}`;
  const message = a.message.trim();
  if (message && message !== a.name.trim()) text += `\n${a.message.slice(0, 1000)}`;
  return `${text}\nSchedule: ${a.schedule_description}`;
}

/** Greedily joins pieces with `sep` into chunks of at most NOTE_CHUNK_CHARS. */
function pack(pieces: string[], sep: string, out: string[]): void {
  let current = "";
  for (const piece of pieces) {
    if (!current) current = piece;
    else if (current.length + sep.length + piece.length <= NOTE_CHUNK_CHARS) current += sep + piece;
    else {
      out.push(current);
      current = piece;
    }
  }
  if (current) out.push(current);
}

/** Splits text that has no usable break every NOTE_CHUNK_CHARS characters. */
function hardSplit(text: string): string[] {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += NOTE_CHUNK_CHARS) parts.push(text.slice(i, i + NOTE_CHUNK_CHARS));
  return parts;
}

/**
 * Splits a long note body into chunks of at most NOTE_CHUNK_CHARS: whole paragraphs where they
 * fit, then sentences, then fixed-width pieces. No overlap; at most NOTE_MAX_CHUNKS chunks.
 */
export function chunkNote(content: string): string[] {
  const chunks: string[] = [];
  let paragraphs: string[] = [];
  const flush = () => {
    pack(paragraphs, "\n\n", chunks);
    paragraphs = [];
  };
  for (const raw of content.split(/\n\s*\n/)) {
    const paragraph = raw.trim();
    if (!paragraph) continue;
    if (paragraph.length <= NOTE_CHUNK_CHARS) {
      paragraphs.push(paragraph);
      continue;
    }
    flush();
    const sentences = paragraph.split(/(?<=[.!?])\s+/).flatMap((s) => (s.length > NOTE_CHUNK_CHARS ? hardSplit(s) : [s]));
    pack(sentences, " ", chunks);
  }
  flush();
  return chunks.slice(0, NOTE_MAX_CHUNKS);
}

/**
 * The parts embedded for a note. Part 0 is the title row; the rest carry the body, whole for a
 * note up to NOTE_SPLIT_CHARS and chunked beyond it. The array index is the stored part number.
 */
export function noteParts(n: { title: string; content: string }): { text: string; body: string | null }[] {
  const parts: { text: string; body: string | null }[] = [{ text: `Note: ${n.title}`, body: null }];
  if (!n.content.trim()) return parts;
  const bodies = n.content.length <= NOTE_SPLIT_CHARS ? [n.content] : chunkNote(n.content);
  for (const body of bodies) parts.push({ text: `${n.title}: ${body}`, body });
  return parts;
}

/** Item embedding requests per UTC day, counted apart from the shared memory cap. */
export const ITEM_EMBEDDINGS_PER_DAY = 50;
/** Estimated item tokens embedded per UTC day (about 537.5 bge-m3 neurons). */
export const ITEM_TOKENS_PER_DAY = 500_000;

export interface ItemCaps {
  requests: number;
  tokens: number;
}

export const ITEM_CAPS: ItemCaps = { requests: ITEM_EMBEDDINGS_PER_DAY, tokens: ITEM_TOKENS_PER_DAY };

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

export interface PendingItem {
  type: ItemType;
  id: string;
  part: number;
  text: string;
  hash: string;
  /** The source row's updated_at, stored with the vector so an unchanged note is not re-chunked. */
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

/** Pending parts are embedded tasks first, then automations, note titles and note bodies. */
const GROUP_ORDER = { task: 0, automation: 1, noteTitle: 2, noteBody: 3 } as const;

/**
 * Item parts without a current vector for `model`: no row, a row from another model or (when
 * `dims` is known) another size, or one whose content hash no longer matches. Tasks and
 * automations are hashed every time; a note is re-chunked only when its updated_at differs from
 * the stored one (or `full` is set). Re-chunking deletes the parts past the note's new length and,
 * when nothing changed, records the new updated_at; `touched` counts those notes. Needs the schema.
 */
export async function pendingItems(
  db: Database,
  model: string,
  dims = 0,
  opts: { full?: boolean } = {},
): Promise<{ pending: PendingItem[]; touched: number }> {
  const current = (m: ItemPartMeta) => m.model === model && (dims <= 0 || m.dims === dims);
  const ranked: (PendingItem & { group: number })[] = [];
  const check = async (group: number, item: Omit<PendingItem, "hash">, stored: ItemPartMeta | undefined): Promise<boolean> => {
    const hash = await contentHash(item.text);
    if (stored && current(stored) && stored.content_hash === hash) return false;
    ranked.push({ ...item, hash, group });
    return true;
  };

  const taskMeta = itemVectorMeta(db, "task");
  const tasks = db.all<{ id: string; title: string; description: string; updated_at: string }>(
    `SELECT id, title, description, updated_at FROM tal_tasks`,
  );
  for (const t of tasks) {
    const item = { type: "task" as const, id: t.id, part: 0, text: taskText(t), sourceUpdatedAt: t.updated_at };
    await check(GROUP_ORDER.task, item, taskMeta.get(t.id)?.find((p) => p.part === 0));
  }

  // The schedule description is derived from the stored spec exactly as AutomationRepository does.
  const automationMeta = itemVectorMeta(db, "automation");
  const automations = db.all<{ id: string; kind: AutomationKind; name: string; message: string; schedule: string; updated_at: string }>(
    `SELECT id, kind, name, message, schedule, updated_at FROM tal_automations`,
  );
  for (const a of automations) {
    const text = automationText({ ...a, schedule_description: describeSchedule(JSON.parse(a.schedule) as ScheduleSpec) });
    const item = { type: "automation" as const, id: a.id, part: 0, text, sourceUpdatedAt: a.updated_at };
    await check(GROUP_ORDER.automation, item, automationMeta.get(a.id)?.find((p) => p.part === 0));
  }

  let touched = 0;
  const noteMeta = itemVectorMeta(db, "note");
  const notes = db.all<{ id: string; title: string; content: string; updated_at: string }>(`SELECT id, title, content, updated_at FROM tal_notes`);
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
    if (stored.some((p) => p.part >= parts.length)) deleteItemParts(db, "note", n.id, parts.length);
    if (changed === 0 && stored.some((p) => p.source_updated_at !== n.updated_at)) {
      touchItemSource(db, "note", n.id, n.updated_at);
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
  return { pending: ranked.map(({ group: _, ...item }) => item), touched };
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
    if (config.maxEmbeddingsPerDay === 0) return { ...report, capped: true };
    const candidates = pending.slice(0, Math.max(0, maxEmbed));
    if (candidates.length === 0) return report;
    // Reserved before the call (which counts even if it fails), so concurrent passes cannot overrun the item cap.
    const n = reserveItemEmbedding(db, UsageService.day(), candidates.map((p) => estimateTokens(p.text)), caps);
    if (n === 0) return { ...report, capped: true };
    const batch = candidates.slice(0, n);
    const vectors = await embedder.embed(batch.map((p) => p.text));
    if (vectors.length !== batch.length || vectors.some((v) => v.length !== embedder.dims)) {
      throw new Error(`Embedder returned ${vectors.length} vectors for ${batch.length} texts`);
    }
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

/** Items found by meaning that a surface adds after its keyword hits. */
export const MAX_SEMANTIC_ADDITIONS = 3;
/** Below-floor hits a surface keeps when nothing clears the floors: none, unlike memory recall. */
export const FALLBACK_K_SURFACE = 0;

/** One item's best-scoring part for a query. */
export interface ItemHit {
  id: string;
  cosine: number;
  part: number;
}

const ITEM_TABLES: Record<ItemType, string> = { task: "tal_tasks", note: "tal_notes", automation: "tal_automations" };

const compareAsc = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Scores every cached part of one surface against the query and keeps each item's best part.
 * Items at or above the absolute floor and within `relative` of the surface's best item are
 * kept, best first (ties to the newer update, then the lower id); nothing below the floor is
 * ever kept, and the backstop is ignored. Rows whose item is gone (pending purge) are skipped.
 */
export function scanItemVectors(sem: SemanticContext, type: ItemType, vector: Float32Array): ItemHit[] {
  const { absolute, relative } = sem.config.vectorFloor;
  const model = sem.embedder?.model ?? sem.config.model;
  const unit = normalize(vector);
  const updated = new Map(
    sem.db.all<{ id: string; updated_at: string }>(`SELECT id, updated_at FROM ${ITEM_TABLES[type]}`).map((r) => [r.id, r.updated_at]),
  );
  const best: (ItemHit & { updated: string })[] = [];
  for (const [id, parts] of cachedItemVectors(sem.db, type, model, vector.length)) {
    const updatedAt = updated.get(id);
    if (updatedAt === undefined) continue;
    let hit: ItemHit | null = null;
    for (const { part, vector: v } of parts) {
      const cosine = dot(unit, v);
      if (!hit || cosine > hit.cosine) hit = { id, cosine, part };
    }
    if (hit) best.push({ ...hit, updated: updatedAt });
  }
  best.sort((a, b) => b.cosine - a.cosine || compareAsc(b.updated, a.updated) || compareAsc(a.id, b.id));
  const top = best[0];
  const kept = top && top.cosine >= absolute ? best.filter((h) => h.cosine >= absolute && h.cosine >= top.cosine - relative) : [];
  return kept.slice(0, CANDIDATES_PER_LIST).map(({ id, cosine, part }) => ({ id, cosine, part }));
}

/**
 * Brings the item vectors up to date with one capped pass, then returns the query's vector for
 * this turn (null without an embedder, at the cap, or on an AI error). Never throws.
 */
export async function prepareSurfaceSearch(sem: SemanticContext, query: string): Promise<Float32Array | null> {
  try {
    await runItemPass(sem, { maxEmbed: DEFAULT_MAX_EMBED });
  } catch (error) {
    console.warn("Semantic item pass before search failed", error instanceof Error ? error.message : String(error));
  }
  return queryVector(sem, query);
}

/**
 * Walks the vector hits fused by RRF with the keyword ids and returns up to
 * MAX_SEMANTIC_ADDITIONS live rows the keyword list missed. `live` loads the current row
 * and returns null for a missing or filtered one, so a filtered item never takes a slot.
 */
function additions<T>(hits: ItemHit[], keywordIds: string[], live: (id: string) => T | null): { row: T; hit: ItemHit }[] {
  const fused = rrf([hits.map((h) => h.id), keywordIds]);
  const keyword = new Set(keywordIds);
  // Hits come ordered by cosine, newer update, then id, which ties in the fused order keep.
  const order = hits.filter((h) => !keyword.has(h.id)).sort((a, b) => fused.get(b.id)! - fused.get(a.id)!);
  const out: { row: T; hit: ItemHit }[] = [];
  for (const hit of order) {
    if (out.length >= MAX_SEMANTIC_ADDITIONS) break;
    const row = live(hit.id);
    if (row) out.push({ row, hit });
  }
  return out;
}

/**
 * Tasks found by meaning beyond `keywordIds`. Done tasks are left out, except in the completed
 * view, which allows only done tasks; `allowedIds` restricts the result to the listed view.
 */
export function taskAdditions(
  sem: SemanticContext,
  vector: Float32Array | null,
  opts: { keywordIds: string[]; allowedIds?: ReadonlySet<string>; completedView?: boolean },
): Task[] {
  if (!vector) return [];
  const hits = scanItemVectors(sem, "task", vector);
  return additions(hits, opts.keywordIds, (id) => {
    if (opts.allowedIds && !opts.allowedIds.has(id)) return null;
    const task = sem.services.tasks.get(id);
    if (!task || (task.status === "done") !== (opts.completedView ?? false)) return null;
    return task;
  }).map(({ row }) => row);
}

/**
 * Notes found by meaning beyond `keywordIds`, one entry per note. The excerpt is the best
 * matching chunk of a split note, otherwise the start of the content as upstream shows it.
 */
export function noteAdditions(
  sem: SemanticContext,
  vector: Float32Array | null,
  keywordIds: string[],
  excerptChars: number,
): { id: string; title: string; excerpt: string }[] {
  if (!vector) return [];
  const hits = scanItemVectors(sem, "note", vector);
  return additions(hits, keywordIds, (id) => sem.services.notes.get(id)).map(({ row: note, hit }) => {
    const chunk = hit.part > 0 && note.content.length > NOTE_SPLIT_CHARS ? noteParts(note)[hit.part]?.body : null;
    return { id: note.id, title: note.title, excerpt: (chunk ?? note.content).slice(0, excerptChars) };
  });
}

/**
 * Automations whose name or message contains any keyword term of the query, in the service's
 * list order. Completed automations (fired one-shot reminders) are left out.
 */
export function automationKeywordHits(sem: SemanticContext, query: string): Automation[] {
  const match = ftsQuery(query);
  if (!match) return [];
  const terms = [...match.matchAll(/"([^"]+)"\*/g)].map((m) => m[1]!);
  return sem.services.automations.list().filter((a) => {
    if (a.status === "completed") return false;
    const text = `${a.name}\n${a.message}`.toLowerCase();
    return terms.some((t) => text.includes(t));
  });
}

/** Automations found by meaning beyond `keywordIds`; completed ones are left out. */
export function automationAdditions(sem: SemanticContext, vector: Float32Array | null, keywordIds: string[]): Automation[] {
  if (!vector) return [];
  const hits = scanItemVectors(sem, "automation", vector);
  return additions(hits, keywordIds, (id) => {
    const automation = sem.services.automations.get(id);
    return automation && automation.status !== "completed" ? automation : null;
  }).map(({ row }) => row);
}
