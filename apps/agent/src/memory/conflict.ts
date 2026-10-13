import type { Memory } from "@talorys/shared";
import { z } from "zod";

export type Relationship = "supersedes" | "refines" | "contradicts" | "possible_update" | "complements" | "unrelated" | "duplicate";

export interface ConflictAssessment {
  relationship: Relationship;
  confidence: number;
  reason: string;
  oldMemoryId: string;
}

/** Minimum confidence for an automatic (always reversible) supersession. */
export const AUTO_SUPERSEDE_CONFIDENCE = 0.8;
/** Longest a save waits for Clef, in ms; a timeout counts as an AI error. */
export const CLEF_TIMEOUT_MS = 3000;
/**
 * Minimum Clef probability for a contradiction on a memory nominated by similarity alone.
 * A starting value, to be measured against real pairs.
 */
export const AI_SEMANTIC_CONTRADICTION_MIN = 0.7;
/**
 * Minimum Clef probability for a compatible answer (refines, complements, unrelated) to dismiss
 * a review the wording rules raised. Same value as AUTO_SUPERSEDE_CONFIDENCE and the old
 * chat-model check (e34c7eb), but a separate bar: this one dismisses a rule-raised review,
 * AUTO_SUPERSEDE_CONFIDENCE replaces a memory.
 */
export const AI_DISMISS_MIN = 0.8;

const STOP = new Set(
  "a an and are as at be but by can could do does did for from had has have how i i'm im if in into is it its me my of on or our so than that the their them then there these they this to us was we were what when where which who why will with would you your about also just like now new very really still been being am he she his her owner user".split(
    " ",
  ),
);

/** Common words that don't identify what a fact is about. */
const GENERIC = new Set(
  "like likes love loves enjoy enjoys prefer prefers old good great best favorite favourite much more less time day days year years week weeks month months always never usually often thing things people lot want need going got get make made use used".split(
    " ",
  ),
);

export function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (raw.length < 3 || STOP.has(raw) || GENERIC.has(raw)) continue;
    out.add(raw.length > 4 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw);
  }
  return out;
}

/** Topics where a person normally has one current value, with the wording that explicitly replaces it. */
interface Slot {
  name: string;
  label: string;
  /** Search terms for finding older memories on this topic. */
  keywords: string;
  /** The statement is about this topic. */
  about: RegExp;
  /** The statement explicitly says the previous value no longer holds. */
  change: RegExp;
}

const SLOTS: Slot[] = [
  {
    name: "residence",
    keywords: "live lives living reside based moved relocated address",
    label: "where you live",
    about: /\b(live[sd]?|living|reside[sd]?|based in|moved|relocated|address)\b/i,
    change: /\b(moved|relocated)\b(?!.*\b(?:temporarily|for (?:a|the) (?:week|weekend|month|trip))\b)|\bno longer live|\bdon'?t live\b/i,
  },
  {
    name: "vehicle",
    keywords: "car drive drives vehicle tesla volkswagen vw bmw toyota honda ford audi mercedes truck",
    label: "your car",
    about: /\b(car|drive[sn]?|driving|vehicle|tesla|volkswagen|vw|bmw|toyota|honda|ford|audi|mercedes|truck)\b/i,
    change: /\b(sold|traded|trade[ds]? in|replaced|got rid of|no longer (?:drive|own|have))\b/i,
  },
  {
    name: "job",
    keywords: "work works job employer employed position role",
    label: "your job",
    about: /\b(work(?:s|ing)? (?:at|for|as)|job|employer|employed|position at|role at)\b/i,
    change: /\b(new job|quit|left (?:my|the) job|left \w+ to join|started (?:a new job|working)|joined|switched jobs|was laid off|retired|no longer work)\b/i,
  },
  {
    name: "diet",
    keywords: "vegetarian vegan pescatarian keto meat carnivore gluten",
    label: "your diet",
    about: /\b(vegetarian|vegan|pescatarian|keto|eat(?:s)? meat|carnivore|gluten[- ]free)\b/i,
    change: /\b(no longer|not anymore|stopped being|stopped eating|became|gave up|switched to)\b/i,
  },
  {
    name: "relationship",
    keywords: "married single divorced partner wife husband boyfriend girlfriend engaged dating",
    label: "your relationship status",
    about: /\b(married|single|divorced|partner|wife|husband|boyfriend|girlfriend|engaged|dating)\b/i,
    change: /\b(divorced|broke up|separated|got married|got engaged|no longer (?:married|dating|with))\b/i,
  },
];

/** Search terms for the single-valued topics a statement is about (used to find conflict candidates). */
export function slotSearchTerms(text: string): string[] {
  return SLOTS.filter((s) => s.about.test(text)).map((s) => s.keywords);
}

const EXPLICIT_CHANGE =
  /\b(no longer|not anymore|anymore|used to|instead of|replaced|switched|changed|stopped|quit|sold|traded|got rid of|moved (?:from|away|out)|gave up)\b/i;

/**
 * Deterministic relationship between a new statement and an older memory.
 * Similarity alone never produces a supersession: it needs explicit change
 * wording that refers to the old fact (by name or by topic), or a strict refinement.
 */
export function classifyRelationship(newContent: string, old: Memory): ConflictAssessment {
  const base = { oldMemoryId: old.id };
  const a = newContent.trim().toLowerCase();
  const b = old.content.trim().toLowerCase();
  if (a === b) return { ...base, relationship: "duplicate", confidence: 1, reason: "Same statement." };

  const newTokens = tokens(newContent);
  const oldTokens = tokens(old.content);
  const shared = [...oldTokens].filter((t) => newTokens.has(t));
  const explicitChange = EXPLICIT_CHANGE.test(newContent);

  // 1. The new statement names the old fact and says it changed: "I sold my Volkswagen…".
  //    The shared words must cover at least half of what the old memory is about.
  if (explicitChange && shared.length > 0 && shared.length * 2 >= oldTokens.size) {
    return { ...base, relationship: "supersedes", confidence: 0.95, reason: `The new memory says “${shared.slice(0, 3).join(", ")}” changed.` };
  }

  // 2. Same single-valued topic.
  const slot = SLOTS.find((s) => s.about.test(newContent) && s.about.test(old.content));
  if (slot) {
    if (slot.change.test(newContent) && !slot.change.test(old.content)) {
      return { ...base, relationship: "supersedes", confidence: 0.85, reason: `The new memory explicitly updates ${slot.label}.` };
    }
    if (oldTokens.size > 0 && shared.length === oldTokens.size && newTokens.size > oldTokens.size) {
      return { ...base, relationship: "refines", confidence: 0.9, reason: "The new memory adds detail to this one." };
    }
    return {
      ...base,
      relationship: slot.change.test(newContent) ? "possible_update" : "contradicts",
      confidence: 0.6,
      reason: `Both memories describe ${slot.label}; it's unclear whether the older one still holds.`,
    };
  }

  // 3. Strict refinement: every meaningful word of the old memory, plus more detail.
  if (oldTokens.size >= 2 && shared.length === oldTokens.size && newTokens.size > oldTokens.size) {
    return { ...base, relationship: "refines", confidence: 0.9, reason: "The new memory adds detail to this one." };
  }

  if (shared.length > 0) return { ...base, relationship: "complements", confidence: 0.5, reason: "Related but compatible." };
  return { ...base, relationship: "unrelated", confidence: 0.9, reason: "No overlap." };
}

/** What to do with an assessment. Automatic changes are always reversible (history is kept). */
export function decide(assessment: ConflictAssessment): "supersede" | "review" | "none" {
  if ((assessment.relationship === "supersedes" || assessment.relationship === "refines") && assessment.confidence >= AUTO_SUPERSEDE_CONFIDENCE) {
    return "supersede";
  }
  if (assessment.relationship === "contradicts" || assessment.relationship === "possible_update") return "review";
  return "none";
}

// ---------- AI supersession check (rule nominations + semantic candidates) ----------

/**
 * Cosine (normalized vectors) at or above which an older memory is sent to the AI check.
 * Measured on bge-m3 (2026-10-11): real replacements 0.57-0.82 ("Sally is my coworker" vs
 * "Bob is now my only coworker" 0.625), unrelated pairs 0.40-0.58.
 */
export const AI_CANDIDATE_MIN_COSINE = 0.6;
/** Most semantic candidates per save; rule nominations are checked on top of these. */
export const AI_CANDIDATE_LIMIT = 3;
/** Cloudflare's decision model on Workers AI: a probability for every option, billed on input tokens only. */
export const CLEF_MODEL = "@cf/cloudflare/clef";

/**
 * What each relationship means, as Clef criteria. Clef read "the same person" loosely until
 * the definitions said so outright ("My brother is no longer allergic to peanut butter" came
 * back as supersedes 0.96 against "I'm allergic to peanut butter"; 0.19 with this wording).
 */
const CLEF_CRITERIA = {
  supersedes:
    "The newer fact replaces the older one: the older fact is no longer true about the same person. A fact about someone else (a relative, a friend, a coworker) never replaces a fact about the owner.",
  refines: "Same fact about the same person and thing, with more detail; the older fact is still true",
  contradicts: "Both are about the same person and thing and conflict, but it is unclear which one is current",
  complements: "Related, and both are still true",
  unrelated: "About a different thing, or about a different person",
};

export interface ClefRequest {
  model: "clef";
  state: { about: string; newer: string; older: { n: number; content: string }[] };
  questions: Record<string, { type: "choice"; instructions: string; criteria: Record<string, string> }>;
}
/** Runs one Clef request: the Workers AI binding in production, a fake in tests. */
export type ClefRun = (request: ClefRequest, signal?: AbortSignal) => Promise<unknown>;

/** One choice question per older memory, all in one request. The facts are data in `state`. */
export function clefRequest(newer: string, older: { content: string }[]): ClefRequest {
  return {
    model: "clef",
    state: {
      about: 'Facts the owner told their assistant, in their own words. "I" and "my" mean the owner.',
      newer: newer.slice(0, 500),
      older: older.map((o, i) => ({ n: i + 1, content: o.content.slice(0, 500) })),
    },
    questions: Object.fromEntries(
      older.map((_, i) => [`older_${i + 1}`, { type: "choice", instructions: `How does the newer fact relate to older fact ${i + 1}?`, criteria: CLEF_CRITERIA }]),
    ),
  };
}

const clefAnswerSchema = z.object({
  choice: z.enum(["supersedes", "refines", "contradicts", "complements", "unrelated"]),
  probabilities: z.record(z.string(), z.number().min(0).max(1)),
});
const clefResponseSchema = z.object({ answers: z.record(z.string(), z.unknown()) });
/** How the newer memory relates to one older memory, with the probability of that answer. */
export interface AiVerdict {
  relationship: z.infer<typeof clefAnswerSchema>["choice"];
  confidence: number;
  reason: string;
}
export type AiBatchVerdict = AiVerdict & { memoryId: string; probabilities?: Record<string, number> };

/** Reads a Clef response. Null unless at least one answer has the expected shape; malformed answers are dropped. */
export function parseClefAnswers(raw: unknown, olderIds: string[]): AiBatchVerdict[] | null {
  const parsed = clefResponseSchema.safeParse(raw);
  if (!parsed.success) return null;
  const out: AiBatchVerdict[] = [];
  olderIds.forEach((memoryId, i) => {
    const answer = clefAnswerSchema.safeParse(parsed.data.answers[`older_${i + 1}`]);
    if (!answer.success) return;
    const { choice, probabilities } = answer.data;
    const confidence = probabilities[choice] ?? 0;
    const pct = `${Math.round(confidence * 100)}% sure`;
    const reason = choice === "supersedes" ? `The newer memory probably replaces this one (${pct}).` : choice === "contradicts" ? `These memories conflict (${pct}).` : "";
    out.push({ memoryId, relationship: choice, confidence, reason, probabilities });
  });
  return out.length ? out : null;
}

/**
 * One Clef call per save: asks how the new memory relates to each older one. Clef returns
 * probabilities, not text, so there is nothing to parse out of prose; the caller decides.
 */
export async function aiCheckSupersession(
  run: ClefRun,
  newer: string,
  older: { id: string; content: string }[],
  signal?: AbortSignal,
): Promise<AiBatchVerdict[] | null> {
  return parseClefAnswers(await run(clefRequest(newer, older), signal), older.map((o) => o.id));
}

/**
 * Only a confident "supersedes" (Clef probability >= AUTO_SUPERSEDE_CONFIDENCE) replaces a memory;
 * a doubtful one or a contradiction waits for review. A contradiction on a memory nominated by
 * similarity alone needs at least AI_SEMANTIC_CONTRADICTION_MIN, otherwise nothing happens.
 */
export function decideAi(verdict: AiVerdict, opts: { semanticOnly?: boolean } = {}): "supersede" | "review" | "none" {
  if (verdict.relationship === "supersedes") return verdict.confidence >= AUTO_SUPERSEDE_CONFIDENCE ? "supersede" : "review";
  if (verdict.relationship === "contradicts") {
    return opts.semanticOnly && verdict.confidence < AI_SEMANTIC_CONTRADICTION_MIN ? "none" : "review";
  }
  return "none";
}

/** True when Clef is at least AI_DISMISS_MIN sure the older memory is still compatible with the newer one. */
export function aiDismisses(verdict: AiVerdict): boolean {
  const compatible = verdict.relationship === "refines" || verdict.relationship === "complements" || verdict.relationship === "unrelated";
  return compatible && verdict.confidence >= AI_DISMISS_MIN;
}
