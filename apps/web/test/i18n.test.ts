import { afterEach, describe, expect, it, vi } from "vitest";
import { format, formatMessage, translate } from "../src/lib/i18n/core";
import { en } from "../src/lib/i18n/en";
import { ko } from "../src/lib/i18n/ko";
import { zhCN } from "../src/lib/i18n/zhCN";
import { zhTW } from "../src/lib/i18n/zhTW";
import { browserLanguage } from "../src/lib/i18n";
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

  it("returns the Korean message", () => {
    expect(translate("ko", "ko", "login.unlock")).toBe("잠금 해제");
    expect(translate("ko", "ko", "login.tryAgainIn", { seconds: 30 })).toBe("30초 뒤에 다시 시도");
    expect(translate("ko", "ko", "time.justNow")).toBe("방금");
  });

  it("returns Simplified and Traditional Chinese messages", () => {
    expect(translate("zh-CN", "zh-CN", "login.unlock")).toBe("解锁");
    expect(translate("zh-TW", "zh-TW", "login.unlock")).toBe("解鎖");
    expect(translate("zh-CN", "zh-CN", "notifications.titleUnread", { count: 3 })).toBe("通知（3 条未读）");
    expect(translate("zh-TW", "zh-TW", "notifications.titleUnread", { count: 3 })).toBe("通知（3 則未讀）");
  });

  it("uses the singular English plan prompt for one task", () => {
    expect(translate("en", "en", "today.planPrompt", { project: "Launch", count: 1 })).toContain("1 task has an approaching deadline");
    expect(translate("en", "en", "today.planPrompt", { project: "Launch", count: 2 })).toContain("2 tasks have approaching deadlines");
  });
});

type Message = string | Record<string, string>;
const dictionaries: Record<string, Record<string, Message>> = { ko, "zh-CN": zhCN, "zh-TW": zhTW };
const english = en as unknown as Record<string, Message>;

function texts(message: Message): string[] {
  return typeof message === "string" ? [message] : Object.values(message);
}

function placeholders(message: Message): string[] {
  return [...new Set(texts(message).flatMap((text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!)))].sort();
}

describe("translation dictionaries", () => {
  it.each(Object.entries(dictionaries))("%s has every English key", (_, dictionary) => {
    expect(Object.keys(dictionary).sort()).toEqual(Object.keys(en).sort());
  });

  it.each(Object.entries(dictionaries))("%s preserves placeholders and has no empty messages", (_, dictionary) => {
    for (const [key, message] of Object.entries(dictionary)) {
      expect(placeholders(message), key).toEqual(placeholders(english[key]!));
      for (const text of texts(message)) expect(text, key).not.toBe("");
    }
  });
});

describe("browserLanguage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["zh", "zh-CN"],
    ["zh-CN", "zh-CN"],
    ["zh-SG", "zh-CN"],
    ["zh-Hans-CN", "zh-CN"],
    ["zh-TW", "zh-TW"],
    ["zh-HK", "zh-TW"],
    ["zh-MO", "zh-TW"],
    ["zh-Hant", "zh-TW"],
    ["zh-Hant-HK", "zh-TW"],
  ] as const)("maps %s to %s", (tag, language) => {
    vi.stubGlobal("navigator", { languages: [tag], language: tag });
    expect(browserLanguage()).toBe(language);
  });

  it("uses the first supported browser language", () => {
    vi.stubGlobal("navigator", { languages: ["fr-FR", "zh-Hant-HK", "en-US"], language: "fr-FR" });
    expect(browserLanguage()).toBe("zh-TW");
  });

  it("falls back to navigator.language and then English", () => {
    vi.stubGlobal("navigator", { languages: [], language: "ko-KR" });
    expect(browserLanguage()).toBe("ko");
    vi.stubGlobal("navigator", { languages: ["fr-FR"], language: "fr-FR" });
    expect(browserLanguage()).toBe("en");
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
