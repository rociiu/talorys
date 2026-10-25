import { describe, expect, it } from "vitest";
import { tomorrowAt9 } from "../src/pages/AutomationsPage";

describe("default time for a new one-off reminder", () => {
  it("is 9:00 tomorrow in the timezone the schedule uses", () => {
    // 23:30 the previous evening in Los Angeles, and still the morning of the 14th in UTC.
    const now = new Date("2026-03-14T06:30:00.000Z");
    expect(tomorrowAt9("America/Los_Angeles", now)).toBe("2026-03-14T09:00");
    expect(tomorrowAt9("UTC", now)).toBe("2026-03-15T09:00");
  });

  it("stays on the next calendar day when a 24-hour jump would skip one", () => {
    // 23:30 the evening before the US spring-forward. 24 hours later is 00:30 two dates ahead.
    const now = new Date("2026-03-08T07:30:00.000Z");
    expect(tomorrowAt9("America/Los_Angeles", now)).toBe("2026-03-08T09:00");
  });
});
