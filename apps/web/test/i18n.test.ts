import { describe, expect, it } from "vitest";
import { format, formatMessage, translate } from "../src/lib/i18n/core";
import { en } from "../src/lib/i18n/en";
import { formatDateTime, relativeTime } from "../src/lib/utils";

describe("translate", () => {
  it("returns the English message", () => {
    expect(translate("en", "en", "login.unlock")).toBe("Unlock");
  });

  it("fills placeholders and formats numbers for the locale", () => {
    expect(translate("en", "en", "login.tryAgainIn", { seconds: 30 })).toBe("Try again in 30s");
    expect(translate("en", "de-DE", "login.tryAgainIn", { seconds: 1500 })).toBe("Try again in 1.500s");
  });

  it("keeps elements as separate parts for rich messages", () => {
    const command = { element: "code" };
    expect(format("en", "en", "login.notConfigured", { command })).toEqual([
      "This deployment has no owner password configured yet. Run ",
      command,
      " again to finish setup.",
    ]);
  });

  it("has no empty English messages", () => {
    for (const [key, message] of Object.entries(en)) expect(message, key).not.toBe("");
  });
});

describe("formatMessage", () => {
  const files = { one: "{count} plik", few: "{count} pliki", many: "{count} plików", other: "{count} pliku" };

  it("picks the plural form for the language", () => {
    expect(formatMessage(files, "pl", "pl", { count: 1 }).join("")).toBe("1 plik");
    expect(formatMessage(files, "pl", "pl", { count: 3 }).join("")).toBe("3 pliki");
    expect(formatMessage(files, "pl", "pl", { count: 5 }).join("")).toBe("5 plików");
    expect(formatMessage(files, "pl", "pl", { count: 22 }).join("")).toBe("22 pliki");
    expect(formatMessage(files, "pl", "pl", { count: 1.5 }).join("")).toBe("1,5 pliku");
  });

  it("falls back to the other form when a category is missing", () => {
    expect(formatMessage({ other: "{count} items" }, "en", "en", { count: 1 }).join("")).toBe("1 items");
  });

  it("leaves placeholders without a value as written", () => {
    expect(formatMessage("Hello {name}", "en", "en").join("")).toBe("Hello {name}");
  });
});

describe("display formatters", () => {
  // English messages with a Polish locale, as with "system" in a Polish browser before a Polish translation exists.
  const i18n = (locale: string) => ({ locale, t: (key: "time.justNow" | "time.inAMoment") => translate("en", locale, key) }) as Parameters<typeof relativeTime>[1];

  it("formats relative times in the given locale", () => {
    const yesterday = new Date(Date.now() - 86400_000).toISOString();
    expect(relativeTime(yesterday, i18n("en"))).toBe("yesterday");
    expect(relativeTime(yesterday, i18n("pl"))).toBe("wczoraj");
    expect(relativeTime(new Date(Date.now() - 1000).toISOString(), i18n("pl"))).toBe("just now");
    expect(relativeTime(new Date(Date.now() + 5000).toISOString(), i18n("pl"))).toBe("in a moment");
  });

  it("formats dates in the given locale and the owner's timezone", () => {
    const iso = `${new Date().getFullYear()}-03-05T12:00:00Z`;
    expect(formatDateTime(iso, "UTC", "en", { dateOnly: true })).toBe("Mar 5");
    expect(formatDateTime(iso, "UTC", "pl", { dateOnly: true })).toBe("5 mar");
  });
});
