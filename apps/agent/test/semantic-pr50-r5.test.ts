import { describe, expect, it } from "vitest";
import * as database from "../src/db/database";
import { automationKeywordHits } from "../src/semantic/itemSearch";

const SAMPLES = [
  "Remind me to water the plants",
  "What did I say about the Lisbon trip trip?",
  "the and of",
  "",
  "Café crème, 2024 budget — budget review!",
  "one two three four five six seven eight nine ten",
];

describe("keyword terms", () => {
  it("R5: ftsQuery is built from exported ftsTerms and automationKeywordHits no longer parses its output", () => {
    const ftsTerms = (database as Record<string, unknown>).ftsTerms as ((q: string, maxTerms?: number) => string[]) | undefined;
    expect(typeof ftsTerms).toBe("function");
    for (const q of SAMPLES) {
      const terms = ftsTerms!(q);
      expect(database.ftsQuery(q)).toBe(terms.length ? terms.map((t) => `"${t}"*`).join(" OR ") : null);
    }
    expect(ftsTerms!("the and of")).toEqual([]);
    expect(automationKeywordHits.toString()).not.toContain("matchAll(");
  });
});
