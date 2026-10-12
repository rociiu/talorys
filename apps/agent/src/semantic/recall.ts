import type { Memory } from "@talorys/shared";
import type { Env } from "../env";
import { estimateTokens } from "../ai/provider";
import type { Services } from "../services/container";
import { UsageService } from "../services/usage";
import type { SemanticConfig } from "./config";
import { MODEL_DIMS, createEmbedder, reserveEmbedding } from "./embeddings";
import { type IndexerContext, runIndexer } from "./indexer";
import { ensureSemanticSchema } from "./migrations";
import { cachedVectors, dot, normalize } from "./vectorStore";
import { hasHistoricalIntent } from "../memory/intent";

/** Mirrors the private upstream limits in `selectRelevantMemories` (agent/memory.ts). */
export const MAX_RELEVANT_MEMORIES = 8;
export const ALWAYS_INCLUDE_PREFERENCES = 4;
/** Candidates taken from each ranked list before fusion. */
export const CANDIDATES_PER_LIST = 50;
export const RRF_K = 60;
/** Most memories embedded by the lazy index pass before a recall. */
export const LAZY_INDEX_BATCH = 50;
/** Appended after two or more recalled memories so the model resolves a conflict by recency. */
export const NEWER_WINS_NOTE = "If two memories conflict, the more recently saved one is current.";
/**
 * Default stored-vector cosine at which a newer memory is pulled in beside a selected one.
 * Measured on bge-small: Bug/Tesla 0.72-0.79 and Portland/Denver 0.748 pull in; Porsche/Bug
 * 0.523, Porsche/Tesla 0.589 and vegetarian/jazz 0.684 do not.
 */
export const NEWER_DUPLICATE_COSINE = 0.7;
/**
 * Per-model overrides of NEWER_DUPLICATE_COSINE. bge-m3 compresses its cosines: Bug/Tesla
 * 0.579-0.654 and Portland/Denver 0.767 pull in; Porsche vs the car memories 0.524-0.554 do
 * not. Unrelated preference pairs reach 0.60-0.78, accepted because preferences are padded in anyway.
 */
export const NEWER_DUPLICATE_COSINE_BY_MODEL: Record<string, number> = { "@cf/baai/bge-m3": 0.57 };

/** The newer near-duplicate cosine for `model`. */
export function newerDuplicateCosine(model: string): number {
  return NEWER_DUPLICATE_COSINE_BY_MODEL[model] ?? NEWER_DUPLICATE_COSINE;
}
/** Most newer near-duplicates one selected memory pulls in. */
export const MAX_NEWER_PER_HIT = 2;

/** Everything one recall needs: the indexer context plus the owner's services. */
export interface SemanticContext extends IndexerContext {
  services: Services;
}

export function createSemanticContext(services: Services, env: Env, config: SemanticConfig): SemanticContext {
  return { db: services.db, services, config, embedder: createEmbedder(env, services.settings, config.model) };
}

export interface RecallHit {
  memory: Memory;
  /** Cosine to the query; null when the memory came only from keyword search. */
  cosine: number | null;
  /** RRF score over the vector and keyword lists. */
  fused: number;
}

/**
 * Reciprocal rank fusion of ranked id lists: each id scores the sum of 1/(k + rank)
 * over the lists it appears in, with 1-based ranks.
 */
export function rrf(lists: string[][], k = RRF_K): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, i) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
    });
  }
  return scores;
}

/**
 * Embeds the query when an embedder is available and today's cap allows one more
 * request. Null on no embedder, the cap, or any AI error, so recall falls back to keywords.
 */
async function embedQuery(ctx: SemanticContext, query: string): Promise<Float32Array | null> {
  const { db, config, embedder } = ctx;
  if (!embedder) return null;
  const day = UsageService.day();
  // Reserved before the call (which counts even if it fails), so concurrent turns cannot overrun the cap.
  if (!reserveEmbedding(db, day, config.maxEmbeddingsPerDay, estimateTokens(query))) return null;
  try {
    const [vector] = await embedder.embed([query]);
    return vector && vector.length === embedder.dims ? vector : null;
  } catch (error) {
    console.warn("Semantic query embedding failed; using keyword recall", error instanceof Error ? error.message : String(error));
    return null;
  }
}

/**
 * Vector hits the floors keep are topped up to this many with the best remaining vectors at or
 * above `vectorFloor.backstop`. Measured on bge-m3 (2026-10-10): the tennis question scores
 * "I only have one arm" 0.427 and "I have no arms" 0.435; the mountain question "I'm afraid of
 * heights" 0.512 and "My knee surgery was in August" 0.409; all under the 0.55 floor. "what's the
 * capital of France?" tops out at 0.384, so it stays empty. Greetings such as "hello" top about
 * 0.51 and so bring up to 4 low-relevance memories.
 */
export const FALLBACK_K = 4;

/**
 * Brute-force cosine (a dot product of unit vectors) over every cached vector of `model` with
 * the query's dims, keeping hits at or above the absolute floor and within `relative` of the
 * best hit, best first. Fewer than FALLBACK_K such hits are filled up to it with the best remaining vectors at or above the
 * backstop (ties to the newer update, then the lower id), each keeping its real cosine. Rows of
 * another model or size are never scored.
 */
function scanVectors(ctx: SemanticContext, model: string, query: Float32Array, includeHistorical: boolean): { id: string; cosine: number }[] {
  const { absolute, relative, backstop } = ctx.config.vectorFloor;
  const unit = normalize(query);
  const rows = ctx.db.all<{ id: string; updated_at: string; status: string }>(`SELECT id, updated_at, status FROM tal_memories`);
  const updated = new Map(rows.map((r) => [r.id, r.updated_at]));
  // Past facts (memory history) are only scored for questions about the past.
  const past = includeHistorical ? new Set<string>() : new Set(rows.filter((r) => r.status === "historical").map((r) => r.id));
  const all: { id: string; cosine: number; updated: string | null }[] = [];
  for (const [id, vector] of cachedVectors(ctx.db, model, query.length)) {
    if (past.has(id)) continue;
    all.push({ id, cosine: dot(unit, vector), updated: updated.get(id) ?? null });
  }
  all.sort((a, b) => b.cosine - a.cosine || compareDesc(a.updated ?? "", b.updated ?? "") || compareAsc(a.id, b.id));
  const top = all[0];
  const kept =
    top && top.cosine >= absolute ? all.filter((s) => s.cosine >= absolute && s.cosine >= top.cosine - relative) : [];
  if (kept.length < FALLBACK_K) {
    const taken = new Set(kept.map((s) => s.id));
    // A row whose memory is gone (pending purge) never takes a fallback slot.
    for (const s of all) {
      if (kept.length >= FALLBACK_K || s.cosine < backstop) break;
      if (!taken.has(s.id) && s.updated !== null) kept.push(s);
    }
  }
  return kept.slice(0, CANDIDATES_PER_LIST).map(({ id, cosine }) => ({ id, cosine }));
}

/**
 * Hybrid recall: cosine hits above the floors fused by RRF with upstream keyword search.
 * Without a query vector (no embedder, cap reached, AI error) the keyword list alone ranks.
 * Ties go to the higher cosine, then the newer update, then the lower id.
 */
export async function hybridSearch(ctx: SemanticContext, query: string, opts: { limit: number; includeHistorical?: boolean }): Promise<RecallHit[]> {
  ensureSemanticSchema(ctx.db);
  const includeHistorical = opts.includeHistorical ?? hasHistoricalIntent(query);
  const queryVector = await embedQuery(ctx, query);
  const vectorHits = queryVector && ctx.embedder ? scanVectors(ctx, ctx.embedder.model, queryVector, includeHistorical) : [];
  const keywordHits = ctx.services.memories.search(query, CANDIDATES_PER_LIST, undefined, includeHistorical ? "all" : "current");

  const fused = rrf([vectorHits.map((h) => h.id), keywordHits.map((m) => m.id)]);
  const cosines = new Map(vectorHits.map((h) => [h.id, h.cosine]));
  const memories = new Map(keywordHits.map((m) => [m.id, m]));
  const hits: RecallHit[] = [];
  for (const [id, score] of fused) {
    // A vector row can outlive its memory until the next indexer purge.
    const memory = memories.get(id) ?? ctx.services.memories.get(id);
    if (memory) hits.push({ memory, cosine: cosines.get(id) ?? null, fused: score });
  }
  hits.sort(
    (a, b) =>
      b.fused - a.fused ||
      (b.cosine ?? -Infinity) - (a.cosine ?? -Infinity) ||
      compareDesc(a.memory.updated_at, b.memory.updated_at) ||
      compareAsc(a.memory.id, b.memory.id),
  );
  return pullInNewer(ctx, hits.slice(0, Math.max(0, opts.limit)), opts.limit, includeHistorical);
}

const compareAsc = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const compareDesc = (a: string, b: string) => compareAsc(b, a);

/** True when `a` was saved strictly after `b`: a later update, or the same update and a later creation. */
const isNewer = (a: Memory, b: Memory) =>
  compareAsc(a.updated_at, b.updated_at) > 0 || (a.updated_at === b.updated_at && compareAsc(a.created_at, b.created_at) > 0);

/**
 * After selection, each selected hit pulls in up to MAX_NEWER_PER_HIT newer memories whose
 * stored vector is within the model's newerDuplicateCosine of its own, so a superseded fact never reaches
 * the model without its replacement. Pulled memories sit right after their puller with its fused
 * score and never pull further. A full list drops its weakest non-pulled hit that pulled nothing;
 * when there is none the pull is skipped. Uses cached stored vectors only: no embedder calls. Only rows
 * of the current model and its dims are read; with the dims still unknown, only equal-length vectors compare.
 */
export function pullInNewer(ctx: SemanticContext, hits: RecallHit[], limit: number, includeHistorical = false): RecallHit[] {
  const out = hits.slice(0, Math.max(0, limit));
  if (out.length === 0) return out;
  const model = ctx.embedder?.model ?? ctx.config.model;
  const dims = ctx.embedder?.dims || MODEL_DIMS[model] || 0;
  const threshold = newerDuplicateCosine(model);
  const vectors = cachedVectors(ctx.db, model, dims);
  const seen = new Set(out.map((h) => h.memory.id));
  const pulled = new Set<RecallHit>();
  const pullers = new Set<RecallHit>();
  for (const puller of [...out]) {
    const own = vectors.get(puller.memory.id);
    if (!own || !out.includes(puller)) continue;
    const candidates: { memory: Memory; cosine: number }[] = [];
    for (const [id, vector] of vectors) {
      if (seen.has(id) || vector.length !== own.length) continue;
      const c = dot(own, vector);
      if (c < threshold) continue;
      const memory = ctx.services.memories.get(id);
      if (memory && isNewer(memory, puller.memory) && (includeHistorical || memory.status !== "historical")) candidates.push({ memory, cosine: c });
    }
    candidates.sort((a, b) => b.cosine - a.cosine || compareAsc(a.memory.id, b.memory.id));
    let at = out.indexOf(puller) + 1;
    for (const { memory } of candidates.slice(0, MAX_NEWER_PER_HIT)) {
      if (out.length >= limit) {
        let drop = -1;
        for (let i = out.length - 1; i >= 0; i--) {
          const h = out[i]!;
          if (h !== puller && !pulled.has(h) && !pullers.has(h)) {
            drop = i;
            break;
          }
        }
        if (drop < 0) break;
        out.splice(drop, 1);
        if (drop < at) at--;
      }
      const hit: RecallHit = { memory, cosine: null, fused: puller.fused };
      out.splice(at++, 0, hit);
      seen.add(memory.id);
      pulled.add(hit);
      pullers.add(puller);
    }
  }
  return out;
}

const SAVED_AT_OPTS = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
} as const;

/**
 * `YYYY-MM-DD HH:MM TZ` of `iso` in `timeZone` on a 24-hour clock with Intl's short zone name
 * (`PDT`, `UTC`, `GMT+2`), falling back to UTC for an unknown zone. A bare `GMT` reads `UTC`.
 */
export function savedAt(iso: string, timeZone: string): string {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-CA", { ...SAVED_AT_OPTS, timeZone });
  } catch {
    format = new Intl.DateTimeFormat("en-CA", { ...SAVED_AT_OPTS, timeZone: "UTC" });
  }
  const part: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const p of format.formatToParts(new Date(iso))) part[p.type] = p.value;
  const zone = part.timeZoneName === "GMT" ? "UTC" : part.timeZoneName;
  return `${part.year}-${part.month}-${part.day} ${part.hour}:${part.minute} ${zone}`;
}

/**
 * M1 recency: newest update first (then newest creation, then id), each content prefixed
 * with `(saved YYYY-MM-DD HH:MM TZ) ` in the owner's timezone. Returns copies; inputs are untouched.
 */
export function applyM1(memories: Memory[], timezone: string): Memory[] {
  return [...memories]
    .sort(
      (a, b) =>
        compareDesc(a.updated_at, b.updated_at) || compareDesc(a.created_at, b.created_at) || compareAsc(a.id, b.id),
    )
    .map((m) => ({ ...m, content: `(saved ${savedAt(m.updated_at, timezone)}) ${m.content}` }));
}

/**
 * The newer-wins note as a prompt-only memory line. It is never stored, embedded or
 * returned by search; it exists only in the list handed to the runner's prompt.
 */
export function newerWinsNote(): Memory {
  const epoch = "1970-01-01T00:00:00.000Z";
  return {
    id: "semantic-newer-wins-note",
    content: NEWER_WINS_NOTE,
    category: "other",
    source: "agent",
    status: "active",
    superseded_by: null,
    valid_from: null,
    valid_until: null,
    created_at: epoch,
    updated_at: epoch,
  };
}

/**
 * The semantic replacement for `selectRelevantMemories`: indexes one lazy batch, takes
 * the top hybrid hits, pads with recent preferences by the upstream rule, then applies M1.
 * With two or more memories the newer-wins note follows as the last, undated line.
 */
export async function selectSemanticMemories(ctx: SemanticContext, query: string): Promise<Memory[]> {
  await runIndexer(ctx, { maxEmbed: LAZY_INDEX_BATCH });
  const past = hasHistoricalIntent(query);
  const selected = new Map<string, Memory>();
  for (const h of await hybridSearch(ctx, query, { limit: MAX_RELEVANT_MEMORIES, includeHistorical: past })) selected.set(h.memory.id, h.memory);
  // For questions about the past, earlier versions of the recalled facts come along (memory history).
  if (past) {
    for (const m of [...selected.values()]) {
      for (const p of ctx.services.memories.predecessors(m.id)) if (selected.size < MAX_RELEVANT_MEMORIES) selected.set(p.id, p);
    }
  }
  for (const m of ctx.services.memories.list({ category: "preference", limit: ALWAYS_INCLUDE_PREFERENCES, status: "active" })) {
    if (selected.size >= MAX_RELEVANT_MEMORIES) break;
    selected.set(m.id, m);
  }
  const memories = applyM1([...selected.values()], ctx.services.settings.get().timezone);
  return memories.length >= 2 ? [...memories, newerWinsNote()] : memories;
}
