import { describe, expect, it } from "vitest";
import {
  AUTOMATION_KIND_LABELS,
  NOTE_CHUNK_CHARS,
  NOTE_MAX_CHUNKS,
  NOTE_SPLIT_CHARS,
  automationText,
  chunkNote,
  noteParts,
  taskText,
} from "../src/semantic/surfaces";

/** A paragraph of exactly `length` characters that starts with `tag`. */
function paragraph(tag: string, length: number): string {
  return `${tag} ${"lorem ipsum ".repeat(Math.ceil(length / 12))}`.slice(0, length);
}

describe("surface embedded text", () => {
  it("TXT-task: task text is the title plus at most 1,000 description chars", () => {
    expect(taskText({ title: "Water the plants", description: null })).toBe("Task: Water the plants");
    expect(taskText({ title: "Water the plants", description: "   " })).toBe("Task: Water the plants");
    expect(taskText({ title: "Water the plants", description: "Ferns first" })).toBe("Task: Water the plants\nFerns first");
    const long = "d".repeat(1500);
    expect(taskText({ title: "T", description: long })).toBe(`Task: T\n${"d".repeat(1000)}`);
  });

  it("TXT-auto: automation text has the kind label, a distinct message and the schedule", () => {
    const base = { kind: "reminder" as const, name: "Take Lipitor", schedule_description: "Every day at 21:00" };
    expect(automationText({ ...base, message: " Take Lipitor " })).toBe("Reminder: Take Lipitor\nSchedule: Every day at 21:00");
    expect(automationText({ ...base, message: "" })).toBe("Reminder: Take Lipitor\nSchedule: Every day at 21:00");
    expect(automationText({ ...base, message: "With dinner" })).toBe("Reminder: Take Lipitor\nWith dinner\nSchedule: Every day at 21:00");
    expect(automationText({ ...base, message: "m".repeat(1200) })).toBe(`Reminder: Take Lipitor\n${"m".repeat(1000)}\nSchedule: Every day at 21:00`);
    expect(AUTOMATION_KIND_LABELS).toEqual({ reminder: "Reminder", task_digest: "Task digest", agent_prompt: "Scheduled AI prompt" });
    expect(automationText({ ...base, kind: "task_digest", message: "" })).toMatch(/^Task digest: /);
    expect(automationText({ ...base, kind: "agent_prompt", message: "" })).toMatch(/^Scheduled AI prompt: /);
  });
});

describe("note parts and chunking", () => {
  it("CH-short: a note up to the split size is the title row plus one body row", () => {
    const content = `${paragraph("first", 1000)}\n\n${paragraph("second", 891)}`;
    expect(content.length).toBe(1893);
    const parts = noteParts({ title: "Trip", content });
    expect(parts).toEqual([
      { text: "Note: Trip", body: null },
      { text: `Trip: ${content}`, body: content },
    ]);
    expect(noteParts({ title: "Empty", content: "  \n " })).toEqual([{ text: "Note: Empty", body: null }]);
    const exact = "a".repeat(NOTE_SPLIT_CHARS);
    expect(noteParts({ title: "Exact", content: exact })).toHaveLength(2);
    expect(noteParts({ title: "Over", content: "a".repeat(NOTE_SPLIT_CHARS + 1) }).length).toBeGreaterThan(2);
  });

  it("CH-long: a long note splits at blank lines into chunks of at most 1,200 chars", () => {
    const paragraphs = Array.from({ length: 9 }, (_, i) => paragraph(`[para-${i}]`, i === 8 ? 1184 : 1100));
    const content = paragraphs.join("\n\n");
    expect(content.length).toBe(10_000);
    const parts = noteParts({ title: "Plan", content });
    expect(parts).toHaveLength(10);
    expect(parts[0]).toEqual({ text: "Note: Plan", body: null });
    parts.slice(1).forEach((part, i) => {
      expect(part.body).toBe(paragraphs[i]);
      expect(part.body!.length).toBeLessThanOrEqual(NOTE_CHUNK_CHARS);
      expect(part.text).toBe(`Plan: ${paragraphs[i]}`);
    });
    // Windows line endings still count as blank lines.
    expect(chunkNote(paragraphs.join("\r\n\r\n"))).toEqual(paragraphs);
  });

  it("CH-cap: a 60,000-char note yields exactly 40 chunks and drops later text", () => {
    const paragraphs = Array.from({ length: 60 }, (_, i) => paragraph(`[para-${i}]`, 998));
    const content = paragraphs.join("\n\n");
    expect(content.length).toBeGreaterThanOrEqual(59_990);
    const parts = noteParts({ title: "Journal", content });
    expect(parts).toHaveLength(1 + NOTE_MAX_CHUNKS);
    expect(parts.some((p) => p.text.includes("[para-50]"))).toBe(false);
    expect(parts[NOTE_MAX_CHUNKS]!.body).toContain("[para-39]");
  });

  it("CH-sentence: a long paragraph splits at sentence ends, then hard-splits", () => {
    const sentences = Array.from({ length: 30 }, (_, i) => `Sentence ${String(i).padStart(2, "0")} ${"word ".repeat(17)}end.`);
    const long = `${sentences.join(" ").slice(0, 2999)}z`;
    expect(long.length).toBe(3000);
    const chunks = chunkNote(long);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.length).toBeLessThanOrEqual(NOTE_CHUNK_CHARS);
      expect(chunk.endsWith(".")).toBe(true);
    }
    expect(chunks.join(" ")).toBe(long);

    const run = "x".repeat(3000);
    expect(chunkNote(run)).toEqual(["x".repeat(1200), "x".repeat(1200), "x".repeat(600)]);
  });
});
