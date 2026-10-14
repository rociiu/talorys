import type { AutomationKind } from "@talorys/shared";
import type { Database } from "../db/database";
import { tableExists } from "./migrations";

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
