import type { Automation, Task } from "@talorys/shared";
import { ftsTerms } from "../db/database";
import { itemPassRunning, runItemPass, startBackgroundItemBackfill } from "./itemIndex";
import { type ItemType, cachedItemVectors } from "./itemStore";
import { NOTE_SPLIT_CHARS, noteParts } from "./itemText";
import { CANDIDATES_PER_LIST, type SemanticContext, queryVector, rrf } from "./recall";
import { dot, normalize } from "./vectorStore";

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
 * Scores every cached part of one surface against the query vectors and keeps each item's best
 * part, a part scoring the highest cosine of any vector. Items at or above the absolute floor
 * and within `relative` of the surface's best item are kept, best first (ties to the newer
 * update, then the lower id); nothing below the floor is ever kept, and the backstop is ignored.
 * Rows whose item is gone (pending purge) are skipped.
 */
export function scanItemVectors(sem: SemanticContext, type: ItemType, vector: Float32Array | readonly Float32Array[]): ItemHit[] {
  const vectors = vector instanceof Float32Array ? [vector] : vector;
  const dims = vectors[0]?.length;
  if (dims === undefined) return [];
  const { absolute, relative } = sem.config.vectorFloor;
  const model = sem.embedder?.model ?? sem.config.model;
  const units = vectors.filter((v) => v.length === dims).map(normalize);
  const updated = new Map(
    sem.db.all<{ id: string; updated_at: string }>(`SELECT id, updated_at FROM ${ITEM_TABLES[type]}`).map((r) => [r.id, r.updated_at]),
  );
  const best: (ItemHit & { updated: string })[] = [];
  for (const [id, parts] of cachedItemVectors(sem.db, type, model, dims)) {
    const updatedAt = updated.get(id);
    if (updatedAt === undefined) continue;
    let hit: ItemHit | null = null;
    for (const { part, vector: v } of parts) {
      for (const unit of units) {
        const cosine = dot(unit, v);
        if (!hit || cosine > hit.cosine) hit = { id, cosine, part };
      }
    }
    if (hit) best.push({ ...hit, updated: updatedAt });
  }
  best.sort((a, b) => b.cosine - a.cosine || compareAsc(b.updated, a.updated) || compareAsc(a.id, b.id));
  const top = best[0];
  const kept = top && top.cosine >= absolute ? best.filter((h) => h.cosine >= absolute && h.cosine >= top.cosine - relative) : [];
  return kept.slice(0, CANDIDATES_PER_LIST).map(({ id, cosine, part }) => ({ id, cosine, part }));
}

/** Item parts a search embeds before it returns; the rest are left to a background backfill. */
export const SEARCH_REEMBED_MAX = 8;

/**
 * Embeds at most SEARCH_REEMBED_MAX pending item parts, hands any left over to a background
 * backfill, then returns the query's vector for this turn (null without an embedder, at the item
 * cap, or on an AI error). A running item pass is never awaited: the search uses the vectors
 * already stored and the backfill picks up after it. Never throws.
 */
export async function prepareSurfaceSearch(sem: SemanticContext, query: string): Promise<Float32Array | null> {
  try {
    if (itemPassRunning(sem.db)) {
      void startBackgroundItemBackfill(sem, sem.waitUntil);
    } else {
      const report = await runItemPass(sem, { maxEmbed: SEARCH_REEMBED_MAX });
      if (report.pending > 0 && !report.capped && !report.error && !report.skipped) void startBackgroundItemBackfill(sem, sem.waitUntil);
    }
  } catch (error) {
    console.warn("Semantic item pass before search failed", error instanceof Error ? error.message : String(error));
  }
  return queryVector(sem, query, "item");
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
 * Tasks found by meaning (any of `vectors`) beyond `keywordIds`. Done tasks are left out, except in the completed
 * view, which allows only done tasks; `allowedIds` restricts the result to the listed view.
 */
export function taskAdditions(
  sem: SemanticContext,
  vectors: readonly Float32Array[],
  opts: { keywordIds: string[]; allowedIds?: ReadonlySet<string>; completedView?: boolean },
): Task[] {
  if (vectors.length === 0) return [];
  const hits = scanItemVectors(sem, "task", vectors);
  return additions(hits, opts.keywordIds, (id) => {
    if (opts.allowedIds && !opts.allowedIds.has(id)) return null;
    const task = sem.services.tasks.get(id);
    if (!task || (task.status === "done") !== (opts.completedView ?? false)) return null;
    return task;
  }).map(({ row }) => row);
}

/**
 * Notes found by meaning (any of `vectors`) beyond `keywordIds`, one entry per note. The excerpt is the best
 * matching chunk of a split note, otherwise the start of the content as upstream shows it.
 */
export function noteAdditions(
  sem: SemanticContext,
  vectors: readonly Float32Array[],
  keywordIds: string[],
  excerptChars: number,
): { id: string; title: string; excerpt: string }[] {
  if (vectors.length === 0) return [];
  const hits = scanItemVectors(sem, "note", vectors);
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
  const terms = ftsTerms(query);
  if (terms.length === 0) return [];
  return sem.services.automations.list().filter((a) => {
    if (a.status === "completed") return false;
    const text = `${a.name}\n${a.message}`.toLowerCase();
    return terms.some((t) => text.includes(t));
  });
}

/** Automations found by meaning (any of `vectors`) beyond `keywordIds`; completed ones are left out. */
export function automationAdditions(sem: SemanticContext, vectors: readonly Float32Array[], keywordIds: string[]): Automation[] {
  if (vectors.length === 0) return [];
  const hits = scanItemVectors(sem, "automation", vectors);
  return additions(hits, keywordIds, (id) => {
    const automation = sem.services.automations.get(id);
    return automation && automation.status !== "completed" ? automation : null;
  }).map(({ row }) => row);
}
