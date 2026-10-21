import { Fragment, type ReactNode, useSyncExternalStore } from "react";
import type { Language } from "@talorys/shared";
import { format, isLanguage, type MessageKey, type MessageParams, translate } from "./core";

export type { MessageKey } from "./core";
export type LanguagePreference = "system" | Language;

/** Each language's name in that language, as shown in the language picker. */
export const LANGUAGE_NAMES: Record<Language, string> = { en: "English", ko: "한국어" };

export interface I18n {
  /** What the owner picked in Settings. */
  preference: LanguagePreference;
  /** The language messages are shown in. */
  language: Language;
  /** BCP 47 locale for dates and numbers. With "system" it is the browser's, as before localization. */
  locale: string;
  t<K extends MessageKey>(key: K, ...params: MessageParams<K, string>): string;
  /** Like t, but parameters may be elements, for messages with links or code inside. */
  rich<K extends MessageKey>(key: K, ...params: MessageParams<K, ReactNode>): ReactNode;
}

const KEY = "talorys.language";

/** The first browser language we have messages for, else English. */
export function browserLanguage(): Language {
  for (const tag of navigator.languages?.length ? navigator.languages : [navigator.language]) {
    const base = tag?.toLowerCase().split("-")[0];
    if (isLanguage(base)) return base;
  }
  return "en";
}

function create(preference: LanguagePreference): I18n {
  const language = preference === "system" ? browserLanguage() : preference;
  const locale = preference === "system" ? new Intl.NumberFormat().resolvedOptions().locale : language;
  return {
    preference,
    language,
    locale,
    t: (key, ...params) => translate(language, locale, key, ...params),
    rich: (key, ...[params]) => format<ReactNode>(language, locale, key, params).map((part, i) => <Fragment key={i}>{part}</Fragment>),
  };
}

let current: I18n | null = null;
const listeners = new Set<() => void>();
const onBrowserChange = () => applyLanguage("system");

export function applyLanguage(preference: LanguagePreference): void {
  try {
    localStorage.setItem(KEY, preference);
  } catch {
    /* storage unavailable */
  }
  if (current && current.preference === preference && preference !== "system") return;
  current = create(preference);
  document.documentElement.lang = current.language;
  window.removeEventListener("languagechange", onBrowserChange);
  if (preference === "system") window.addEventListener("languagechange", onBrowserChange);
  for (const listener of listeners) listener();
}

/** Applies the last known language before first render, so the sign-in screen is translated too. */
export function initLanguage(): void {
  let preference: LanguagePreference = "system";
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === "system" || isLanguage(stored)) preference = stored;
  } catch {
    /* ignore */
  }
  applyLanguage(preference);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): I18n {
  if (!current) initLanguage();
  return current!;
}

/** The active language, its message lookup and its formatting locale. Re-renders when the language changes. */
export function useI18n(): I18n {
  return useSyncExternalStore(subscribe, snapshot);
}
