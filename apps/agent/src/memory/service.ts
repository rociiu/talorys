import type { Memory, MemoryCategory, MemoryReviewAction } from "@talorys/shared";
import { estimateTokens } from "../ai/provider";
import { ValidationError } from "../api/errors";
import type { Database } from "../db/database";
import type { MemoryRepository, MemoryReviewRow } from "../db/repositories/memories";
import type { NeighborOptions } from "../semantic/neighbors";
import { deleteAllVectors, deleteVector } from "../semantic/vectorStore";
import type { SettingsService } from "../services/settings";
import type { ActivityLog, UsageService } from "../services/usage";
import {
  AI_CANDIDATE_LIMIT,
  AI_CANDIDATE_MIN_COSINE,
  type AiBatchVerdict,
  aiCheckSupersession,
  aiDismisses,
  type ClefRun,
  CLEF_TIMEOUT_MS,
  classifyRelationship,
  type ConflictAssessment,
  decide,
  decideAi,
  slotSearchTerms,
} from "./conflict";
import { extractStatedDate, MemoryLifecycle } from "./lifecycle";

export interface MemoryHistoryHooks {
  /** Clef (Workers AI decision model), used only for the optional AI conflict check. */
  clef?: () => ClefRun | null;
  /** Other memories by cosine to this one, best first, within `opts` (semantic recall on); embeds it if needed. */
  neighbors?: (memory: Memory, opts: NeighborOptions) => Promise<{ id: string; cosine: number }[]>;
  /** Called after each AI conflict check (development logging, tests). */
  onAiCheck?: (check: { newer: string; older: string[]; verdicts: AiBatchVerdict[] | null }) => void;
  /** Clef time limit in ms (tests only). */
  clefTimeoutMs?: number;
}

export interface WriteResult {
  memory: Memory;
  /** Older memories this one replaced (kept as history). */
  superseded: Memory[];
  /** Possible conflicts left for the owner to decide. */
  reviews: MemoryReviewRow[];
}

/** A memory as shown to the model. */
export interface PromptMemory {
  content: string;
  category: string;
  status?: Memory["status"];
  note?: string;
}

const CONFLICT_CANDIDATES = 8;

/** What to do with one older memory after a conflict check. */
type ConflictDecision =
  | { oldId: string; action: "supersede" }
  | { oldId: string; action: "review"; relationship: MemoryReviewRow["relationship"]; reason: string };

/** What the deterministic rules decide for one assessment (empty when they leave it alone). */
function ruleDecision(a: ConflictAssessment): ConflictDecision[] {
  const action = decide(a);
  if (action === "none") return [];
  // Rules alone never retire a memory: a replacement they find waits for the owner's review.
  if (action === "supersede") return [{ oldId: a.oldMemoryId, action: "review", relationship: "possible_update", reason: a.reason }];
  return [{ oldId: a.oldMemoryId, action, relationship: a.relationship === "possible_update" ? "possible_update" : "contradiction", reason: a.reason }];
}

/**
 * Memory writes with history: saves first, then (rule-based, no AI by default) checks
 * whether the new memory replaces or may contradict an older one. Replacements the rules find
 * wait for the owner's review like unclear cases; only Clef or an explicit correction marks a
 * memory as past.
 * Recall itself lives in `agent/memory.ts` (keyword) and `semantic/` (hybrid).
 */
export class MemoryHistoryService {
  readonly lifecycle: MemoryLifecycle;

  constructor(
    private readonly db: Database,
    private readonly repo: MemoryRepository,
    private readonly settings: SettingsService,
    private readonly usage: UsageService,
    private readonly activity: ActivityLog,
    public hooks: MemoryHistoryHooks = {},
  ) {
    this.lifecycle = new MemoryLifecycle(db, repo);
  }

  // ---------- Writes ----------

  async create(input: { content: string; category?: MemoryCategory; source?: Memory["source"] }, opts: { signal?: AbortSignal } = {}): Promise<WriteResult> {
    const { duplicate, ...memory } = this.repo.create({ ...input, valid_from: extractStatedDate(input.content) });
    // Saved first: nothing below can lose the memory.
    if (duplicate) return { memory, superseded: [], reviews: [] };
    return this.afterWrite(memory, opts.signal);
  }

  async update(id: string, patch: { content?: string; category?: MemoryCategory }, opts: { signal?: AbortSignal } = {}): Promise<WriteResult> {
    const before = this.repo.require(id);
    const memory = this.repo.update(id, patch);
    if (memory.content === before.content) return { memory, superseded: [], reviews: [] };
    return this.afterWrite(memory, opts.signal);
  }

  /** Records a newer version of a fact. The old memory is kept as history and linked to the new one. */
  async correct(
    id: string,
    content: string,
    category?: MemoryCategory,
    opts: { source?: "manual" | "agent"; signal?: AbortSignal } = {},
  ): Promise<WriteResult> {
    const old = this.repo.require(id);
    const created = this.repo.create({ content, category: category ?? old.category, source: opts.source ?? "manual", valid_from: extractStatedDate(content) });
    if (created.id === old.id) throw new ValidationError("That is the same as the current memory.");
    const superseded = [this.lifecycle.supersede(old.id, created.id, {})];
    const rest = await this.afterWrite(this.repo.require(created.id), opts.signal);
    return { memory: this.repo.require(created.id), superseded: [...superseded, ...rest.superseded], reviews: rest.reviews };
  }

  /**
   * Permanent deletion: the memory, its semantic vector, conflict reviews, links from other
   * memories, and the activity entry that quoted it.
   */
  delete(id: string): void {
    const memory = this.repo.require(id);
    this.repo.delete(id);
    deleteVector(this.db, id);
    this.db.run(`DELETE FROM tal_activity WHERE type = 'memory.created' AND summary = ?`, `Agent remembered: ${memory.content}`.slice(0, 500));
  }

  clear(): number {
    const deleted = this.repo.clear();
    deleteAllVectors(this.db);
    this.db.run(`DELETE FROM tal_activity WHERE type = 'memory.created'`);
    return deleted;
  }

  resolveReview(reviewId: string, action: MemoryReviewAction) {
    const result = this.lifecycle.resolveReview(reviewId, action);
    for (const id of result.deleted) deleteVector(this.db, id);
    this.activity.record("memory.review_resolved", `Resolved a memory conflict: ${action.replace("_", " ")}`);
    return result;
  }

  private async afterWrite(memory: Memory, signal?: AbortSignal): Promise<WriteResult> {
    if (!this.settings.get().memoryHistory.conflictReview) return { memory, superseded: [], reviews: [] };
    try {
      return await this.detectConflicts(memory, signal);
    } catch (error) {
      // Conflict detection is best-effort; the memory itself is already saved.
      console.warn("Memory conflict detection skipped", error instanceof Error ? error.name : "error");
      return { memory: this.repo.get(memory.id) ?? memory, superseded: [], reviews: [] };
    }
  }

  /**
   * Finds likely related current memories (shared words, or the same single-valued topic such
   * as where the owner lives), classifies each relationship with deterministic rules and leaves
   * every replacement or unclear case for the owner to review. Runs only on memory writes, never
   * per chat message.
   */
  private async detectConflicts(memory: Memory, signal?: AbortSignal): Promise<WriteResult> {
    const candidates = new Map<string, Memory>();
    for (const m of this.repo.search(memory.content, CONFLICT_CANDIDATES, undefined, "current")) candidates.set(m.id, m);
    // Same topic without shared words ("I moved to Paris" vs "I live in London").
    for (const terms of slotSearchTerms(memory.content)) {
      for (const m of this.repo.search(terms, CONFLICT_CANDIDATES, undefined, "current")) candidates.set(m.id, m);
    }
    candidates.delete(memory.id);

    const assessments: ConflictAssessment[] = [...candidates.values()]
      .filter((c) => c.status !== "historical" && c.created_at <= memory.updated_at)
      .map((c) => classifyRelationship(memory.content, c));
    if (this.settings.get().memoryHistory.aiConflictCheck) return this.detectWithAi(memory, candidates, assessments, signal);

    return this.applyDecisions(memory, assessments.flatMap((a) => ruleDecision(a)));
  }

  /**
   * With the AI check on, rules and semantic similarity only nominate: the rule hits plus up to
   * AI_CANDIDATE_LIMIT memories at or above AI_CANDIDATE_MIN_COSINE go to one Clef call, and only
   * a confident "supersedes" replaces a memory. Clef and the AI budget are checked before any
   * embedding work; when Clef can't run or answer, rule hits become reviews, as with the check off.
   */
  private async detectWithAi(
    memory: Memory,
    candidates: Map<string, Memory>,
    assessments: ConflictAssessment[],
    signal?: AbortSignal,
  ): Promise<WriteResult> {
    const nominated = new Map<string, ConflictAssessment>();
    for (const a of assessments) if (decide(a) !== "none") nominated.set(a.oldMemoryId, a);
    const fallback = () => this.applyDecisions(memory, [...nominated.values()].flatMap((a) => ruleDecision(a)));

    const run = this.hooks.clef?.();
    const { limits } = this.settings.get();
    if (!run || !this.usage.canUseAi(limits)) return fallback();

    const pool = new Map<string, Memory>();
    for (const id of nominated.keys()) pool.set(id, candidates.get(id)!);
    for (const m of await this.semanticCandidates(memory, new Set(nominated.keys()))) pool.set(m.id, m);
    if (pool.size === 0) return { memory: this.repo.get(memory.id) ?? memory, superseded: [], reviews: [] };
    if (signal?.aborted || !this.usage.reserveAi(limits)) return fallback();

    const older = [...pool.values()];
    const verdicts = await this.aiCheck(run, memory.content, older, signal);
    this.hooks.onAiCheck?.({ newer: memory.content, older: older.map((m) => m.content), verdicts });
    this.activity.record("memory.ai_check", `AI checked ${older.length} possible conflict(s)${verdicts ? "" : " (no usable answer)"}`);

    const decisions: ConflictDecision[] = [];
    for (const old of older) {
      const verdict = verdicts?.find((v) => v.memoryId === old.id);
      const rule = nominated.get(old.id);
      if (!verdict) {
        // No answer: rule hits become reviews, as with the AI check off; semantic-only ones are left alone.
        if (rule) decisions.push(...ruleDecision(rule));
        continue;
      }
      const action = decideAi(verdict, { semanticOnly: !rule });
      if (action === "supersede") decisions.push({ oldId: old.id, action });
      else if (action === "review") {
        const relationship = verdict.relationship === "contradicts" ? "contradiction" : "possible_update";
        decisions.push({ oldId: old.id, action, relationship, reason: verdict.reason });
      } else if (rule && (decide(rule) === "supersede" || !aiDismisses(verdict))) {
        // A rule replacement Clef did not confirm always waits for the owner's review;
        // a rule review is dropped only when Clef is confident the memories are compatible.
        decisions.push(...ruleDecision(rule));
      }
    }
    return this.applyDecisions(memory, decisions);
  }

  /**
   * Applies conflict decisions in order: supersedes (skipping any that would form a cycle) and
   * reviews for the owner, then records what changed.
   */
  private applyDecisions(memory: Memory, decisions: ConflictDecision[]): WriteResult {
    const superseded: Memory[] = [];
    const reviews: MemoryReviewRow[] = [];
    for (const d of decisions) {
      if (d.action === "supersede") {
        if (this.lifecycle.wouldCycle(d.oldId, memory.id)) continue;
        superseded.push(this.lifecycle.supersede(d.oldId, memory.id, { validUntil: memory.valid_from }));
        continue;
      }
      reviews.push(this.repo.createReview({ memory_id: memory.id, other_id: d.oldId, relationship: d.relationship, reason: d.reason }));
    }
    if (superseded.length) this.activity.record("memory.superseded", `${superseded.length} older memory(ies) kept as history`);
    if (reviews.length) this.activity.record("memory.review", `${reviews.length} possible memory conflict(s) need review`);
    return { memory: this.repo.get(memory.id) ?? memory, superseded, reviews };
  }

  /**
   * Current, older memories closest in meaning (semantic recall on), in the hook's best-first order:
   * at most AI_CANDIDATE_LIMIT at or above AI_CANDIDATE_MIN_COSINE, not counting ids rules already nominated.
   */
  private async semanticCandidates(memory: Memory, exclude: Set<string>): Promise<Memory[]> {
    if (!this.hooks.neighbors) return [];
    let neighbors: { id: string; cosine: number }[];
    try {
      neighbors = await this.hooks.neighbors(memory, { minCosine: AI_CANDIDATE_MIN_COSINE, limit: AI_CANDIDATE_LIMIT, exclude });
    } catch (error) {
      console.warn("memory.neighbors_failed", (error as Error).name);
      return [];
    }
    const out: Memory[] = [];
    for (const n of neighbors) {
      if (n.cosine < AI_CANDIDATE_MIN_COSINE || out.length >= AI_CANDIDATE_LIMIT) break;
      if (n.id === memory.id || exclude.has(n.id)) continue;
      const m = this.repo.get(n.id);
      if (m && m.status !== "historical" && m.created_at <= memory.updated_at) out.push(m);
    }
    return out;
  }

  /**
   * One Clef call (the caller has reserved it against the daily AI budget), limited to
   * CLEF_TIMEOUT_MS. Null when Clef can't answer in time. A timeout or abort stops the wait even if
   * the runtime ignores the signal; a timeout counts as an AI error, a caller abort does not.
   */
  private async aiCheck(run: ClefRun, newer: string, older: Memory[], signal?: AbortSignal): Promise<AiBatchVerdict[] | null> {
    const timeout = AbortSignal.timeout(this.hooks.clefTimeoutMs ?? CLEF_TIMEOUT_MS);
    const effective = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let onAbort = () => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(effective.reason);
      effective.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await this.settleAiCheck(Promise.race([aiCheckSupersession(run, newer, older, effective), aborted]), signal);
    } finally {
      effective.removeEventListener("abort", onAbort);
    }
  }

  private async settleAiCheck(call: Promise<AiBatchVerdict[] | null>, signal?: AbortSignal): Promise<AiBatchVerdict[] | null> {
    try {
      return await call;
    } catch {
      // Only the caller's own abort is not an error; a timeout is.
      if (!signal?.aborted) this.usage.increment({ ai_errors: 1 });
      return null;
    }
  }

  // ---------- Prompt ----------

  /**
   * Labels selected memories for the system prompt (current / unsure / past, with known
   * dates) and keeps them within `maxTokens`, in the order recall chose them.
   */
  promptMemories(selected: Memory[], maxTokens: number): PromptMemory[] {
    const out: PromptMemory[] = [];
    let used = 0;
    for (const memory of selected) {
      const cost = estimateTokens(memory.content) + 8;
      if (used + cost > maxTokens) continue;
      used += cost;
      out.push(toPromptMemory(memory, (id) => this.repo.get(id)));
    }
    return out;
  }
}

/** Labels a memory for the prompt. Dates are only shown where they are known, never invented. */
export function toPromptMemory(memory: Memory, lookup: (id: string) => Memory | null): PromptMemory {
  const notes: string[] = [];
  if (memory.valid_from) notes.push(`since ${memory.valid_from}`);
  if (memory.status === "historical") {
    if (memory.valid_until) notes.push(`until ${memory.valid_until}`);
    const successor = memory.superseded_by ? lookup(memory.superseded_by) : null;
    if (successor) notes.push(`replaced by “${successor.content.slice(0, 120)}”, saved ${successor.created_at.slice(0, 10)}`);
  }
  return { content: memory.content, category: memory.category, status: memory.status ?? "active", ...(notes.length ? { note: notes.join("; ") } : {}) };
}
