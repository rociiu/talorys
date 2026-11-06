import { describe, expect, it } from "vitest";
import { isChunkLoadError, shouldAutoReload } from "../src/lib/chunkErrors";

const memoryStorage = () => {
  const items = new Map<string, string>();
  return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v) };
};

describe("isChunkLoadError", () => {
  it("recognizes each browser's wording for a missing page chunk", () => {
    for (const message of [
      "Failed to fetch dynamically imported module: https://x.pages.dev/assets/NotesPage-abc.js",
      "error loading dynamically imported module: https://x.pages.dev/assets/NotesPage-abc.js",
      "Importing a module script failed.",
      "Unable to preload CSS for /assets/index-abc.css",
    ]) {
      expect(isChunkLoadError(new Error(message)), message).toBe(true);
    }
  });

  it("leaves other failures alone", () => {
    expect(isChunkLoadError(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isChunkLoadError("Failed to fetch dynamically imported module")).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });
});

describe("shouldAutoReload", () => {
  it("allows one reload a minute, so a chunk that stays missing can't loop", () => {
    const storage = memoryStorage();
    expect(shouldAutoReload(storage, 1_000_000)).toBe(true);
    expect(shouldAutoReload(storage, 1_030_000)).toBe(false);
    expect(shouldAutoReload(storage, 1_061_000)).toBe(true);
  });

  it("does not reload when storage is unavailable, since it couldn't stop a loop", () => {
    const blocked = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {},
    };
    expect(shouldAutoReload(blocked)).toBe(false);
  });
});
