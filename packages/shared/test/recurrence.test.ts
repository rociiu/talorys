import { describe, expect, it } from "vitest";
import { computeNextRun, describeSchedule, upcomingRuns, scheduleSpecSchema, zonedTimeToUtc, getZonedParts, isValidCalendarDate } from "../src/recurrence";

const NY = "America/New_York";

describe("zonedTimeToUtc", () => {
  it("converts ordinary wall times", () => {
    expect(zonedTimeToUtc(2026, 7, 1, 9, 0, NY).toISOString()).toBe("2026-07-01T13:00:00.000Z"); // EDT -4
    expect(zonedTimeToUtc(2026, 1, 15, 9, 0, NY).toISOString()).toBe("2026-01-15T14:00:00.000Z"); // EST -5
    expect(zonedTimeToUtc(2026, 1, 15, 9, 0, "Asia/Tokyo").toISOString()).toBe("2026-01-15T00:00:00.000Z");
  });

  it("moves non-existent times (spring forward) past the gap", () => {
    // 2026-03-08 02:30 does not exist in New York; it runs at 03:30 EDT.
    const t = zonedTimeToUtc(2026, 3, 8, 2, 30, NY);
    expect(t.toISOString()).toBe("2026-03-08T07:30:00.000Z");
    expect(getZonedParts(t, NY)).toMatchObject({ hour: 3, minute: 30 });
  });

  it("uses the first occurrence for ambiguous times (fall back)", () => {
    // 2026-11-01 01:30 happens twice; the earlier (EDT) instant wins.
    expect(zonedTimeToUtc(2026, 11, 1, 1, 30, NY).toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });
});

describe("computeNextRun", () => {
  it("daily schedules keep their wall-clock time across DST", () => {
    const spec = { type: "daily", time: "09:00" } as const;
    const before = computeNextRun(spec, NY, new Date("2026-03-07T15:00:00Z"))!; // after 9am EST on Mar 7
    expect(before.toISOString()).toBe("2026-03-08T13:00:00.000Z"); // 9am EDT on Mar 8
    const after = computeNextRun(spec, NY, before)!;
    expect(after.toISOString()).toBe("2026-03-09T13:00:00.000Z");
  });

  it("weekly schedules pick the next matching weekday", () => {
    // 2026-10-09 is a Friday.
    const next = computeNextRun({ type: "weekly", days: [5], time: "17:00" }, "UTC", new Date("2026-10-09T18:00:00Z"))!;
    expect(next.toISOString()).toBe("2026-10-16T17:00:00.000Z");
    const same = computeNextRun({ type: "weekly", days: [5], time: "17:00" }, "UTC", new Date("2026-10-09T08:00:00Z"))!;
    expect(same.toISOString()).toBe("2026-10-09T17:00:00.000Z");
  });

  it("monthly schedules clamp to the last day of short months", () => {
    const next = computeNextRun({ type: "monthly", day: 31, time: "08:00" }, "UTC", new Date("2027-02-01T00:00:00Z"))!;
    expect(next.toISOString()).toBe("2027-02-28T08:00:00.000Z");
  });

  it("one-time schedules fire once and then never again", () => {
    const spec = { type: "once", at: "2026-12-24T18:00" } as const;
    const first = computeNextRun(spec, "Europe/Berlin", new Date("2026-12-01T00:00:00Z"))!;
    expect(first.toISOString()).toBe("2026-12-24T17:00:00.000Z");
    expect(computeNextRun(spec, "Europe/Berlin", first)).toBeNull();
  });

  it("interval schedules add minutes", () => {
    expect(computeNextRun({ type: "interval", minutes: 90 }, "UTC", new Date("2026-01-01T00:00:00Z"))!.toISOString()).toBe("2026-01-01T01:30:00.000Z");
  });

  it("validates specs", () => {
    expect(scheduleSpecSchema.safeParse({ type: "interval", minutes: 5 }).success).toBe(false);
    expect(scheduleSpecSchema.safeParse({ type: "daily", time: "25:00" }).success).toBe(false);
    expect(scheduleSpecSchema.safeParse({ type: "weekly", days: [], time: "09:00" }).success).toBe(false);
    expect(scheduleSpecSchema.safeParse({ type: "once", at: "2026-02-31T09:00" }).success).toBe(false);
    expect(scheduleSpecSchema.safeParse({ type: "once", at: "2026-02-29T09:00" }).success).toBe(false);
    expect(scheduleSpecSchema.safeParse({ type: "once", at: "2028-02-29T09:00" }).success).toBe(true);
    expect(describeSchedule({ type: "weekly", days: [1, 3], time: "09:00" })).toBe("Every Monday and Wednesday at 09:00");
  });
});

describe("isValidCalendarDate", () => {
  it("rejects non-existent calendar dates like Feb 31", () => {
    expect(isValidCalendarDate(2026, 2, 31)).toBe(false);
    expect(isValidCalendarDate(2026, 4, 31)).toBe(false);
    expect(isValidCalendarDate(2026, 2, 29)).toBe(false); // 2026 is not a leap year
    expect(isValidCalendarDate(2026, 13, 1)).toBe(false);
    expect(isValidCalendarDate(2026, 0, 1)).toBe(false);
  });

  it("handles leap years correctly", () => {
    expect(isValidCalendarDate(2024, 2, 29)).toBe(true);
    expect(isValidCalendarDate(2028, 2, 29)).toBe(true);
    expect(isValidCalendarDate(2000, 2, 29)).toBe(true); // 400-year leap rule
    expect(isValidCalendarDate(1900, 2, 29)).toBe(false); // 100-year non-leap rule
  });

  it("rejects non-integer dates", () => {
    expect(isValidCalendarDate(2026.5, 5, 10)).toBe(false);
    expect(isValidCalendarDate(2026, 5.5, 10)).toBe(false);
    expect(isValidCalendarDate(2026, 5, 10.5)).toBe(false);
    expect(isValidCalendarDate(Number.NaN, 5, 10)).toBe(false);
    expect(isValidCalendarDate(2026, Number.NaN, 10)).toBe(false);
    expect(isValidCalendarDate(2026, 5, Number.NaN)).toBe(false);
  });

  it("handles 0-99 years accurately without 1900 remapping", () => {
    expect(isValidCalendarDate(0, 2, 29)).toBe(true); // year 0 is a leap year (divisible by 400)
    expect(isValidCalendarDate(1, 2, 29)).toBe(false); // year 1 is not a leap year
    expect(isValidCalendarDate(4, 2, 29)).toBe(true); // year 4 is a leap year
    expect(isValidCalendarDate(99, 12, 31)).toBe(true);
    expect(zonedTimeToUtc(1, 1, 1, 9, 0, "UTC").toISOString()).toBe("0001-01-01T09:00:00.000Z");
    expect(scheduleSpecSchema.safeParse({ type: "once", at: "0000-02-29T10:00" }).success).toBe(true);
    expect(scheduleSpecSchema.safeParse({ type: "once", at: "0001-02-29T10:00" }).success).toBe(false);
  });
});


describe("describeSchedule", () => {
  it("lists each weekday once, in week order, even when the rule repeats a day", () => {
    expect(describeSchedule({ type: "weekly", days: [3, 1, 1], time: "09:00" })).toBe("Every Monday and Wednesday at 09:00");
  });

  it("does not call a repeated weekday 'every day'", () => {
    expect(describeSchedule({ type: "weekly", days: [1, 1, 1, 1, 1, 1, 1], time: "09:00" })).toBe("Every Monday at 09:00");
    expect(describeSchedule({ type: "weekly", days: [0, 1, 2, 3, 4, 5, 6], time: "09:00" })).toBe("Every day at 09:00");
  });

  it("says when a monthly day falls back to the last day of shorter months", () => {
    expect(describeSchedule({ type: "monthly", day: 28, time: "09:00" })).toBe("Monthly on the 28th at 09:00");
    expect(describeSchedule({ type: "monthly", day: 29, time: "09:00" })).toBe("Monthly on the 29th at 09:00, or the last day of shorter months");
    expect(describeSchedule({ type: "monthly", day: 31, time: "09:00" })).toBe("Monthly on the 31st at 09:00, or the last day of shorter months");
  });

  it("names common day sets and reads naturally", () => {
    expect(describeSchedule({ type: "weekly", days: [5, 1, 3], time: "08:30" })).toBe("Every Monday, Wednesday and Friday at 08:30");
    expect(describeSchedule({ type: "weekly", days: [1, 2, 3, 4, 5], time: "09:00" })).toBe("Every weekday at 09:00");
    expect(describeSchedule({ type: "weekly", days: [6, 0], time: "10:00" })).toBe("Every weekend day at 10:00");
    expect(describeSchedule({ type: "monthly", day: 1, time: "09:00" })).toBe("Monthly on the 1st at 09:00");
    expect(describeSchedule({ type: "monthly", day: 22, time: "09:00" })).toBe("Monthly on the 22nd at 09:00");
    expect(describeSchedule({ type: "monthly", day: 13, time: "09:00" })).toBe("Monthly on the 13th at 09:00");
    expect(describeSchedule({ type: "interval", minutes: 60 })).toBe("Every hour");
    expect(describeSchedule({ type: "interval", minutes: 180 })).toBe("Every 3 hours");
    expect(describeSchedule({ type: "interval", minutes: 90 })).toBe("Every 1 h 30 min");
    expect(describeSchedule({ type: "interval", minutes: 2880 })).toBe("Every 2 days");
  });
});

describe("upcomingRuns", () => {
  it("lists consecutive occurrences and stops when a one-off is done", () => {
    const after = new Date("2026-03-02T00:00:00Z"); // Monday
    const runs = upcomingRuns({ type: "weekly", days: [1, 3], time: "09:00" }, "UTC", after, 3);
    expect(runs.map((d) => d.toISOString())).toEqual([
      "2026-03-02T09:00:00.000Z", "2026-03-04T09:00:00.000Z", "2026-03-09T09:00:00.000Z",
    ]);
    expect(upcomingRuns({ type: "once", at: "2026-03-05T10:00" }, "UTC", after, 3)).toHaveLength(1);
  });
});
