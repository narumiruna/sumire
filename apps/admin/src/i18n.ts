import { useSyncExternalStore } from "react"
import { en } from "./locales/en.js"
import { ja } from "./locales/ja.js"
import type { Catalog } from "./locales/types.js"
import { zhTW } from "./locales/zh-tw.js"

export const locales = ["en", "zh-TW", "ja"] as const
export type Locale = (typeof locales)[number]
export const localeNames: Record<Locale, string> = {
  en: "English",
  "zh-TW": "正體中文",
  ja: "日本語",
}
export const localeStorageKey = "sumire.admin.locale"
export const messages = { en, "zh-TW": zhTW, ja } as const satisfies Record<
  Locale,
  Catalog<typeof en>
>
export type MessageKey = keyof typeof en
export type MessageValues = Record<string, string | number>

/** Browser language tags select supported presentation only, never API identifiers. */
export function resolveLocale(saved: string | null, languages: readonly string[]): Locale {
  if (locales.includes(saved as Locale)) return saved as Locale
  for (const language of languages) {
    const base = language.toLowerCase().split("-")[0]
    if (base === "en") return "en"
    if (base === "zh") return "zh-TW"
    if (base === "ja") return "ja"
  }
  return "en"
}

export function translate(locale: Locale, key: MessageKey, values: MessageValues = {}): string {
  const message = messages[locale][key]
  return message.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : placeholder,
  )
}

let locale: Locale = "en"
const listeners = new Set<() => void>()
export const getLocale = () => locale
export const t = (key: MessageKey, values?: MessageValues) => translate(locale, key, values)

/** Retain local error keys so an existing notice follows language changes. */
export class LocalizedError extends Error {
  constructor(
    readonly messageKey?: MessageKey,
    message?: string,
  ) {
    super(messageKey ? t(messageKey) : message)
  }
}

/** Server diagnostics remain literal; only locally generated errors have message keys. */
export function errorMessage(error: Error | string): string {
  if (error instanceof LocalizedError && error.messageKey) return t(error.messageKey)
  return error instanceof Error ? error.message : error
}

function updateDocument() {
  if (typeof document === "undefined") return
  document.documentElement.lang = locale
  document.title = t("app.title")
}

/** Storage can be unavailable in private or restricted browsing. */
export function initializeLocale() {
  let saved: string | null = null
  try {
    saved = window.localStorage.getItem(localeStorageKey)
  } catch {
    // Language selection must still work without browser storage.
  }
  locale = resolveLocale(
    saved,
    navigator.languages.length ? navigator.languages : [navigator.language],
  )
  updateDocument()
}

export function setLocale(next: Locale) {
  if (!locales.includes(next)) return
  try {
    window.localStorage.setItem(localeStorageKey, next)
  } catch {
    // Keep the choice for this page even when persistence is unavailable.
  }
  if (locale === next) return
  locale = next
  updateDocument()
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The root rerenders on locale changes without replacing editor component instances. */
export function useLocale() {
  return useSyncExternalStore(subscribe, getLocale, getLocale)
}
