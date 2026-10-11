import {
  getZonedParts,
  isValidCalendarDate,
  isValidTimeZone,
  zonedTimeToUtc,
} from "@talorys/shared";

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/;
const ISO_DATE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(?:(Z)|([+-])(\d{2}):(\d{2}))$/;

/**
 * Parses a local date ("YYYY-MM-DD") or local date-time ("YYYY-MM-DDTHH:MM") in the
 * owner's timezone, or a full ISO timestamp with offset, into a UTC ISO string.
 * Date-only values mean "by the end of that day" (23:59 local).
 */
export function parseLocalDateTime(value: string, timeZone: string): string | null {
  const trimmed = value.trim();
  const m = trimmed.match(LOCAL_DATE);
  if (m) {
    if (!isValidTimeZone(timeZone)) return null;
    const [, y, mo, d, h, mi] = m;
    const hasTime = h !== undefined;
    if (!isValidCalendarDate(Number(y), Number(mo), Number(d))) return null;
    if (hasTime && (Number(h) > 23 || Number(mi) > 59)) return null;
    try {
      const date = zonedTimeToUtc(
        Number(y),
        Number(mo),
        Number(d),
        hasTime ? Number(h) : 23,
        hasTime ? Number(mi) : 59,
        timeZone,
      );
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    } catch {
      return null;
    }
  }

  const iso = trimmed.match(ISO_DATE);
  if (iso) {
    const y = iso[1];
    const mo = iso[2];
    const d = iso[3];
    const h = iso[4];
    const mi = iso[5];
    const s = iso[6];
    const offH = iso[10];
    const offM = iso[11];
    if (!isValidCalendarDate(Number(y), Number(mo), Number(d))) return null;
    if (Number(h) > 23 || Number(mi) > 59) return null;
    if (s !== undefined && Number(s) > 59) return null;
    if (offH !== undefined && (Number(offH) > 23 || Number(offM) > 59)) return null;
    const t = Date.parse(trimmed);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }

  return null;
}

/** Local wall-clock "YYYY-MM-DDTHH:MM" for an instant in the owner's timezone. */
export function toLocalMinute(date: Date, timeZone: string): string {
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const tz = isValidTimeZone(timeZone) ? timeZone : "UTC";
  const p = getZonedParts(safeDate, tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** UTC boundaries of the owner's current local day. */
export function localDayBounds(timeZone: string, at = new Date()): { start: string; end: string } {
  const safeAt = Number.isNaN(at.getTime()) ? new Date() : at;
  const tz = isValidTimeZone(timeZone) ? timeZone : "UTC";
  const p = getZonedParts(safeAt, tz);
  const start = zonedTimeToUtc(p.year, p.month, p.day, 0, 0, tz);
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  const end = zonedTimeToUtc(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
    0,
    0,
    tz,
  );
  return { start: start.toISOString(), end: end.toISOString() };
}

export function formatLocal(iso: string | null, timeZone: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const tz = isValidTimeZone(timeZone) ? timeZone : "UTC";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(d);
  } catch {
    return null;
  }
}
