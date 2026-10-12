import type { Memory, MemoryCategory, MemoryReviewAction } from "@talorys/shared";
import { type AIProvider, estimateTokens } from "../ai/provider";
import { ValidationError } from "../api/errors";
import type { Database } from "../db/database";
import type { MemoryRepository, MemoryReviewRow } from "../db/repositories/memories";
import { deleteAllVectors, deleteVector } from "../semantic/vectorStore";
import type { SettingsService } from "../services/settings";
import type { ActivityLog, UsageService } from "../services/usage";
import { aiCheckConflict, classifyRelationship, type ConflictAssessment, decide, slotSearchTerms } from "./conflict";
import { extractStatedDate, MemoryLifecycle } from "./lifecycle";

export interface MemoryHistoryHooks {
  /** The chat provider, used only for the optional AI conflict double-check. */
  provider?: () => AIProvider | null;
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

/**
 * Memory writes with history: saves first, then (rule-based, no AI by default) checks
 * whether the new memory replaces or may contradict an older one. Explicit replacements
 * keep the old memory as a past fact; unclear cases wait for the owner's review.
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
  async correct(id: string, content: string, category?: MemoryCategory, source: "manual" | "agent" = "manual"): Promise<WriteResult> {
    const old = this.repo.require(id);
    const created = this.repo.create({ content, category: category ?? old.category, source, valid_from: extractStatedDate(content) });
    if (created.id === old.id) throw new ValidationError("That is the same as the current memory.");
    const superseded = [this.lifecycle.supersede(old.id, created.id, {})];
    const rest = await this.afterWrite(this.repo.require(created.id));
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
   * as where the owner lives), classifies each relationship with deterministic rules, supersedes
   * only explicit replacements and leaves unclear cases for the owner. Runs only on memory
   * writes, never per chat message.
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

    const superseded: Memory[] = [];
    const reviews: MemoryReviewRow[] = [];
    let aiChecks = 0;
    for (const a of assessments) {
      const action = decide(a);
      if (action === "none") continue;
      if (action === "supersede") {
        if (this.lifecycle.wouldCycle(a.oldMemoryId, memory.id)) continue;
        superseded.push(this.lifecycle.supersede(a.oldMemoryId, memory.id, { validUntil: memory.valid_from }));
        continue;
      }
      // Ambiguous: optionally let the model dismiss a false alarm. It can never supersede by itself.
      let reason = a.reason;
      if (this.settings.get().memoryHistory.aiConflictCheck && aiChecks < 1) {
        aiChecks++;
        const verdict = await this.aiVerdict(candidates.get(a.oldMemoryId)!.content, memory.content, signal);
        if (verdict && (verdict.relationship === "complements" || verdict.relationship === "unrelated") && verdict.confidence >= 0.8) continue;
        if (verdict) reason = verdict.reason || reason;
      }
      reviews.push(
        this.repo.createReview({
          memory_id: memory.id,
          other_id: a.oldMemoryId,
          relationship: a.relationship === "possible_update" ? "possible_update" : "contradiction",
          reason,
        }),
      );
    }
    if (superseded.length) this.activity.record("memory.superseded", `${superseded.length} older memory(ies) kept as history`);
    if (reviews.length) this.activity.record("memory.review", `${reviews.length} possible memory conflict(s) need review`);
    return { memory: this.repo.get(memory.id) ?? memory, superseded, reviews };
  }

  private async aiVerdict(older: string, newer: string, signal?: AbortSignal) {
    const provider = this.hooks.provider?.();
    const { limits } = this.settings.get();
    if (!provider || !this.usage.reserveAi(limits)) return null;
    try {
      return await aiCheckConflict(provider, older, newer, signal);
    } catch {
      this.usage.increment({ ai_errors: 1 });
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
