import { describe, expect, it } from "vitest";

const sources = import.meta.glob("../../web/src/components/SemanticRecallCard.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const card = Object.values(sources)[0] ?? "";

describe("semantic recall Settings hint", () => {
  it("R3: the hint names the item cap apart from the memory cap and the leftover comment is gone", () => {
    expect(card).not.toBe("");
    const hint = card.split("\n").find((line) => line.includes('label="Semantic memory recall" hint='));
    expect(hint).toBeDefined();
    expect(card).toContain("s?.items?.items_cap ?? DEFAULT_ITEM_CAP");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: matching the JSX source text literally
    expect(hint).toContain("Memories use up to ${savedCap} embeddings per day; tasks, notes and reminders have their own ${itemCap} per day.");
    expect(card).not.toContain("{/* At the default cap");
  });
});
