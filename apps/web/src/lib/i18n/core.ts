import { type Language, LANGUAGES } from "@talorys/shared";
import { en } from "./en";
import { ko } from "./ko";

type PluralCategory = Intl.LDMLPluralRule;
/** A message whose form depends on {count}. "other" is required because every language has it. */
export type PluralMessage = Partial<Record<PluralCategory, string>> & { other: string };

export type Messages = typeof en;
export type MessageKey = keyof Messages;

/**
 * A translation for a non-English language. Keys must exist in English, so a renamed or
 * removed English key is a type error here. Missing keys fall back to English.
 */
export type Translation = { [K in MessageKey]?: Messages[K] extends string ? string : PluralMessage };

type Placeholders<S> = S extends `${string}{${infer Name}}${infer Rest}` ? Name | Placeholders<Rest> : never;
type MessageText<M> = M extends string ? M : M[keyof M];
type ParamName<K extends MessageKey> = Placeholders<MessageText<Messages[K]>> | (Messages[K] extends string ? never : "count");

/**
 * The parameters a message needs, inferred from its English text. Messages without placeholders
 * take none. Numbers are formatted for the active locale.
 */
export type MessageParams<K extends MessageKey, V> = [ParamName<K>] extends [never] ? [] : [params: Record<ParamName<K>, V | number>];

const translations: Record<Language, Translation> = { en, ko };

const pluralRules = new Map<string, Intl.PluralRules>();
const numberFormats = new Map<string, Intl.NumberFormat>();

function cached<T>(cache: Map<string, T>, key: string, create: () => T): T {
  let value = cache.get(key);
  if (!value) {
    value = create();
    cache.set(key, value);
  }
  return value;
}

export function isLanguage(value: unknown): value is Language {
  return (LANGUAGES as readonly unknown[]).includes(value);
}

/**
 * Splits a message into text and parameter values, picking the plural form for {count} in
 * `language`. Numbers are formatted for `locale`. Placeholders without a value are kept as written.
 */
export function formatMessage<V>(
  message: string | PluralMessage,
  language: string,
  locale: string,
  params: Record<string, V | number> = {},
): (string | V)[] {
  let text: string;
  if (typeof message === "string") {
    text = message;
  } else {
    const category = cached(pluralRules, language, () => new Intl.PluralRules(language)).select(Number(params.count));
    text = message[category] ?? message.other;
  }
  const parts: (string | V)[] = [];
  let last = 0;
  for (const match of text.matchAll(/\{(\w+)\}/g)) {
    const name = match[1]!;
    if (!(name in params)) continue;
    const value = params[name]!;
    parts.push(text.slice(last, match.index));
    parts.push(typeof value === "number" ? cached(numberFormats, locale, () => new Intl.NumberFormat(locale)).format(value) : value);
    last = match.index + match[0].length;
  }
  parts.push(text.slice(last));
  return parts.filter((part) => part !== "");
}

/** Looks up `key` in `language`, falling back to English, and formats it. */
export function format<V>(language: Language, locale: string, key: MessageKey, params?: Record<string, V | number>): (string | V)[] {
  return formatMessage(translations[language][key] ?? en[key], language, locale, params);
}

/** Plain-text translation, for strings, attributes and anything that isn't JSX. */
export function translate<K extends MessageKey>(language: Language, locale: string, key: K, ...[params]: MessageParams<K, string>): string {
  return format<string>(language, locale, key, params).join("");
}
