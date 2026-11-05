import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  errorMessage,
  getLocale,
  initializeLocale,
  LocalizedError,
  localeNames,
  localeStorageKey,
  locales,
  messages,
  resolveLocale,
  setLocale,
  t,
  translate,
} from "./i18n.js"
import { LanguageSelector } from "./language-selector.js"
import { chatsMessages } from "./locales/chats.js"
import { commonMessages } from "./locales/common.js"
import { policyMessages } from "./locales/policy.js"
import { providersMessages } from "./locales/providers.js"
import { recordsMessages } from "./locales/records.js"
import { settingsMessages } from "./locales/settings.js"
import { countText } from "./status-text.js"

afterEach(() => {
  setLocale("en")
  vi.unstubAllGlobals()
})

function browser(saved: string | null = null, languages = ["en-US"]) {
  const storage = { getItem: vi.fn(() => saved), setItem: vi.fn() }
  const document = { documentElement: { lang: "" }, title: "" }
  vi.stubGlobal("window", { localStorage: storage })
  vi.stubGlobal("navigator", { languages, language: "en-US" })
  vi.stubGlobal("document", document)
  return { storage, document }
}

describe("admin locale selection", () => {
  it.each([
    ["ja", ["zh-TW"], "ja"],
    ["zh-TW", ["en"], "zh-TW"],
    ["en", ["ja"], "en"],
    [null, ["fr-FR", "ja-JP"], "ja"],
    [null, ["zh-Hant-TW", "en-US"], "zh-TW"],
    [null, ["zh-HK"], "zh-TW"],
    [null, ["zh-CN"], "zh-TW"],
    ["invalid", ["en-GB", "ja"], "en"],
    ["ja-JP", ["zh"], "zh-TW"],
    [null, ["de-DE"], "en"],
    [null, [], "en"],
  ])("resolves saved %s and browser %j to %s", (saved, languages, expected) => {
    expect(resolveLocale(saved, languages)).toBe(expected)
  })

  it("initializes document metadata without writing a browser preference", () => {
    const { storage, document } = browser(null, ["ja-JP"])
    initializeLocale()
    expect(getLocale()).toBe("ja")
    expect(document.documentElement.lang).toBe("ja")
    expect(document.title).toBe("Sumire 管理画面")
    expect(storage.getItem).toHaveBeenCalledWith(localeStorageKey)
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it("persists an explicit choice and updates document metadata", () => {
    const { storage, document } = browser("en", ["ja"])
    initializeLocale()
    setLocale("zh-TW")
    expect(storage.setItem).toHaveBeenCalledWith(localeStorageKey, "zh-TW")
    expect(document.documentElement.lang).toBe("zh-TW")
    expect(document.title).toBe("Sumire 管理介面")
    expect(t("app.language")).toBe("語言")
  })

  it("uses navigator.language when the preference list is empty", () => {
    browser(null, [])
    vi.stubGlobal("navigator", { languages: [], language: "ja-JP" })
    initializeLocale()
    expect(getLocale()).toBe("ja")
  })

  it("keeps selection working when localStorage access throws", () => {
    const { document } = browser(null, ["ja-JP"])
    vi.stubGlobal("window", {
      get localStorage() {
        throw new Error("Storage is unavailable")
      },
    })
    expect(() => initializeLocale()).not.toThrow()
    expect(getLocale()).toBe("ja")
    expect(() => setLocale("zh-TW")).not.toThrow()
    expect(document.documentElement.lang).toBe("zh-TW")
    expect(getLocale()).toBe("zh-TW")
  })

  it("renders native language names and a localized accessible label", () => {
    setLocale("ja")
    const html = renderToStaticMarkup(createElement(LanguageSelector))
    expect(html).toContain("<label")
    expect(html).toContain("言語")
    for (const locale of locales) expect(html).toContain(localeNames[locale])
    expect(html).toMatch(/<option[^>]*value="ja"[^>]*selected=""/)
  })
})

describe("admin message catalogs", () => {
  it("has unique keys across UI responsibilities", () => {
    const catalogs = [
      commonMessages,
      chatsMessages,
      recordsMessages,
      providersMessages,
      settingsMessages,
      policyMessages,
    ]
    const keys = catalogs.flatMap((catalog) => Object.keys(catalog))
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("provides complete translations with identical interpolation fields", () => {
    const fields = (value: string) =>
      [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
    for (const [key, translations] of Object.entries(messages)) {
      expect(translations, key).toHaveLength(3)
      for (const value of translations) {
        expect(value.trim().length, key).toBeGreaterThan(0)
        expect(fields(value), key).toEqual(fields(translations[0]))
      }
    }
  })

  it("inserts values literally without reinterpreting data as message keys or placeholders", () => {
    const actor = "<script>$& {actor} 日本語</script>"
    expect(translate("en", "app.actor", { actor })).toBe(`Administrator: ${actor}`)
    expect(translate("zh-TW", "app.actor", { actor })).toBe(`管理員：${actor}`)
    expect(translate("ja", "app.actor", { actor })).toBe(`管理者: ${actor}`)
    expect(translate("en", "app.actor")).toBe("Administrator: {actor}")
  })

  it("updates existing local errors but keeps external diagnostics literal", () => {
    const local = new LocalizedError("app.loadFailed")
    const external = new Error("Original server diagnostic")
    setLocale("ja")
    expect(errorMessage(local)).toBe("管理者セッションを読み込めませんでした")
    expect(errorMessage(external)).toBe("Original server diagnostic")
    expect(errorMessage("Original text")).toBe("Original text")
  })

  it("uses language-specific count forms, including zero", () => {
    for (const count of [0, 1, 2]) {
      setLocale("zh-TW")
      expect(countText(count, "chat")).toBe(`${count} 個聊天`)
      setLocale("ja")
      expect(countText(count, "chat")).toBe(`${count} 件のチャット`)
    }
    setLocale("en")
    expect(countText(1, "chat")).toBe("1 chat")
    expect(countText(2, "chat")).toBe("2 chats")
    expect(
      translate("en", "app.resetHelp", { count: countText(1, "chat has", "chats have") }),
    ).toMatch(/^1 chat has explicit overrides/)
    expect(
      translate("en", "app.resetHelp", { count: countText(3, "chat has", "chats have") }),
    ).toMatch(/^3 chats have explicit overrides/)
  })
})
