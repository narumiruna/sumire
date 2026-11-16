import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest"
import {
  errorMessage,
  getLocale,
  initializeLocale,
  LocalizedError,
  localeNames,
  localeStorageKey,
  locales,
  type MessageKey,
  messages,
  resolveLocale,
  setLocale,
  t,
  translate,
} from "./i18n.js"
import { LanguageSelector } from "./language-selector.js"
import { countText } from "./status-text.js"

const featureCatalogs = import.meta.glob<Record<string, string>>("./locales/*/*.json", {
  eager: true,
  import: "default",
})

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
    [null, ["JA-jp"], "ja"],
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

  it("updates metadata when browser preferences are initialized again", () => {
    const { document } = browser(null, ["en"])
    initializeLocale()
    vi.stubGlobal("navigator", { languages: ["ja-JP"], language: "ja-JP" })
    initializeLocale()
    expect(getLocale()).toBe("ja")
    expect(document.title).toBe("Sumire 管理画面")
    expect(t("app.language")).toBe("言語")
  })

  it("ignores unsupported choices without changing storage or document metadata", () => {
    const { storage, document } = browser("ja")
    initializeLocale()
    setLocale("fr" as (typeof locales)[number])
    expect(getLocale()).toBe("ja")
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(document.documentElement.lang).toBe("ja")
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
  it("preserves typed message keys from JSON resources", () => {
    expectTypeOf<"app.title">().toExtend<MessageKey>()
    expectTypeOf<"count.chat">().toExtend<MessageKey>()
    expectTypeOf<"missing.message">().not.toExtend<MessageKey>()
    expectTypeOf<string>().not.toExtend<MessageKey>()
  })

  it.each(locales)("has unique keys across UI responsibilities in %s", (locale) => {
    const directory = locale === "zh-TW" ? "zh-tw" : locale
    const catalogs = Object.entries(featureCatalogs)
      .filter(([path]) => path.startsWith(`./locales/${directory}/`))
      .map(([, catalog]) => catalog)
    expect(catalogs.length).toBeGreaterThan(0)
    expect(catalogs).toHaveLength(Object.keys(featureCatalogs).length / locales.length)
    const keys = catalogs.flatMap((catalog) => Object.keys(catalog))
    expect(new Set(keys).size).toBe(keys.length)
  })

  it.each(Object.entries(featureCatalogs))(
    "keeps %s aligned with its English feature catalog",
    (path, catalog) => {
      const source = featureCatalogs[`./locales/en/${path.split("/").at(-1)}`]
      expect(source, path).toBeDefined()
      const keys = Object.keys(source ?? {})
      const expectedKeys = path.startsWith("./locales/en/")
        ? keys
        : keys.filter((key) => !key.endsWith("_one"))
      expect(Object.keys(catalog).sort(), path).toEqual(expectedKeys.sort())
    },
  )

  it("provides complete translations with identical interpolation fields", () => {
    const fields = (value: string) =>
      [...value.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort()
    const keys = Object.keys(messages.en)
    for (const locale of locales) {
      const catalog = messages[locale]
      const expectedKeys = locale === "en" ? keys : keys.filter((key) => !key.endsWith("_one"))
      expect(Object.keys(catalog).sort(), locale).toEqual([...expectedKeys].sort())
      for (const [key, value] of Object.entries(catalog)) {
        const context = `${locale}:${key}`
        expect(value.trim().length, context).toBeGreaterThan(0)
        expect(fields(value), context).toEqual(fields(messages.en[key as keyof typeof messages.en]))
        expect(translate(locale, key as MessageKey), context).toBe(value)
      }
    }
  })

  it("inserts values literally without reinterpreting data as message keys or placeholders", () => {
    const actor = "<script>$& {{actor}} $t(app.title) 日本語</script>"
    expect(translate("en", "app.actor", { actor })).toBe(`Administrator: ${actor}`)
    expect(translate("zh-TW", "app.actor", { actor })).toBe(`管理員：${actor}`)
    expect(translate("ja", "app.actor", { actor })).toBe(`管理者: ${actor}`)
    expect(translate("en", "app.actor")).toBe("Administrator: {{actor}}")
    const html = renderToStaticMarkup(createElement("p", null, t("app.actor", { actor })))
    expect(html).toContain("&lt;script&gt;")
    expect(html).not.toContain("<script>")
  })

  it("keeps interpolation data separate from i18next options and string counts", () => {
    expect(translate("ja", "app.actor", { actor: "Alice", lng: "en" })).toBe("管理者: Alice")
    expect(translate("en", "app.resetHelp", { count: "1 chat has" })).toMatch(
      /^1 chat has explicit overrides/,
    )
    expect(getLocale()).toBe("en")
  })

  it("translates in another language without changing the active locale", () => {
    setLocale("ja")
    expect(translate("zh-TW", "app.language")).toBe("語言")
    expect(t("app.language")).toBe("言語")
    expect(getLocale()).toBe("ja")
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
    expect(translate("en", "app.resetHelp", { count: countText(1, "chat has") })).toMatch(
      /^1 chat has explicit overrides/,
    )
    expect(translate("en", "app.resetHelp", { count: countText(3, "chat has") })).toMatch(
      /^3 chats have explicit overrides/,
    )
  })
})
