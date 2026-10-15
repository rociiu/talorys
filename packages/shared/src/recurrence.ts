import { z } from "zod";

/**
 * Timezone-aware recurrence rules. Wall-clock times are interpreted in the
 * owner's IANA timezone.
 *
 * Daylight-saving behaviour:
 *  - A wall time that does not exist (spring-forward gap) runs at the first
 *    valid instant after the gap, e.g. 02:30 becomes 03:30.
 *  - A wall time that occurs twice (fall-back overlap) runs once, at the
 *    earlier occurrence.
 */

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:MM (24h)");

/** True when year/month/day name a real calendar date (rejects e.g. 2026-02-31). */
export function isValidCalendarDate(year: number, month: number, day: number): boolean {
  return (
    Number.isInteger(year) &&
    Number.isInteger(month) &&
    Number.isInteger(day) &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month)
  );
}

export const scheduleSpecSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("once"),
    at: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/, "Expected YYYY-MM-DDTHH:MM local time")
      .refine((v) => {
        const [y, m, d] = v.slice(0, 10).split("-").map(Number);
        return isValidCalendarDate(y!, m!, d!);
      }, "Not a valid calendar date"),
  }),
  z.object({ type: z.literal("daily"), time: hhmm }),
  z.object({
    type: z.literal("weekly"),
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    time: hhmm,
  }),
  z.object({ type: z.literal("monthly"), day: z.number().int().min(1).max(31), time: hhmm }),
  z.object({ type: z.literal("interval"), minutes: z.number().int().min(15).max(60 * 24 * 31) }),
]);

export type ScheduleSpec = z.infer<typeof scheduleSpecSchema>;

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const parts: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(date)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS.indexOf(parts.weekday ?? "Sun"),
  };
}

/** Offset of `timeZone` from UTC at `instant`, in milliseconds. */
export function timeZoneOffsetMs(instant: number, timeZone: string): number {
  const p = getZonedParts(new Date(instant), timeZone);
  const d = new Date(0);
  d.setUTCFullYear(p.year, p.month - 1, p.day);
  d.setUTCHours(p.hour, p.minute, p.second, 0);
  const asUtc = d.getTime();
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** Converts a wall-clock time in `timeZone` to a UTC instant, applying the DST rules above. */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  d.setUTCHours(hour, minute, 0, 0);
  const wall = d.getTime();
  const before = timeZoneOffsetMs(wall - 36 * 3600_000, timeZone);
  const after = timeZoneOffsetMs(wall + 36 * 3600_000, timeZone);
  const candidates = [...new Set([wall - before, wall - after])]
    .filter((t) => {
      const p = getZonedParts(new Date(t), timeZone);
      return p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute;
    })
    .sort((a, b) => a - b);
  if (candidates.length > 0) return new Date(candidates[0]!);
  // Gap: apply the pre-transition offset, which lands just after the gap.
  return new Date(wall - before);
}

function parseTime(time: string): [number, number] {
  const [h, m] = time.split(":").map(Number);
  return [h!, m!];
}

function daysInMonth(year: number, month: number): number {
  const d = new Date(0);
  d.setUTCFullYear(year, month, 0);
  return d.getUTCDate();
}

/** Next run strictly after `after`, or null when the schedule will never fire again. */
export function computeNextRun(spec: ScheduleSpec, timeZone: string, after: Date): Date | null {
  if (spec.type === "interval") {
    return new Date(after.getTime() + spec.minutes * 60_000);
  }
  if (spec.type === "once") {
    const [datePart, timePart] = spec.at.split("T");
    const [y, mo, d] = datePart!.split("-").map(Number);
    const [h, mi] = parseTime(timePart!);
    const t = zonedTimeToUtc(y!, mo!, d!, h, mi, timeZone);
    return t.getTime() > after.getTime() ? t : null;
  }
  const [h, mi] = parseTime(spec.time);
  const start = getZonedParts(after, timeZone);
  // Walk local calendar days. 400 covers every monthly/weekly rule.
  const cursor = new Date(Date.UTC(start.year, start.month - 1, start.day));
  for (let i = 0; i < 400; i++) {
    const y = cursor.getUTCFullYear();
    const mo = cursor.getUTCMonth() + 1;
    const d = cursor.getUTCDate();
    const weekday = cursor.getUTCDay();
    let matches = false;
    if (spec.type === "daily") matches = true;
    else if (spec.type === "weekly") matches = spec.days.includes(weekday);
    else if (spec.type === "monthly") matches = d === Math.min(spec.day, daysInMonth(y, mo));
    if (matches) {
      const t = zonedTimeToUtc(y, mo, d, h, mi, timeZone);
      if (t.getTime() > after.getTime()) return t;
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return null;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function describeSchedule(spec: ScheduleSpec): string {
  switch (spec.type) {
    case "once":
      return `Once at ${spec.at.replace("T", " ")}`;
    case "daily":
      return `Every day at ${spec.time}`;
    case "weekly": {
      const days = [...new Set(spec.days)].sort((a, b) => a - b);
      if (days.length === 7) return `Every day at ${spec.time}`;
      return `Every ${days.map((d) => DAY_NAMES[d]).join(", ")} at ${spec.time}`;
    }
    case "monthly":
      return `Monthly on day ${spec.day} at ${spec.time}`;
    case "interval":
      return spec.minutes % 60 === 0 ? `Every ${spec.minutes / 60} hour(s)` : `Every ${spec.minutes} minutes`;
  }
}
