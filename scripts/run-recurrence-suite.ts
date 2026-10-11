import assert from "node:assert/strict";
import { MassiveTestHarness, type TestCase } from "./massive-harness";
import {
  computeNextRun,
  describeSchedule,
  getZonedParts,
  isValidCalendarDate,
  isValidTimeZone,
  scheduleSpecSchema,
  timeZoneOffsetMs,
  zonedTimeToUtc,
  type ScheduleSpec,
} from "../packages/shared/src/recurrence";

const harness = new MassiveTestHarness("recurrence-engine");
const tests: TestCase[] = [];

// ============================================================================
// 1. NORMAL (70 tests): Daily, Weekly, Monthly, Interval, Once, Helpers
// ============================================================================

// 1.1 Daily normal (15 tests)
const dailyTimes = [
  "00:00", "01:15", "04:30", "06:00", "08:30",
  "09:00", "11:45", "12:00", "14:15", "16:30",
  "18:00", "20:00", "21:30", "23:00", "23:59",
];
dailyTimes.forEach((time, idx) => {
  tests.push({
    id: `rec-normal-daily-${String(idx + 1).padStart(3, "0")}`,
    domain: "recurrence",
    category: "normal",
    description: `Daily schedule at ${time} in UTC calculates correct next run`,
    run: () => {
      const spec: ScheduleSpec = { type: "daily", time };
      const after = new Date("2026-06-01T00:00:00.000Z");
      const next = computeNextRun(spec, "UTC", after);
      assert.ok(next !== null, "Next run should not be null");
      const [h, m] = time.split(":").map(Number);
      const expectedDate = (h === 0 && m === 0) ? "2026-06-02" : "2026-06-01";
      const expectedIso = `${expectedDate}T${time}:00.000Z`;
      assert.strictEqual(next.toISOString(), expectedIso);
    },
  });
});

// 1.2 Weekly normal (20 tests)
const weekDays = [
  { day: 0, name: "Sunday" },
  { day: 1, name: "Monday" },
  { day: 2, name: "Tuesday" },
  { day: 3, name: "Wednesday" },
  { day: 4, name: "Thursday" },
  { day: 5, name: "Friday" },
  { day: 6, name: "Saturday" },
];
// 2026-10-12 is a Monday (weekday 1)
weekDays.forEach(({ day, name }, idx) => {
  tests.push({
    id: `rec-normal-weekly-single-${String(idx + 1).padStart(3, "0")}`,
    domain: "recurrence",
    category: "normal",
    description: `Weekly schedule on ${name} at 10:00 picks correct day`,
    run: () => {
      const spec: ScheduleSpec = { type: "weekly", days: [day], time: "10:00" };
      const after = new Date("2026-10-12T00:00:00.000Z"); // Monday
      const next = computeNextRun(spec, "UTC", after);
      assert.ok(next !== null);
      const parts = getZonedParts(next, "UTC");
      assert.strictEqual(parts.weekday, day);
      assert.strictEqual(parts.hour, 10);
      assert.strictEqual(parts.minute, 0);
    },
  });
});

const multiDayConfigs = [
  { days: [1, 3, 5], label: "Mon/Wed/Fri", start: "2026-10-12T11:00:00Z", expDay: 3 }, // after Mon 10:00 -> Wed
  { days: [1, 3, 5], label: "Mon/Wed/Fri same day", start: "2026-10-12T08:00:00Z", expDay: 1 }, // before Mon 10:00 -> Mon
  { days: [0, 6], label: "Weekends", start: "2026-10-12T00:00:00Z", expDay: 6 }, // Mon -> Sat
  { days: [1, 2, 3, 4, 5], label: "Weekdays", start: "2026-10-16T12:00:00Z", expDay: 1 }, // Fri after 10am -> next Mon
  { days: [0, 1, 2, 3, 4, 5, 6], label: "All 7 days", start: "2026-10-12T11:00:00Z", expDay: 2 }, // Mon -> Tue
  { days: [2, 4], label: "Tue/Thu", start: "2026-10-12T00:00:00Z", expDay: 2 },
  { days: [2, 4], label: "Tue/Thu from Tue after", start: "2026-10-13T11:00:00Z", expDay: 4 },
  { days: [6], label: "Sat only from Sun", start: "2026-10-11T00:00:00Z", expDay: 6 },
  { days: [0], label: "Sun only from Sat", start: "2026-10-10T00:00:00Z", expDay: 0 },
  { days: [3], label: "Wed only from Thu", start: "2026-10-15T00:00:00Z", expDay: 3 },
  { days: [1, 5], label: "Mon/Fri from Wed", start: "2026-10-14T00:00:00Z", expDay: 5 },
  { days: [2, 3], label: "Tue/Wed from Wed after", start: "2026-10-14T11:00:00Z", expDay: 2 },
  { days: [4, 5, 6], label: "Thu/Fri/Sat from Sun", start: "2026-10-11T00:00:00Z", expDay: 4 },
];
multiDayConfigs.forEach(({ days, label, start, expDay }, idx) => {
  tests.push({
    id: `rec-normal-weekly-multi-${String(idx + 1).padStart(3, "0")}`,
    domain: "recurrence",
    category: "normal",
    description: `Weekly schedule (${label}) picks expected next weekday (${expDay})`,
    run: () => {
      const spec: ScheduleSpec = { type: "weekly", days, time: "10:00" };
      const next = computeNextRun(spec, "UTC", new Date(start));
      assert.ok(next !== null);
      const parts = getZonedParts(next, "UTC");
      assert.strictEqual(parts.weekday, expDay);
    },
  });
});

// 1.3 Monthly normal (15 tests)
const monthlyDays = [1, 2, 5, 8, 10, 12, 15, 18, 20, 22, 25, 26, 27, 28, 15];
monthlyDays.forEach((day, idx) => {
  tests.push({
    id: `rec-normal-monthly-${String(idx + 1).padStart(3, "0")}`,
    domain: "recurrence",
    category: "normal",
    description: `Monthly schedule on day ${day} at 09:00 calculates next occurrence`,
    run: () => {
      const spec: ScheduleSpec = { type: "monthly", day, time: "09:00" };
      const after = new Date("2026-03-01T00:00:00.000Z");
      const next = computeNextRun(spec, "UTC", after);
      assert.ok(next !== null);
      const p = getZonedParts(next, "UTC");
      assert.strictEqual(p.month, 3);
      assert.strictEqual(p.day, day);
      assert.strictEqual(p.hour, 9);
      assert.strictEqual(p.minute, 0);
    },
  });
});

// 1.4 Interval normal (10 tests)
const intervals = [15, 20, 30, 45, 60, 90, 120, 360, 720, 1440];
intervals.forEach((minutes, idx) => {
  tests.push({
    id: `rec-normal-interval-${String(idx + 1).padStart(3, "0")}`,
    domain: "recurrence",
    category: "normal",
    description: `Interval schedule of ${minutes}m adds exact milliseconds`,
    run: () => {
      const spec: ScheduleSpec = { type: "interval", minutes };
      const base = new Date("2026-05-10T12:00:00.000Z");
      const next = computeNextRun(spec, "UTC", base);
      assert.ok(next !== null);
      assert.strictEqual(next.getTime(), base.getTime() + minutes * 60_000);
    },
  });
});

// 1.5 Once normal (5 tests)
const onceDates = [
  "2026-06-01T08:00",
  "2026-07-15T12:30",
  "2026-08-20T18:45",
  "2026-11-10T09:15",
  "2026-12-31T23:59",
];
onceDates.forEach((at, idx) => {
  tests.push({
    id: `rec-normal-once-${String(idx + 1).padStart(3, "0")}`,
    domain: "recurrence",
    category: "normal",
    description: `Once schedule at ${at} fires once and then returns null`,
    run: () => {
      const spec: ScheduleSpec = { type: "once", at };
      const before = new Date("2026-01-01T00:00:00.000Z");
      const first = computeNextRun(spec, "UTC", before);
      assert.ok(first !== null);
      const second = computeNextRun(spec, "UTC", first);
      assert.strictEqual(second, null);
    },
  });
});

// 1.6 Describe schedule normal (5 tests)
tests.push(
  {
    id: "rec-normal-describe-001",
    domain: "recurrence",
    category: "normal",
    description: "describeSchedule formats once schedule correctly",
    run: () => {
      assert.strictEqual(describeSchedule({ type: "once", at: "2026-12-25T09:00" }), "Once at 2026-12-25 09:00");
    },
  },
  {
    id: "rec-normal-describe-002",
    domain: "recurrence",
    category: "normal",
    description: "describeSchedule formats daily schedule correctly",
    run: () => {
      assert.strictEqual(describeSchedule({ type: "daily", time: "14:30" }), "Every day at 14:30");
    },
  },
  {
    id: "rec-normal-describe-003",
    domain: "recurrence",
    category: "normal",
    description: "describeSchedule formats weekly schedule correctly",
    run: () => {
      assert.strictEqual(describeSchedule({ type: "weekly", days: [1, 3], time: "09:00" }), "Every Monday, Wednesday at 09:00");
    },
  },
  {
    id: "rec-normal-describe-004",
    domain: "recurrence",
    category: "normal",
    description: "describeSchedule formats monthly schedule correctly",
    run: () => {
      assert.strictEqual(describeSchedule({ type: "monthly", day: 15, time: "18:00" }), "Monthly on day 15 at 18:00");
    },
  },
  {
    id: "rec-normal-describe-005",
    domain: "recurrence",
    category: "normal",
    description: "describeSchedule formats interval schedule correctly",
    run: () => {
      assert.strictEqual(describeSchedule({ type: "interval", minutes: 120 }), "Every 2 hour(s)");
      assert.strictEqual(describeSchedule({ type: "interval", minutes: 45 }), "Every 45 minutes");
    },
  },
);

// ============================================================================
// 2. BOUNDARY (60 tests): Leap years, Month-end clamping, DST gap/overlap, Limits
// ============================================================================

// 2.1 Leap years and Century rules (20 tests)
const leapYearCases = [
  // 400-year leap years
  { y: 1600, m: 2, d: 29, expected: true, label: "400-year leap 1600" },
  { y: 2000, m: 2, d: 29, expected: true, label: "400-year leap 2000" },
  { y: 2400, m: 2, d: 29, expected: true, label: "400-year leap 2400" },
  // 100-year common years
  { y: 1700, m: 2, d: 29, expected: false, label: "100-year non-leap 1700" },
  { y: 1800, m: 2, d: 29, expected: false, label: "100-year non-leap 1800" },
  { y: 1900, m: 2, d: 29, expected: false, label: "100-year non-leap 1900" },
  { y: 2100, m: 2, d: 29, expected: false, label: "100-year non-leap 2100" },
  { y: 2200, m: 2, d: 29, expected: false, label: "100-year non-leap 2200" },
  { y: 2300, m: 2, d: 29, expected: false, label: "100-year non-leap 2300" },
  { y: 2500, m: 2, d: 29, expected: false, label: "100-year non-leap 2500" },
  // 4-year leap years
  { y: 2020, m: 2, d: 29, expected: true, label: "4-year leap 2020" },
  { y: 2024, m: 2, d: 29, expected: true, label: "4-year leap 2024" },
  { y: 2028, m: 2, d: 29, expected: true, label: "4-year leap 2028" },
  { y: 2032, m: 2, d: 29, expected: true, label: "4-year leap 2032" },
  // Non-leap years
  { y: 2021, m: 2, d: 29, expected: false, label: "non-leap 2021" },
  { y: 2022, m: 2, d: 29, expected: false, label: "non-leap 2022" },
  { y: 2023, m: 2, d: 29, expected: false, label: "non-leap 2023" },
  { y: 2025, m: 2, d: 29, expected: false, label: "non-leap 2025" },
  { y: 2026, m: 2, d: 29, expected: false, label: "non-leap 2026" },
  { y: 2027, m: 2, d: 29, expected: false, label: "non-leap 2027" },
];
leapYearCases.forEach(({ y, m, d, expected, label }, idx) => {
  tests.push({
    id: `rec-boundary-leap-${String(idx + 1).padStart(3, "0")}`,
    domain: "recurrence",
    category: "boundary",
    description: `isValidCalendarDate checks ${label} (Feb 29 = ${expected})`,
    run: () => {
      assert.strictEqual(isValidCalendarDate(y, m, d), expected);
    },
  });
});

// 2.2 Month-end clamping (15 tests)
const monthEndCases = [
  // Day 31 clamped in short months
  { month: 2, year: 2026, expDay: 28, label: "Feb in non-leap year clamps day 31 to 28" },
  { month: 2, year: 2024, expDay: 29, label: "Feb in leap year clamps day 31 to 29" },
  { month: 4, year: 2026, expDay: 30, label: "April clamps day 31 to 30" },
  { month: 6, year: 2026, expDay: 30, label: "June clamps day 31 to 30" },
  { month: 9, year: 2026, expDay: 30, label: "September clamps day 31 to 30" },
  { month: 11, year: 2026, expDay: 30, label: "November clamps day 31 to 30" },
  // Day 31 preserved in 31-day months
  { month: 1, year: 2026, expDay: 31, label: "January retains day 31" },
  { month: 3, year: 2026, expDay: 31, label: "March retains day 31" },
  { month: 5, year: 2026, expDay: 31, label: "May retains day 31" },
  { month: 7, year: 2026, expDay: 31, label: "July retains day 31" },
  { month: 8, year: 2026, expDay: 31, label: "August retains day 31" },
  { month: 10, year: 2026, expDay: 31, label: "October retains day 31" },
  { month: 12, year: 2026, expDay: 31, label: "December retains day 31" },
  // Day 30 clamped in February
  { month: 2, year: 2026, daySpec: 30, expDay: 28, label: "Feb clamps day 30 to 28 in non-leap" },
  { month: 2, year: 2024, daySpec: 30, expDay: 29, label: "Feb clamps day 30 to 29 in leap" },
];
monthEndCases.forEach(({ month, year, expDay, daySpec = 31, label }, idx) => {
  tests.push({
    id: `rec-boundary-monthend-${String(idx + 1).padStart(3, "0")}`,
    domain: "recurrence",
    category: "boundary",
    description: `Monthly clamp: ${label}`,
    run: () => {
      const spec: ScheduleSpec = { type: "monthly", day: daySpec, time: "12:00" };
      const after = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
      const next = computeNextRun(spec, "UTC", after);
      assert.ok(next !== null);
      const p = getZonedParts(next, "UTC");
      assert.strictEqual(p.month, month);
      assert.strictEqual(p.day, expDay);
    },
  });
});

// 2.3 DST Transition Gap (10 tests)
const dstGapCases = [
  { tz: "America/New_York", y: 2026, m: 3, d: 8, h: 2, mi: 30, expH: 3, expMi: 30, label: "NY 02:30 -> 03:30 EDT" },
  { tz: "America/New_York", y: 2026, m: 3, d: 8, h: 2, mi: 0, expH: 3, expMi: 0, label: "NY 02:00 -> 03:00 EDT" },
  { tz: "America/New_York", y: 2026, m: 3, d: 8, h: 2, mi: 59, expH: 3, expMi: 59, label: "NY 02:59 -> 03:59 EDT" },
  { tz: "America/Chicago", y: 2026, m: 3, d: 8, h: 2, mi: 30, expH: 3, expMi: 30, label: "Chicago 02:30 -> 03:30 CDT" },
  { tz: "America/Los_Angeles", y: 2026, m: 3, d: 8, h: 2, mi: 30, expH: 3, expMi: 30, label: "LA 02:30 -> 03:30 PDT" },
  { tz: "Europe/London", y: 2026, m: 3, d: 29, h: 1, mi: 30, expH: 2, expMi: 30, label: "London 01:30 -> 02:30 BST" },
  { tz: "Europe/Paris", y: 2026, m: 3, d: 29, h: 2, mi: 30, expH: 3, expMi: 30, label: "Paris 02:30 -> 03:30 CEST" },
  { tz: "Europe/Berlin", y: 2026, m: 3, d: 29, h: 2, mi: 15, expH: 3, expMi: 15, label: "Berlin 02:15 -> 03:15 CEST" },
  { tz: "Australia/Sydney", y: 2026, m: 10, d: 4, h: 2, mi: 30, expH: 3, expMi: 30, label: "Sydney 02:30 -> 03:30 AEDT" },
  { tz: "Australia/Lord_Howe", y: 2026, m: 10, d: 4, h: 2, mi: 15, expH: 2, expMi: 45, label: "Lord Howe 02:15 -> 02:45 (30m gap)" },
];
dstGapCases.forEach(({ tz, y, m, d, h, mi, expH, expMi, label }, idx) => {
  tests.push({
    id: `rec-boundary-dstgap-${String(idx + 1).padStart(3, "0")}`,
    domain: "recurrence",
    category: "boundary",
    description: `DST Spring Forward gap: ${label}`,
    run: () => {
      const utc = zonedTimeToUtc(y, m, d, h, mi, tz);
      const parts = getZonedParts(utc, tz);
      assert.strictEqual(parts.hour, expH);
      assert.strictEqual(parts.minute, expMi);
    },
  });
});

// 2.4 DST Transition Overlap / Fall Back (8 tests)
const dstOverlapCases = [
  { tz: "America/New_York", y: 2026, m: 11, d: 1, h: 1, mi: 30, expIso: "2026-11-01T05:30:00.000Z", label: "NY 01:30 EDT earlier instant" },
  { tz: "America/Chicago", y: 2026, m: 11, d: 1, h: 1, mi: 30, expIso: "2026-11-01T06:30:00.000Z", label: "Chicago 01:30 CDT earlier instant" },
  { tz: "America/Los_Angeles", y: 2026, m: 11, d: 1, h: 1, mi: 30, expIso: "2026-11-01T08:30:00.000Z", label: "LA 01:30 PDT earlier instant" },
  { tz: "Europe/London", y: 2026, m: 10, d: 25, h: 1, mi: 30, expIso: "2026-10-25T00:30:00.000Z", label: "London 01:30 BST earlier instant" },
  { tz: "Europe/Paris", y: 2026, m: 10, d: 25, h: 2, mi: 30, expIso: "2026-10-25T00:30:00.000Z", label: "Paris 02:30 CEST earlier instant" },
  { tz: "Europe/Berlin", y: 2026, m: 10, d: 25, h: 2, mi: 30, expIso: "2026-10-25T00:30:00.000Z", label: "Berlin 02:30 CEST earlier instant" },
  { tz: "Australia/Sydney", y: 2026, m: 4, d: 5, h: 2, mi: 30, expIso: "2026-04-04T15:30:00.000Z", label: "Sydney 02:30 AEDT earlier instant" },
  { tz: "Australia/Lord_Howe", y: 2026, m: 4, d: 5, h: 1, mi: 45, expIso: "2026-04-04T14:45:00.000Z", label: "Lord Howe 01:45 earlier instant" },
];
dstOverlapCases.forEach(({ tz, y, m, d, h, mi, expIso, label }, idx) => {
  tests.push({
    id: `rec-boundary-dstoverlap-${String(idx + 1).padStart(3, "0")}`,
    domain: "recurrence",
    category: "boundary",
    description: `DST Fall Back overlap: ${label}`,
    run: () => {
      const utc = zonedTimeToUtc(y, m, d, h, mi, tz);
      assert.strictEqual(utc.toISOString(), expIso);
    },
  });
});

// 2.5 Extreme intervals & date boundaries (7 tests)
tests.push(
  {
    id: "rec-boundary-limits-001",
    domain: "recurrence",
    category: "boundary",
    description: "Interval minimum allowed (15 minutes)",
    run: () => {
      const parsed = scheduleSpecSchema.safeParse({ type: "interval", minutes: 15 });
      assert.strictEqual(parsed.success, true);
    },
  },
  {
    id: "rec-boundary-limits-002",
    domain: "recurrence",
    category: "boundary",
    description: "Interval maximum allowed (44640 minutes = 31 days)",
    run: () => {
      const parsed = scheduleSpecSchema.safeParse({ type: "interval", minutes: 60 * 24 * 31 });
      assert.strictEqual(parsed.success, true);
    },
  },
  {
    id: "rec-boundary-limits-003",
    domain: "recurrence",
    category: "boundary",
    description: "Year-end boundary transition from 2026-12-31 to 2027-01-01",
    run: () => {
      const spec: ScheduleSpec = { type: "daily", time: "00:00" };
      const after = new Date("2026-12-31T23:50:00.000Z");
      const next = computeNextRun(spec, "UTC", after);
      assert.ok(next !== null);
      assert.strictEqual(next.toISOString(), "2027-01-01T00:00:00.000Z");
    },
  },
  {
    id: "rec-boundary-limits-004",
    domain: "recurrence",
    category: "boundary",
    description: "Midnight exact boundary: after is 00:00:00.000Z",
    run: () => {
      const spec: ScheduleSpec = { type: "daily", time: "00:00" };
      const after = new Date("2026-05-01T00:00:00.000Z");
      const next = computeNextRun(spec, "UTC", after);
      assert.ok(next !== null);
      assert.strictEqual(next.toISOString(), "2026-05-02T00:00:00.000Z");
    },
  },
  {
    id: "rec-boundary-limits-005",
    domain: "recurrence",
    category: "boundary",
    description: "Sub-second millisecond boundary: 23:59:59.999Z to next day 00:00:00.000Z",
    run: () => {
      const spec: ScheduleSpec = { type: "daily", time: "00:00" };
      const after = new Date("2026-05-01T23:59:59.999Z");
      const next = computeNextRun(spec, "UTC", after);
      assert.ok(next !== null);
      assert.strictEqual(next.toISOString(), "2026-05-02T00:00:00.000Z");
    },
  },
  {
    id: "rec-boundary-limits-006",
    domain: "recurrence",
    category: "boundary",
    description: "Monthly schedule on day 1 from previous month last millisecond",
    run: () => {
      const spec: ScheduleSpec = { type: "monthly", day: 1, time: "00:00" };
      const after = new Date("2026-04-30T23:59:59.999Z");
      const next = computeNextRun(spec, "UTC", after);
      assert.ok(next !== null);
      assert.strictEqual(next.toISOString(), "2026-05-01T00:00:00.000Z");
    },
  },
  {
    id: "rec-boundary-limits-007",
    domain: "recurrence",
    category: "boundary",
    description: "Weekly schedule 400-day loop covers leap years correctly",
    run: () => {
      const spec: ScheduleSpec = { type: "weekly", days: [1], time: "12:00" };
      const after = new Date("2024-02-28T00:00:00.000Z");
      const next = computeNextRun(spec, "UTC", after);
      assert.ok(next !== null);
      const parts = getZonedParts(next, "UTC");
      assert.strictEqual(parts.weekday, 1);
    },
  },
);

// ============================================================================
// 3. FAILURE (50 tests): Invalid formats, 25:00, 60min, Negative intervals, Bad dates
// ============================================================================

// 3.1 Invalid daily time formats (10 tests)
const invalidDailyTimes = [
  "24:00", "25:00", "99:00", "-01:00", "12:60",
  "12:99", "9:00", "09:0", "abc", "",
];
invalidDailyTimes.forEach((time, idx) => {
  tests.push({
    id: `rec-failure-daily-${String(idx + 1).padStart(3, "0")}`,
    domain: "recurrence",
    category: "failure",
    description: `Reject invalid daily time: "${time}"`,
    run: () => {
      const res = scheduleSpecSchema.safeParse({ type: "daily", time });
      assert.strictEqual(res.success, false);
    },
  });
});

// 3.2 Invalid weekly parameters (10 tests)
const invalidWeeklySpecs = [
  { days: [], time: "09:00", desc: "empty days array" },
  { days: [-1], time: "09:00", desc: "negative day" },
  { days: [7], time: "09:00", desc: "day 7 out of 0..6" },
  { days: [100], time: "09:00", desc: "day 100 out of bounds" },
  { days: [1.5], time: "09:00", desc: "non-integer day" },
  { days: [0, 1, 2, 3, 4, 5, 6, 7], time: "09:00", desc: "more than 7 items" },
  { days: ["1" as any], time: "09:00", desc: "string instead of number" },
  { days: [1], time: "25:00", desc: "invalid time 25:00" },
  { days: [1], time: "12:60", desc: "invalid time 12:60" },
  { days: [null as any], time: "09:00", desc: "null in days array" },
];
invalidWeeklySpecs.forEach(({ days, time, desc }, idx) => {
  tests.push({
    id: `rec-failure-weekly-${String(idx + 1).padStart(3, "0")}`,
    domain: "recurrence",
    category: "failure",
    description: `Reject invalid weekly: ${desc}`,
    run: () => {
      const res = scheduleSpecSchema.safeParse({ type: "weekly", days, time });
      assert.strictEqual(res.success, false);
    },
  });
});

// 3.3 Invalid monthly parameters (10 tests)
const invalidMonthlySpecs = [
  { day: 0, time: "09:00", desc: "day 0" },
  { day: 32, time: "09:00", desc: "day 32" },
  { day: -1, time: "09:00", desc: "day -1" },
  { day: 100, time: "09:00", desc: "day 100" },
  { day: 1.5, time: "09:00", desc: "non-integer day" },
  { day: "15" as any, time: "09:00", desc: "string day" },
  { day: 15, time: "24:00", desc: "time 24:00" },
  { day: 15, time: "12:60", desc: "time 12:60" },
  { day: 15, time: "abc", desc: "time abc" },
  { day: null as any, time: "09:00", desc: "null day" },
];
invalidMonthlySpecs.forEach(({ day, time, desc }, idx) => {
  tests.push({
    id: `rec-failure-monthly-${String(idx + 1).padStart(3, "0")}`,
    domain: "recurrence",
    category: "failure",
    description: `Reject invalid monthly: ${desc}`,
    run: () => {
      const res = scheduleSpecSchema.safeParse({ type: "monthly", day, time });
      assert.strictEqual(res.success, false);
    },
  });
});

// 3.4 Invalid interval minutes (10 tests)
const invalidIntervalMinutes = [
  14, 0, -1, -15, -60,
  60 * 24 * 31 + 1, 15.5, NaN, Infinity, -Infinity,
];
invalidIntervalMinutes.forEach((minutes, idx) => {
  tests.push({
    id: `rec-failure-interval-${String(idx + 1).padStart(3, "0")}`,
    domain: "recurrence",
    category: "failure",
    description: `Reject invalid interval minutes: ${minutes}`,
    run: () => {
      const res = scheduleSpecSchema.safeParse({ type: "interval", minutes });
      assert.strictEqual(res.success, false);
    },
  });
});

// 3.5 Invalid once date formats & calendar dates (10 tests)
const invalidOnceAts = [
  { at: "2026-02-31T10:00", desc: "2026-02-31 (Feb 31 does not exist)" },
  { at: "2026-02-29T10:00", desc: "2026-02-29 (Feb 29 in non-leap year)" },
  { at: "2026-04-31T10:00", desc: "2026-04-31 (April has 30 days)" },
  { at: "2026-06-31T10:00", desc: "2026-06-31 (June has 30 days)" },
  { at: "2026-09-31T10:00", desc: "2026-09-31 (September has 30 days)" },
  { at: "2026-11-31T10:00", desc: "2026-11-31 (November has 30 days)" },
  { at: "2026-13-01T10:00", desc: "2026-13-01 (Month 13 does not exist)" },
  { at: "2026-00-10T10:00", desc: "2026-00-10 (Month 0 does not exist)" },
  { at: "2026-01-32T10:00", desc: "2026-01-32 (Day 32 does not exist)" },
  { at: "2026-01-01T25:00", desc: "2026-01-01T25:00 (Hour 25 does not exist)" },
];
invalidOnceAts.forEach(({ at, desc }, idx) => {
  tests.push({
    id: `rec-failure-once-${String(idx + 1).padStart(3, "0")}`,
    domain: "recurrence",
    category: "failure",
    description: `Reject invalid once date/time: ${desc}`,
    run: () => {
      const res = scheduleSpecSchema.safeParse({ type: "once", at });
      assert.strictEqual(res.success, false);
    },
  });
});

// ============================================================================
// 4. CONCURRENCY & IMMUTABILITY (40 tests)
// ============================================================================

// 4.1 Immutability of inputs (15 tests)
tests.push(
  {
    id: "rec-concurrency-immut-001",
    domain: "recurrence",
    category: "concurrency",
    description: "computeNextRun does not mutate frozen ScheduleSpec (daily)",
    run: () => {
      const spec = Object.freeze({ type: "daily" as const, time: "10:00" });
      const after = new Date("2026-06-01T00:00:00Z");
      const next = computeNextRun(spec, "UTC", after);
      assert.ok(next !== null);
      assert.strictEqual(spec.time, "10:00");
    },
  },
  {
    id: "rec-concurrency-immut-002",
    domain: "recurrence",
    category: "concurrency",
    description: "computeNextRun does not mutate frozen ScheduleSpec (weekly)",
    run: () => {
      const spec = Object.freeze({ type: "weekly" as const, days: Object.freeze([1, 3, 5]) as any, time: "10:00" });
      const after = new Date("2026-06-01T00:00:00Z");
      const next = computeNextRun(spec, "UTC", after);
      assert.ok(next !== null);
      assert.deepStrictEqual([...spec.days], [1, 3, 5]);
    },
  },
  {
    id: "rec-concurrency-immut-003",
    domain: "recurrence",
    category: "concurrency",
    description: "computeNextRun does not mutate frozen ScheduleSpec (monthly)",
    run: () => {
      const spec = Object.freeze({ type: "monthly" as const, day: 31, time: "10:00" });
      const after = new Date("2026-06-01T00:00:00Z");
      const next = computeNextRun(spec, "UTC", after);
      assert.ok(next !== null);
      assert.strictEqual(spec.day, 31);
    },
  },
  {
    id: "rec-concurrency-immut-004",
    domain: "recurrence",
    category: "concurrency",
    description: "computeNextRun does not mutate frozen ScheduleSpec (interval)",
    run: () => {
      const spec = Object.freeze({ type: "interval" as const, minutes: 45 });
      const after = new Date("2026-06-01T00:00:00Z");
      const next = computeNextRun(spec, "UTC", after);
      assert.ok(next !== null);
      assert.strictEqual(spec.minutes, 45);
    },
  },
  {
    id: "rec-concurrency-immut-005",
    domain: "recurrence",
    category: "concurrency",
    description: "computeNextRun does not mutate after Date object",
    run: () => {
      const spec: ScheduleSpec = { type: "daily", time: "10:00" };
      const after = new Date("2026-06-01T12:00:00.000Z");
      const originalTime = after.getTime();
      computeNextRun(spec, "UTC", after);
      assert.strictEqual(after.getTime(), originalTime);
    },
  },
  {
    id: "rec-concurrency-immut-006",
    domain: "recurrence",
    category: "concurrency",
    description: "describeSchedule does not mutate weekly days array order",
    run: () => {
      const days = [5, 1, 3];
      const spec: ScheduleSpec = { type: "weekly", days, time: "09:00" };
      describeSchedule(spec);
      assert.deepStrictEqual(days, [5, 1, 3], "Original days array must not be sorted in-place");
    },
  },
  {
    id: "rec-concurrency-immut-007",
    domain: "recurrence",
    category: "concurrency",
    description: "getZonedParts does not mutate input Date object",
    run: () => {
      const d = new Date("2026-07-04T15:30:45.123Z");
      const orig = d.getTime();
      getZonedParts(d, "America/New_York");
      assert.strictEqual(d.getTime(), orig);
    },
  },
  {
    id: "rec-concurrency-immut-008",
    domain: "recurrence",
    category: "concurrency",
    description: "timeZoneOffsetMs does not mutate timestamp argument",
    run: () => {
      const t = 1760000000000;
      timeZoneOffsetMs(t, "Asia/Seoul");
      assert.strictEqual(t, 1760000000000);
    },
  },
  {
    id: "rec-concurrency-immut-009",
    domain: "recurrence",
    category: "concurrency",
    description: "computeNextRun returns new Date instances on repeated calls",
    run: () => {
      const spec: ScheduleSpec = { type: "daily", time: "09:00" };
      const after = new Date("2026-06-01T00:00:00Z");
      const d1 = computeNextRun(spec, "UTC", after);
      const d2 = computeNextRun(spec, "UTC", after);
      assert.ok(d1 !== null && d2 !== null);
      assert.notStrictEqual(d1, d2, "Must return separate Date instances");
      assert.strictEqual(d1.getTime(), d2.getTime());
    },
  },
  {
    id: "rec-concurrency-immut-010",
    domain: "recurrence",
    category: "concurrency",
    description: "Mutating returned Date does not affect future computeNextRun calls",
    run: () => {
      const spec: ScheduleSpec = { type: "daily", time: "09:00" };
      const after = new Date("2026-06-01T00:00:00Z");
      const d1 = computeNextRun(spec, "UTC", after)!;
      d1.setFullYear(2099);
      const d2 = computeNextRun(spec, "UTC", after)!;
      assert.strictEqual(d2.getUTCFullYear(), 2026);
    },
  },
  {
    id: "rec-concurrency-immut-011",
    domain: "recurrence",
    category: "concurrency",
    description: "zonedTimeToUtc returns new Date instance each time",
    run: () => {
      const d1 = zonedTimeToUtc(2026, 6, 1, 10, 0, "UTC");
      const d2 = zonedTimeToUtc(2026, 6, 1, 10, 0, "UTC");
      assert.notStrictEqual(d1, d2);
      assert.strictEqual(d1.getTime(), d2.getTime());
    },
  },
  {
    id: "rec-concurrency-immut-012",
    domain: "recurrence",
    category: "concurrency",
    description: "describeSchedule result is deterministic across calls",
    run: () => {
      const spec: ScheduleSpec = { type: "weekly", days: [2, 4], time: "11:00" };
      const s1 = describeSchedule(spec);
      const s2 = describeSchedule(spec);
      assert.strictEqual(s1, s2);
    },
  },
  {
    id: "rec-concurrency-immut-013",
    domain: "recurrence",
    category: "concurrency",
    description: "getZonedParts returns independent object every time",
    run: () => {
      const d = new Date("2026-01-01T00:00:00Z");
      const p1 = getZonedParts(d, "UTC");
      const p2 = getZonedParts(d, "UTC");
      assert.notStrictEqual(p1, p2);
      p1.hour = 99;
      assert.strictEqual(p2.hour, 0);
    },
  },
  {
    id: "rec-concurrency-immut-014",
    domain: "recurrence",
    category: "concurrency",
    description: "scheduleSpecSchema parsing does not mutate input object",
    run: () => {
      const input = { type: "daily", time: "09:00" };
      scheduleSpecSchema.parse(input);
      assert.deepStrictEqual(input, { type: "daily", time: "09:00" });
    },
  },
  {
    id: "rec-concurrency-immut-015",
    domain: "recurrence",
    category: "concurrency",
    description: "isValidCalendarDate does not mutate arguments or state",
    run: () => {
      const y = 2024, m = 2, d = 29;
      assert.strictEqual(isValidCalendarDate(y, m, d), true);
      assert.strictEqual(y, 2024);
      assert.strictEqual(m, 2);
      assert.strictEqual(d, 29);
    },
  },
);

// 4.2 Parallel / Async concurrency execution (15 tests)
tests.push(
  {
    id: "rec-concurrency-async-001",
    domain: "recurrence",
    category: "concurrency",
    description: "50 parallel computeNextRun calls on same spec/tz yield identical results",
    run: async () => {
      const spec: ScheduleSpec = { type: "daily", time: "15:00" };
      const after = new Date("2026-07-01T08:00:00.000Z");
      const promises = Array.from({ length: 50 }, () =>
        Promise.resolve().then(() => computeNextRun(spec, "America/New_York", after)),
      );
      const results = await Promise.all(promises);
      const firstIso = results[0]?.toISOString();
      assert.ok(firstIso);
      for (const res of results) {
        assert.strictEqual(res?.toISOString(), firstIso);
      }
    },
  },
  {
    id: "rec-concurrency-async-002",
    domain: "recurrence",
    category: "concurrency",
    description: "Parallel execution across 10 distinct IANA timezones concurrently",
    run: async () => {
      const timezones = [
        "UTC", "Asia/Tokyo", "Europe/London", "America/New_York",
        "America/Los_Angeles", "Australia/Sydney", "Asia/Kolkata",
        "Pacific/Auckland", "America/Sao_Paulo", "Africa/Cairo",
      ];
      const spec: ScheduleSpec = { type: "daily", time: "12:00" };
      const after = new Date("2026-06-01T00:00:00Z");
      const promises = timezones.map(async (tz) => {
        const next = computeNextRun(spec, tz, after);
        assert.ok(next !== null);
        const p = getZonedParts(next, tz);
        assert.strictEqual(p.hour, 12);
        assert.strictEqual(p.minute, 0);
      });
      await Promise.all(promises);
    },
  },
  {
    id: "rec-concurrency-async-003",
    domain: "recurrence",
    category: "concurrency",
    description: "Parallel execution of mixed schedule types concurrently",
    run: async () => {
      const specs: ScheduleSpec[] = [
        { type: "daily", time: "08:00" },
        { type: "weekly", days: [1, 5], time: "09:00" },
        { type: "monthly", day: 15, time: "10:00" },
        { type: "interval", minutes: 30 },
        { type: "once", at: "2026-10-31T20:00" },
      ];
      const after = new Date("2026-06-01T00:00:00Z");
      const promises = specs.map(async (spec) => {
        const next = computeNextRun(spec, "UTC", after);
        assert.ok(next !== null);
      });
      await Promise.all(promises);
    },
  },
);

for (let i = 4; i <= 15; i++) {
  tests.push({
    id: `rec-concurrency-async-${String(i).padStart(3, "0")}`,
    domain: "recurrence",
    category: "concurrency",
    description: `Concurrent batch stress test run #${i}`,
    run: async () => {
      const spec: ScheduleSpec = { type: "interval", minutes: 15 * (i % 4 + 1) };
      const base = new Date("2026-06-01T00:00:00Z");
      const calls = Array.from({ length: 20 }, (_, idx) =>
        Promise.resolve().then(() => computeNextRun(spec, "UTC", new Date(base.getTime() + idx * 60_000))),
      );
      const res = await Promise.all(calls);
      assert.strictEqual(res.length, 20);
      res.forEach((r, idx) => {
        assert.strictEqual(r?.getTime(), base.getTime() + idx * 60_000 + spec.minutes * 60_000);
      });
    },
  });
}

// 4.3 Formatter Cache isolation and integrity (10 tests)
tests.push(
  {
    id: "rec-concurrency-cache-001",
    domain: "recurrence",
    category: "concurrency",
    description: "Repeated getZonedParts calls reuse formatter without error",
    run: () => {
      const d = new Date("2026-06-01T12:00:00Z");
      for (let i = 0; i < 100; i++) {
        const parts = getZonedParts(d, "America/New_York");
        assert.strictEqual(parts.hour, 8);
      }
    },
  },
  {
    id: "rec-concurrency-cache-002",
    domain: "recurrence",
    category: "concurrency",
    description: "Rapidly alternating between timezones does not mix parts",
    run: () => {
      const d = new Date("2026-01-01T00:00:00Z");
      for (let i = 0; i < 50; i++) {
        const pTokyo = getZonedParts(d, "Asia/Tokyo");
        const pLondon = getZonedParts(d, "Europe/London");
        assert.strictEqual(pTokyo.hour, 9);
        assert.strictEqual(pLondon.hour, 0);
      }
    },
  },
);

for (let i = 3; i <= 10; i++) {
  tests.push({
    id: `rec-concurrency-cache-${String(i).padStart(3, "0")}`,
    domain: "recurrence",
    category: "concurrency",
    description: `Cache isolation check #${i} across distinct timezones`,
    run: () => {
      const tzList = ["UTC", "Asia/Seoul", "America/Chicago", "Pacific/Honolulu"];
      const tz = tzList[i % tzList.length]!;
      const d = new Date(1760000000000 + i * 1000000);
      const p1 = getZonedParts(d, tz);
      const p2 = getZonedParts(d, tz);
      assert.deepStrictEqual(p1, p2);
    },
  });
}

// ============================================================================
// 5. RECOVERY & DEFECT REPRODUCTION (30 tests)
// ============================================================================

// 5.1 Invalid Timezone Recovery (10 tests)
const invalidTzs = [
  "Invalid/Timezone", "Mars/Olympus", "GMT+99", "America/NonExistent",
  "", "   ", "UTC+25", "123", "Null", "undefined",
];
invalidTzs.forEach((tz, idx) => {
  tests.push({
    id: `rec-recovery-tz-${String(idx + 1).padStart(3, "0")}`,
    domain: "recurrence",
    category: "recovery",
    description: `isValidTimeZone correctly identifies invalid timezone: "${tz}"`,
    run: () => {
      assert.strictEqual(isValidTimeZone(tz), false);
    },
  });
});

// 5.2 computeNextRun unknown timezone fallback/recovery (8 tests)
const fallbackTzs = [
  "Invalid/Timezone", "Foo/Bar", "", "   ",
  "America/Nowhere", "UTC+99", "BadZone", "Fake/Zone",
];
fallbackTzs.forEach((tz, idx) => {
  tests.push({
    id: `rec-recovery-compute-tz-${String(idx + 1).padStart(3, "0")}`,
    domain: "recurrence",
    category: "recovery",
    description: `computeNextRun returns null safely for unknown timezone: "${tz}"`,
    run: () => {
      const spec: ScheduleSpec = { type: "daily", time: "09:00" };
      const next = computeNextRun(spec, tz, new Date());
      assert.strictEqual(next, null, "Must safely return null instead of throwing RangeError");
    },
  });
});

// 5.3 computeNextRun malformed spec recovery (5 tests)
const malformedSpecs = [
  { spec: null as any, desc: "null spec" },
  { spec: undefined as any, desc: "undefined spec" },
  { spec: {} as any, desc: "empty object spec" },
  { spec: { type: "unknown" } as any, desc: "unknown spec type" },
  { spec: { type: "daily", time: "25:00" } as any, desc: "invalid time 25:00" },
];
malformedSpecs.forEach(({ spec, desc }, idx) => {
  tests.push({
    id: `rec-recovery-spec-${String(idx + 1).padStart(3, "0")}`,
    domain: "recurrence",
    category: "recovery",
    description: `computeNextRun returns null safely for malformed spec: ${desc}`,
    run: () => {
      const next = computeNextRun(spec, "UTC", new Date());
      assert.strictEqual(next, null, "Must safely return null on malformed spec");
    },
  });
});

// 5.4 computeNextRun invalid date recovery (3 tests)
tests.push(
  {
    id: "rec-recovery-date-001",
    domain: "recurrence",
    category: "recovery",
    description: "computeNextRun returns null safely for Invalid Date object",
    run: () => {
      const spec: ScheduleSpec = { type: "daily", time: "09:00" };
      const next = computeNextRun(spec, "UTC", new Date("invalid"));
      assert.strictEqual(next, null);
    },
  },
  {
    id: "rec-recovery-date-002",
    domain: "recurrence",
    category: "recovery",
    description: "computeNextRun returns null safely when after is null",
    run: () => {
      const spec: ScheduleSpec = { type: "daily", time: "09:00" };
      const next = computeNextRun(spec, "UTC", null as any);
      assert.strictEqual(next, null);
    },
  },
  {
    id: "rec-recovery-date-003",
    domain: "recurrence",
    category: "recovery",
    description: "computeNextRun returns null safely when after is undefined",
    run: () => {
      const spec: ScheduleSpec = { type: "daily", time: "09:00" };
      const next = computeNextRun(spec, "UTC", undefined as any);
      assert.strictEqual(next, null);
    },
  },
);

// 5.5 Defect Reproductions: Calendar dates, Timezone undefined, Describe weekly duplicates (4 tests)
tests.push(
  {
    id: "rec-recovery-defect-001",
    domain: "recurrence",
    category: "recovery",
    description: "isValidCalendarDate must reject non-integer day or month (e.g. 27.5, 2.5)",
    run: () => {
      assert.strictEqual(isValidCalendarDate(2026, 2, 27.5), false, "Float day 27.5 must be rejected");
      assert.strictEqual(isValidCalendarDate(2026, 2.5, 10), false, "Float month 2.5 must be rejected");
      assert.strictEqual(isValidCalendarDate(2026.5, 2, 10), false, "Float year 2026.5 must be rejected");
    },
  },
  {
    id: "rec-recovery-defect-002",
    domain: "recurrence",
    category: "recovery",
    description: "isValidTimeZone must reject undefined and null rather than using system default",
    run: () => {
      assert.strictEqual(isValidTimeZone(undefined as any), false, "undefined timezone must be false");
      assert.strictEqual(isValidTimeZone(null as any), false, "null timezone must be false");
    },
  },
  {
    id: "rec-recovery-defect-003",
    domain: "recurrence",
    category: "recovery",
    description: "describeSchedule handles duplicate days without saying 'Every day' when not all 7 days present",
    run: () => {
      // 7 repeated Mondays is NOT every day
      const spec: ScheduleSpec = { type: "weekly", days: [1, 1, 1, 1, 1, 1, 1], time: "09:00" };
      const desc = describeSchedule(spec);
      assert.strictEqual(desc, "Every Monday at 09:00", "7 duplicate Mondays must describe Monday, not 'Every day'");
    },
  },
  {
    id: "rec-recovery-defect-004",
    domain: "recurrence",
    category: "recovery",
    description: "describeSchedule deduplicates repeated days and sorts properly",
    run: () => {
      const spec: ScheduleSpec = { type: "weekly", days: [1, 1, 3], time: "09:00" };
      const desc = describeSchedule(spec);
      assert.strictEqual(desc, "Every Monday, Wednesday at 09:00", "Duplicate days must be deduplicated");
    },
  },
);

// ============================================================================
// Add all tests and run
// ============================================================================
harness.addAll(tests);

async function main() {
  const report = await harness.run({
    outputJsonPath: "test-results/recurrence-results.json",
    verbose: true,
  });

  if (report.failed > 0 || report.errored > 0) {
    console.error(`\n[Suite] FAILED: ${report.failed} failed, ${report.errored} errored.`);
    process.exit(1);
  } else {
    console.log(`\n[Suite] SUCCESS: All ${report.total} tests passed!`);
  }
}

main().catch((err) => {
  console.error("Fatal test suite runner error:", err);
  process.exit(1);
});
