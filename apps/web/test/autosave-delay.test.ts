import { describe, expect, it } from "vitest";
import { autosaveDelay } from "../src/pages/NotesPage";

describe("note autosave delay", () => {
  it("saves a second after typing stops when saves are working", () => {
    expect(autosaveDelay(0)).toBe(1000);
  });

  it("backs off while saves keep failing, up to a minute", () => {
    expect([1, 2, 3].map(autosaveDelay)).toEqual([2000, 4000, 8000]);
    expect(autosaveDelay(6)).toBe(60_000);
    expect(autosaveDelay(50)).toBe(60_000);
  });
});
