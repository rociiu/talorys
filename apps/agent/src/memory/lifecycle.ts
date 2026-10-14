import type { Memory, MemoryHistory, MemoryReviewAction, MemoryStatus } from "@talorys/shared";
import type { Database } from "../db/database";
import type { MemoryRepository } from "../db/repositories/memories";
import { AppError, NotFoundError, ValidationError } from "../api/errors";

/** Longest supersession chain followed when reading history or checking for cycles. */
export const MAX_CHAIN_DEPTH = 50;

/**
 * Lifecycle rules for memories. Every relationship change goes through here, so
 * links always point at existing memories, never at themselves, and never form cycles.
 */
export class MemoryLifecycle {
  constructor(
    private readonly db: Database,
    private readonly repo: MemoryRepository,
  ) {}

  /** True if making `oldId` superseded by `newId` would create a loop. */
  wouldCycle(oldId: string, newId: string): boolean {
    if (oldId === newId) return true;
    let current: string | null = newId;
    for (let i = 0; i < MAX_CHAIN_DEPTH && current; i++) {
      const next: string | null = this.repo.get(current)?.superseded_by ?? null;
      if (next === oldId) return true;
      current = next;
    }
    return false;
  }

  /** Marks `oldId` as a past fact replaced by `newId`. Nothing is deleted. */
  supersede(oldId: string, newId: string, opts: { validUntil?: string | null } = {}): Memory {
    return this.db.transaction(() => {
      const older = this.repo.require(oldId);
      this.repo.require(newId);
      if (this.wouldCycle(oldId, newId)) throw new ValidationError("A memory can't replace itself or one of its own replacements.");
      const updated = this.repo.setLifecycle(oldId, {
        status: "historical",
        superseded_by: newId,
        valid_until: opts.validUntil ?? older.valid_until,
      });
      this.db.run(
        `DELETE FROM tal_memory_reviews WHERE (memory_id = ? AND other_id = ?) OR (memory_id = ? AND other_id = ?)`,
        newId, oldId, oldId, newId,
      );
      return updated;
    });
  }

  setStatus(id: string, status: MemoryStatus): Memory {
    const memory = this.repo.require(id);
    switch (status) {
      case "historical":
        return this.repo.setLifecycle(id, { status: "historical" });
      case "uncertain":
        return this.repo.setLifecycle(id, { status: "uncertain" });
      case "active":
        // Restoring a past fact makes it current again and detaches it from its replacement.
        return this.repo.setLifecycle(id, { status: "active", superseded_by: null, valid_until: memory.status === "historical" ? null : memory.valid_until });
    }
  }

  /** The chain of older and newer versions around a memory (bounded). */
  history(id: string): MemoryHistory {
    const memory = this.repo.require(id);
    const previous: Memory[] = [];
    const seen = new Set([id]);
    let frontier = [id];
    for (let depth = 0; depth < MAX_CHAIN_DEPTH && frontier.length > 0 && previous.length < 100; depth++) {
      const next: string[] = [];
      for (const fid of frontier) {
        for (const p of this.repo.predecessors(fid)) {
          if (seen.has(p.id)) continue;
          seen.add(p.id);
          previous.push(p);
          next.push(p.id);
        }
      }
      frontier = next;
    }
    // BFS found the nearest versions first; oldest first reads naturally.
    previous.reverse();
    const later: Memory[] = [];
    let current = memory.superseded_by;
    for (let i = 0; i < MAX_CHAIN_DEPTH && current && !seen.has(current); i++) {
      seen.add(current);
      const m = this.repo.get(current);
      if (!m) break;
      later.push(m);
      current = m.superseded_by;
    }
    return { memory, previous, next: later };
  }

  /**
   * Applies the owner's decision on a possible conflict.
   *  - keep_both: both stay current.
   *  - mark_historical: the older memory becomes history, linked to the newer one.
   *  - replace: the older memory is permanently deleted.
   *  - cancel: the newer memory is permanently deleted (the change is discarded).
   */
  resolveReview(reviewId: string, action: MemoryReviewAction): { kept: Memory[]; deleted: string[] } {
    return this.db.transaction(() => {
      const review = this.repo.getReview(reviewId);
      if (!review) throw new NotFoundError("This review no longer exists.");
      const newer = this.repo.get(review.memory_id);
      const older = this.repo.get(review.other_id);
      if (!newer || !older) {
        this.repo.deleteReview(reviewId);
        throw new AppError("CONFLICT", "One of these memories was already removed.");
      }
      this.repo.deleteReview(reviewId);
      switch (action) {
        case "keep_both":
          return { kept: [newer, older], deleted: [] };
        case "mark_historical":
          return { kept: [newer, this.supersede(older.id, newer.id, { validUntil: newer.valid_from })], deleted: [] };
        case "replace":
          this.repo.delete(older.id);
          return { kept: [newer], deleted: [older.id] };
        case "cancel":
          this.repo.delete(newer.id);
          return { kept: [older], deleted: [newer.id] };
      }
    });
  }
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/**
 * Extracts a start date only when the text states one explicitly
 * ("since 2024", "in March 2025", "as of 2025-06-01"). Never guesses.
 */
export function extractStatedDate(text: string): string | null {
  const iso = text.match(/\b(?:since|from|as of|starting|on|in)\s+((?:19|20)\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/i);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const month = text.match(new RegExp(`\\b(?:since|from|as of|starting|in)\\s+(${MONTHS.join("|")})\\s+((?:19|20)\\d{2})\\b`, "i"));
  if (month) return `${month[2]}-${String(MONTHS.indexOf(month[1]!.toLowerCase()) + 1).padStart(2, "0")}`;
  const year = text.match(/\b(?:since|from|as of|starting|in)\s+((?:19|20)\d{2})\b/i);
  return year ? year[1]! : null;
}
