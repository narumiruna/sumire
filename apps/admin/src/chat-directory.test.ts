import type { Chat } from "@narumitw/sumire-contracts"
import { Theme } from "@radix-ui/themes"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it } from "vitest"
import { type ChatDirectory, ChatSelector, chatName, directoryPath } from "./chat-directory.js"
import { setLocale } from "./i18n.js"

afterEach(() => setLocale("en"))

describe("stored chat display names", () => {
  it("localizes unnamed labels but leaves observed names and API types unchanged", () => {
    for (const [locale, unnamed] of [
      ["en", "Unnamed private"],
      ["zh-TW", "未命名的 private"],
      ["ja", "名前のない private"],
    ] as const) {
      setLocale(locale)
      expect(chatName({ id: 42, type: "private", name: "" })).toBe(unnamed)
      expect(chatName({ id: 42, type: "private", name: "測試聊天" })).toBe("測試聊天")
    }
  })
  it("trims observed names without interpreting untrusted markup", () => {
    expect(chatName({ id: -100, type: "supergroup", name: "  Same name  " })).toBe("Same name")
    expect(chatName({ id: 42, type: "private", name: "<img src=x onerror=alert(1)>" })).toBe(
      "<img src=x onerror=alert(1)>",
    )
  })

  it.each([
    [-100, "supergroup", "", "Unnamed supergroup"],
    [-100, "group", " \t\n ", "Unnamed group"],
    [42, "private", "42", "Unnamed private"],
    [-100, "channel", " -100 ", "Unnamed channel"],
    [-100, "", "", "Unnamed chat"],
  ])("uses a neutral label for %s / %s / %j", (id, type, name, expected) => {
    const label = chatName({ id, type, name } as Chat)
    expect(label).toBe(expected)
    expect(label).not.toContain(String(id))
  })

  it("does not rewrite a numeric observed name or append IDs to duplicate names", () => {
    expect(chatName({ id: 42, type: "private", name: "43" })).toBe("43")
    for (const id of [-100, -200])
      expect(chatName({ id, type: "group", name: "Same name" })).toBe("Same name")
  })
})

describe("optional chat management columns", () => {
  const directory: ChatDirectory = {
    chats: [{ id: 42, name: "Long name 👩‍💻 <untrusted>", type: "private" }],
    knownChats: [],
    loading: false,
    error: "",
    query: "",
    offset: 0,
    setQuery: () => {},
    setOffset: () => {},
    refresh: () => {},
    selected: { loading: false, error: "", chat: undefined },
  }
  it("localizes search, counts, pagination and accessibility labels on each render", () => {
    for (const [locale, search, count, page, list] of [
      ["en", "Search stored chats", "1 of 1 chat on this page", "Page 2", "Chats on this page"],
      ["zh-TW", "搜尋已儲存的聊天", "本頁顯示", "第 2 頁", "本頁聊天"],
      ["ja", "保存済みのチャットを検索", "このページの", "2 ページ", "このページのチャット"],
    ] as const) {
      setLocale(locale)
      const html = renderToStaticMarkup(
        createElement(
          Theme,
          {},
          createElement(ChatSelector, {
            directory: { ...directory, offset: 100 },
            chat: "42",
            onSelect: () => {},
          }),
        ),
      )
      expect(html).toContain(search)
      expect(html).toContain(count)
      expect(html).toContain(page)
      expect(html).toContain(`aria-label="${list}"`)
      expect(html).toContain("Long name 👩‍💻 &lt;untrusted&gt;")
      expect(html).toContain(">private<")
    }
  })
  it("keeps the default selector a button without management columns for Durable", () => {
    const html = renderToStaticMarkup(
      createElement(
        Theme,
        {},
        createElement(ChatSelector, { directory, chat: "42", onSelect: () => {} }),
      ),
    )
    expect(html).toMatch(/<button[^>]*aria-current="true"/)
    expect(html).not.toContain("directory-model")
    expect(html).not.toContain("Copy ID")
  })
  it("renders five management columns, native detail links and independent ID controls", () => {
    const html = renderToStaticMarkup(
      createElement(
        Theme,
        {},
        createElement(ChatSelector, {
          directory,
          chat: "42",
          onSelect: () => {},
          badge: () => "Approved · Disabled",
          actions: () => "Manage access",
          columns: {
            model: () => "Shared model",
            issues: () => "Inventory unknown",
            href: (chat) => `?section=Chats&chat=${chat.id}`,
            copyId: () => createElement("button", { type: "button" }, "Copy ID"),
          },
        }),
      ),
    )
    for (const label of ["Chat", "Access", "Effective model", "Configuration issues", "Actions"])
      expect(html).toContain(`>${label}<`)
    expect(html).toContain('href="?section=Chats&amp;chat=42"')
    expect(html).toContain("Long name 👩‍💻 &lt;untrusted&gt;")
    expect(html).toContain("Approved · Disabled")
    expect(html).toContain("Copy ID")
    expect(html).not.toMatch(/<a[^>]*>[\s\S]*?<button[^>]*>Copy ID[\s\S]*?<\/a>/)
  })
})

describe("stored directory request paths", () => {
  it("keeps unfiltered paginated callers compatible", () => {
    expect(directoryPath(0)).toBe("chats?offset=0")
    expect(directoryPath(100, " \t ")).toBe("chats?offset=100")
    expect(directoryPath(200)).toBe("chats?offset=200")
  })

  it("sends complete negative IDs and names as server-side query parameters", () => {
    expect(directoryPath(0, " -1001234567890 ")).toBe("chats?offset=0&q=-1001234567890")
    const path = new URL(directoryPath(100, " A&B / 日本語_%? "), "https://example.test/")
    expect(path.searchParams.get("offset")).toBe("100")
    expect(path.searchParams.get("q")).toBe("A&B / 日本語_%?")
    expect([...path.searchParams.keys()]).toEqual(["offset", "q"])
  })
})
