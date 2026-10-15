import type { Automation, Note, Task } from "@talorys/shared";
import { estimateTokens } from "../ai/provider";
import { memoryLine } from "../agent/prompt";
import type { PromptMemory } from "../memory/service";
import { presentTask } from "../tools/tasks";
import type { ItemType } from "./itemStore";
import { type SemanticContext, peekQueryVector } from "./recall";
import { type ItemHit, NOTE_SPLIT_CHARS, noteParts, scanItemVectors } from "./surfaces";

/** Most task, note and automation lines one turn recalls. */
export const MAX_RECALLED_ITEMS = 3;
/** Longest note excerpt in a recalled line. */
export const ITEM_LINE_EXCERPT_CHARS = 160;

const TYPE_ORDER: Record<ItemType, number> = { task: 0, note: 1, automation: 2 };

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** `- [task] {title} (due {due}; id {id})`, without the due part when there is no due date. */
export function taskLine(task: Task, timezone: string): string {
  const due = presentTask(task, timezone).due;
  return `- [task] ${oneLine(task.title)} (${due ? `due ${oneLine(due)}; ` : ""}id ${task.id})`;
}

/**
 * `- [note] {title}: {excerpt} (id {id})`. The excerpt is the best matching chunk of a split note,
 * otherwise the start of the content; a note without content gets no excerpt.
 */
export function noteLine(note: Note, part: number): string {
  const chunk = part > 0 && note.content.length > NOTE_SPLIT_CHARS ? noteParts(note)[part]?.body : null;
  const excerpt = oneLine(chunk ?? note.content).slice(0, ITEM_LINE_EXCERPT_CHARS).trim();
  return excerpt ? `- [note] ${oneLine(note.title)}: ${excerpt} (id ${note.id})` : `- [note] ${oneLine(note.title)} (id ${note.id})`;
}

/** `- [reminder] {name} ({schedule}; id {id})`, or `[automation]` for any other kind. */
export function automationLine(automation: Automation): string {
  const label = automation.kind === "reminder" ? "reminder" : "automation";
  return `- [${label}] ${oneLine(automation.name)} (${oneLine(automation.schedule_description)}; id ${automation.id})`;
}

/**
 * Up to MAX_RECALLED_ITEMS task, note and automation lines for the owner message, best first,
 * scored with the vector memory recall already embedded for it this turn. Never embeds or
 * reserves: without that vector it returns nothing. Only hits the surface floors keep count;
 * done tasks, completed automations and items gone since indexing are skipped.
 */
export function selectSemanticItems(ctx: SemanticContext, message: string): string[] {
  const vector = peekQueryVector(ctx, message);
  if (!vector) return [];
  const hits: (ItemHit & { type: ItemType })[] = [];
  for (const type of ["task", "note", "automation"] as const) {
    for (const hit of scanItemVectors(ctx, type, vector)) hits.push({ ...hit, type });
  }
  hits.sort((a, b) => b.cosine - a.cosine || TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const timezone = ctx.services.settings.get().timezone;
  const lines: string[] = [];
  for (const hit of hits) {
    if (lines.length >= MAX_RECALLED_ITEMS) break;
    const line = itemLine(ctx, hit, timezone);
    if (line) lines.push(line);
  }
  return lines;
}

/**
 * The leading item lines that fit in what `budget` leaves after the memory lines the prompt
 * already lists, so item lines are dropped before any memory line.
 */
export function fitItemLines(lines: string[], memories: PromptMemory[], budget: number): string[] {
  let used = memories.reduce((sum, m) => sum + estimateTokens(memoryLine(m)), 0);
  const kept: string[] = [];
  for (const line of lines) {
    const cost = estimateTokens(line);
    if (used + cost > budget) break;
    used += cost;
    kept.push(line);
  }
  return kept;
}

function itemLine(ctx: SemanticContext, hit: ItemHit & { type: ItemType }, timezone: string): string | null {
  const { services } = ctx;
  if (hit.type === "task") {
    const task = services.tasks.get(hit.id);
    return task && task.status !== "done" ? taskLine(task, timezone) : null;
  }
  if (hit.type === "note") {
    const note = services.notes.get(hit.id);
    return note ? noteLine(note, hit.part) : null;
  }
  const automation = services.automations.get(hit.id);
  return automation && automation.status !== "completed" ? automationLine(automation) : null;
}
