import { describe, expect, it, vi } from "vitest";
import { format, translate } from "../src/lib/i18n/core";

// A partial Korean translation, so the fallback stays covered once ko.ts is complete.
vi.mock("../src/lib/i18n/ko", () => ({ ko: { "login.unlock": "잠금 해제" } }));

describe("English fallback", () => {
  it("returns the Korean message for a translated key", () => {
    expect(translate("ko", "ko", "login.unlock")).toBe("잠금 해제");
  });

  it("returns the English message for a key the translation does not have", () => {
    expect(translate("ko", "ko", "login.password")).toBe("Password");
    expect(format("ko", "ko", "login.notConfigured", { command: "talorys" })).toEqual(format("en", "en", "login.notConfigured", { command: "talorys" }));
  });

  it("formats a fallen-back message with the active language's plural rules and number locale", () => {
    // Korean has only the "other" category, so a count of 1 does not pick the English "one" form.
    expect(translate("en", "en", "memory.olderKept", { count: 1 })).toBe("the older version was kept as history");
    expect(translate("ko", "ko", "memory.olderKept", { count: 1 })).toBe("1 older versions were kept as history");
    expect(translate("ko", "de-DE", "memory.olderKept", { count: 1500 })).toBe("1.500 older versions were kept as history");
  });
});
