import { describe, expect, it } from "vitest";
import { titleFromMessage } from "../src/agent/runner";
import { clip } from "../src/services/text";

const hasLoneSurrogate = (s: string) => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);

describe("truncating text for titles", () => {
  it("never splits an emoji at the cut", () => {
    const title = titleFromMessage(`${"a".repeat(59)}😀 and more words after it`);
    expect(hasLoneSurrogate(title)).toBe(false);
    expect(title).toBe(`${"a".repeat(59)}…`);
  });

  it("keeps an emoji that fits and leaves short messages alone", () => {
    expect(titleFromMessage(`${"a".repeat(58)}😀 tail that is long enough to cut`)).toContain("😀");
    expect(titleFromMessage("  Plan   the\ttrip  ")).toBe("Plan the trip");
  });

  it("clip counts UTF-16 units but backs off a split pair", () => {
    expect(clip("abc😀", 4)).toBe("abc");
    expect(clip("abc😀", 5)).toBe("abc😀");
    expect(clip("abc", 10)).toBe("abc");
  });

  it("does not leave a joiner when a family emoji is cut from a title", () => {
    const family = "👨‍👩‍👧";
    const title = titleFromMessage(`${"a".repeat(57)}${family} and more words after the cut`);
    expect(title).toBe(`${"a".repeat(57)}…`);
    expect(title).not.toMatch(/\u200d/);
    expect(clip(`abc${family}`, 4)).toBe("abc");
    expect(clip(`abc${family}`, 3 + family.length)).toBe(`abc${family}`);
  });
});
