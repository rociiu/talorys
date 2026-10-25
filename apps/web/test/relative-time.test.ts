import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "../src/lib/i18n/core";
import { relativeTime } from "../src/lib/utils";

const NOW = new Date("2026-06-15T12:00:00.000Z");
const i18n = (locale: string) =>
  ({ locale, t: (key: "time.justNow" | "time.inAMoment") => translate("en", locale, key) }) as Parameters<typeof relativeTime>[1];

describe("relative time rounding", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rounds a time in the past the same way as the same span ahead", () => {
    const en = i18n("en");
    expect(relativeTime(new Date(NOW.getTime() - 90 * 60_000).toISOString(), en)).toBe("2 hours ago");
    expect(relativeTime(new Date(NOW.getTime() + 90 * 60_000).toISOString(), en)).toBe("in 2 hours");
    expect(relativeTime(new Date(NOW.getTime() - 36 * 3600_000).toISOString(), en)).toBe("2 days ago");
    expect(relativeTime(new Date(NOW.getTime() + 36 * 3600_000).toISOString(), en)).toBe("in 2 days");
  });

  it("still calls exactly one day ago yesterday", () => {
    expect(relativeTime(new Date(NOW.getTime() - 86400_000).toISOString(), i18n("en"))).toBe("yesterday");
    expect(relativeTime(new Date(NOW.getTime() + 86400_000).toISOString(), i18n("en"))).toBe("tomorrow");
  });
});
