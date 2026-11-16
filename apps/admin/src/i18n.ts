import { createInstance, type ParseKeys } from "i18next"
import { initReactI18next, useTranslation } from "react-i18next"
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
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation"
    keySeparator: false
    nsSeparator: false
    strictKeyChecks: true
    // Values use `replace`, not i18next's top-level options.
    parseInterpolation: false
    resources: { translation: typeof en }
  }
}

export type MessageKey = ParseKeys<"translation">
export type MessageValues = Record<string, string | number>

const i18n = createInstance()
void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    "zh-TW": { translation: zhTW },
    ja: { translation: ja },
  },
  lng: "en",
  fallbackLng: "en",
  supportedLngs: locales,
  load: "currentOnly",
  defaultNS: "translation",
  keySeparator: false,
  nsSeparator: false,
  initAsync: false,
  // React escapes text. Interpolated data must not become nested translations.
  interpolation: { escapeValue: false, skipOnVariables: true },
  react: { useSuspense: false },
})

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
  return i18n.t(key, {
    lng: locale,
    // Keep message values separate from i18next options, including string counts.
    replace: values,
    ...(typeof values.count === "number" ? { count: values.count } : {}),
  })
}

export const getLocale = () => i18n.language as Locale
export const t = (key: MessageKey, values?: MessageValues) => translate(getLocale(), key, values)

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
  document.documentElement.lang = getLocale()
  document.title = t("app.title")
}

i18n.on("languageChanged", updateDocument)

/** Storage can be unavailable in private or restricted browsing. */
export function initializeLocale() {
  let saved: string | null = null
  try {
    saved = window.localStorage.getItem(localeStorageKey)
  } catch {
    // Language selection must still work without browser storage.
  }
  void i18n.changeLanguage(
    resolveLocale(saved, navigator.languages.length ? navigator.languages : [navigator.language]),
  )
}

export function setLocale(next: Locale) {
  if (!locales.includes(next)) return
  try {
    window.localStorage.setItem(localeStorageKey, next)
  } catch {
    // Keep the choice for this page even when persistence is unavailable.
  }
  if (getLocale() !== next) void i18n.changeLanguage(next)
}

/** The root rerenders on locale changes without replacing editor component instances. */
export function useLocale() {
  useTranslation("translation", { i18n })
  return getLocale()
}
