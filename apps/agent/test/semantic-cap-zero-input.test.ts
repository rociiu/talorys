import { describe, expect, it } from "vitest";
import { isValidCap } from "../../web/src/components/semanticCaps";

const sources = import.meta.glob("../../web/src/components/SemanticRecallCard.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const card = Object.values(sources)[0] ?? "";

describe("Settings cap inputs accept 0", () => {
  it("CZ1: isValidCap accepts integers 0 to 10,000 and nothing else", () => {
    for (const n of [0, 1, 10_000]) expect(isValidCap(n)).toBe(true);
    for (const n of [-1, 10_001, 1.5, Number.NaN]) expect(isValidCap(n)).toBe(false);
  });

  it("CZ1: both cap inputs have min 0 and none keeps min 1", () => {
    expect(card).not.toBe("");
    expect(card).not.toContain("min={1}");
    expect(card.match(/min=\{0\}/g)).toHaveLength(2);
  });
});
