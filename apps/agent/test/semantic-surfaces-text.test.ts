import { describe, expect, it, vi } from "vitest";
import { inAgent } from "./helpers";
import { invalidateSemanticCache } from "../src/semantic";
import { DEFAULT_SEMANTIC_CONFIG, deleteSemanticConfig } from "../src/semantic/config";
import { MockEmbedder, contentHash } from "../src/semantic/embeddings";
import type { IndexerContext } from "../src/semantic/indexer";
import { dropSemanticData } from "../src/semantic/migrations";
import {
  NOTE_CHUNK_CHARS,
  NOTE_MAX_CHUNKS,
  NOTE_SPLIT_CHARS,
  automationText,
  chunkNote,
  itemSourceStamp,
  noteParts,
} from "../src/semantic/itemText";
import {
  runItemPass,
} from "../src/semantic/itemIndex";
import {
  taskText,
} from "../src/semantic/itemText";

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

  it("TXT-auto: automation text is the name plus a message the name does not already contain", () => {
    const base = { name: "Take Lipitor" };
    expect(automationText({ ...base, message: " Take Lipitor " })).toBe("Take Lipitor");
    expect(automationText({ ...base, message: "take  LIPITOR" })).toBe("Take Lipitor");
    expect(automationText({ ...base, message: "Lipitor" })).toBe("Take Lipitor");
    expect(automationText({ ...base, message: "" })).toBe("Take Lipitor");
    expect(automationText({ ...base, message: " With dinner " })).toBe("Take Lipitor\nWith dinner");
    expect(automationText({ ...base, message: "m".repeat(1200) })).toBe(`Take Lipitor\n${"m".repeat(1000)}`);
    expect(automationText({ name: "  ", message: "Water the ferns" })).toBe("Water the ferns");
  });

  it("HUB-h: the bins reminder embeds as its name alone", () => {
    const name = "Every Thursday 7 PM: remind me to put the bins out";
    expect(automationText({ name, message: name })).toBe("Every Thursday 7 PM: remind me to put the bins out");
    expect(automationText({ name, message: "Put the bins out" })).toBe("Every Thursday 7 PM: remind me to put the bins out");
  });

  it("HUB-h: a stored automation vector from the previous text shape re-embeds once", async () => {
    await inAgent(async (a) => {
      const s = a.services;
      dropSemanticData(s.db);
      deleteSemanticConfig(s.settings);
      invalidateSemanticCache(s);
      for (const table of ["tal_tasks", "tal_notes", "tal_automations"]) s.db.run(`DELETE FROM ${table}`);
      const name = "Every Thursday 7 PM: remind me to put the bins out";
      const bins = s.automationsRepo.create({ name, kind: "reminder", message: name, schedule: { type: "weekly", days: [4], time: "19:00" }, enabled: true });
      const embedder = new MockEmbedder();
      const embed = vi.spyOn(embedder, "embed");
      const ctx: IndexerContext = { db: s.db, embedder, config: { ...DEFAULT_SEMANTIC_CONFIG, enabled: true, maxEmbeddingsPerDay: 10_000 } };
      expect(await runItemPass(ctx)).toMatchObject({ embedded: 1, pending: 0 });
      expect(embed.mock.calls.at(-1)![0]).toEqual([name]);

      // Put the row back the way the previous text shape stored it.
      const updatedAt = s.automationsRepo.require(bins.id).updated_at;
      const oldText = `Reminder: ${name}\nSchedule: Every Thursday at 19:00`;
      s.db.run(
        `UPDATE tal_semantic_item_vectors SET content_hash = ?, source_updated_at = ? WHERE item_type = 'automation' AND item_id = ?`,
        await contentHash(oldText),
        `v1:${updatedAt}`,
        bins.id,
      );
      embed.mockClear();

      expect(await runItemPass(ctx)).toMatchObject({ embedded: 1, pending: 0 });
      expect(embed.mock.calls.flatMap((c) => c[0])).toEqual([name]);
      const stored = s.db.one<{ s: string }>(`SELECT source_updated_at AS s FROM tal_semantic_item_vectors WHERE item_type = 'automation' AND item_id = ?`, bins.id);
      expect(stored?.s).toBe(itemSourceStamp("automation", updatedAt));

      embed.mockClear();
      expect(await runItemPass(ctx)).toMatchObject({ embedded: 0, pending: 0 });
      expect(embed).not.toHaveBeenCalled();
    });
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
