import type { I18n } from "./i18n";

export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

const relativeFormats = new Map<string, Intl.RelativeTimeFormat>();

export function relativeTime(iso: string | null | undefined, { locale, t }: Pick<I18n, "locale" | "t">): string {
  if (!iso) return "";
  const diff = Date.parse(iso) - Date.now();
  const abs = Math.abs(diff);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 365 * 86400_000],
    ["month", 30 * 86400_000],
    ["week", 7 * 86400_000],
    ["day", 86400_000],
    ["hour", 3600_000],
    ["minute", 60_000],
  ];
  let rtf = relativeFormats.get(locale);
  if (!rtf) {
    rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    relativeFormats.set(locale, rtf);
  }
  for (const [unit, ms] of units) {
    if (abs >= ms) return rtf.format(Math.round(diff / ms), unit);
  }
  return diff < 0 ? t("time.justNow") : t("time.inAMoment");
}

/** Formats an instant in the owner's timezone. */
export function formatDateTime(iso: string | null | undefined, timeZone: string, locale: string, opts: { dateOnly?: boolean } = {}): string {
  if (!iso) return "";
  const d = new Date(iso);
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}),
    ...(opts.dateOnly ? {} : { hour: "numeric", minute: "2-digit" }),
  }).format(d);
}

/** Due dates stored as 23:59 local mean "by end of day" and are shown without a time. */
export function formatDue(iso: string | null, timeZone: string, locale: string): string {
  if (!iso) return "";
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
  return formatDateTime(iso, timeZone, locale, { dateOnly: parts === "23:59" });
}

/** "YYYY-MM-DDTHH:MM" for <input type="datetime-local"> in the owner's timezone. */
export function toLocalInput(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return "";
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(iso))
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

export function copyText(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
}
