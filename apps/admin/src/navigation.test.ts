import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import {
  navigationHref,
  type Page,
  pageLabel,
  pages,
  readNavigation,
  SideNavigation,
} from "./navigation.js"

const taskLabels = {
  Chats: "Chats",
  Durable: "Conversation records",
  Access: "Chat access",
  Defaults: "Shared defaults",
  "Tool permissions": "Tool permissions",
  Skills: "Skills",
  "MCP connections": "MCP Servers",
  "Model Providers": "Model providers",
  "Secrets & variables": "Secrets &amp; variables",
  Audit: "Audit",
} satisfies Record<Page, string>

function renderNavigation(page: Page = "Durable") {
  vi.stubGlobal("window", {
    location: {
      href: "https://example.com/admin?section=Durable&chat=-100&view=documents&objectId=9#records",
    },
  })
  try {
    return renderToStaticMarkup(
      createElement(SideNavigation, { page, chat: "-100", actor: "Admin", onNavigate: () => {} }),
    )
  } finally {
    vi.unstubAllGlobals()
  }
}

describe("admin navigation", () => {
  it("uses task labels without changing stable page IDs or selected chat URLs", () => {
    for (const page of pages) {
      expect(pageLabel(page)).toBe(taskLabels[page].replaceAll("&amp;", "&"))
      const url = new URL(
        navigationHref(page, "-100", new URL("https://example.com/admin")),
        "https://example.com",
      )
      expect(url.searchParams.get("section")).toBe(page)
      expect(readNavigation(url)).toEqual({ page, chat: "-100" })
    }
  })

  it("groups every destination by task in the planned order", () => {
    const html = renderNavigation()
    const groups = [
      ["chat-management", "Chats"],
      ["models", "Models"],
      ["tools-and-skills", "Tools &amp; skills"],
      ["system-settings", "Defaults"],
      ["activity", "Activity"],
    ]
    let previous = -1
    for (const [id, label] of groups) {
      const position = html.indexOf(`class="navigation-group" aria-labelledby="navigation-${id}"`)
      expect(position).toBeGreaterThan(previous)
      expect(html).toContain(`id="navigation-${id}"`)
      expect(html).toContain(`>${label}</h2>`)
      previous = position
    }
    const links = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)]
    const orderedPages: Page[] = [
      "Chats",
      "Access",
      "Durable",
      "Model Providers",
      "Tool permissions",
      "Skills",
      "MCP connections",
      "Defaults",
      "Secrets & variables",
      "Audit",
    ]
    expect(links).toHaveLength(pages.length)
    for (const [index, page] of orderedPages.entries()) {
      const link = links[index]
      expect(link?.[2]).toContain(`<span>${taskLabels[page]}</span>`)
      const href = link?.[1]?.match(/href="([^"]+)"/)?.[1]?.replaceAll("&amp;", "&")
      const url = new URL(href ?? "", "https://example.com")
      expect(readNavigation(url)).toEqual({ page, chat: "-100" })
      expect(url.pathname).toBe("/admin")
      expect(url.hash).toBe("#records")
      expect(url.searchParams.has("objectId")).toBe(page === "Durable")
      expect(link?.[1]?.includes('aria-current="page"')).toBe(page === "Durable")
    }
  })

  it("keeps protocol and inspector details in accessible descriptions", () => {
    const html = renderNavigation()
    for (const [id, label, technicalTerm] of [
      ["Durable", "Conversation records", "Durable Inspector"],
      ["MCP-connections", "MCP Servers", "Model Context Protocol (MCP)"],
    ]) {
      const descriptionId = `navigation-description-${id}`
      const link = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].find((match) =>
        match[2]?.includes(`<span>${label}</span>`),
      )
      expect(link?.[1]).toContain(`aria-describedby="${descriptionId}"`)
      expect(link?.[2]).not.toContain(technicalTerm)
      expect(html).toContain(`id="${descriptionId}"`)
      expect(html).toContain(technicalTerm)
    }
  })

  it("defaults unknown sections and invalid chat IDs without changing policy", () => {
    expect(readNavigation(new URL("https://example.com/?section=Missing&chat=0"))).toEqual({
      page: "Chats",
      chat: "",
    })
    expect(
      readNavigation(new URL("https://example.com/?section=Access&chat=9007199254740992")),
    ).toEqual({ page: "Access", chat: "" })
    expect(readNavigation(new URL("https://example.com/?chat=42x"))).toEqual({
      page: "Chats",
      chat: "",
    })
  })
  it("rejects noncanonical chat IDs in deep links and navigation links", () => {
    for (const chat of ["0042", "-00100", "+42", "42.0"]) {
      const url = new URL("https://example.com/?section=Chats")
      url.searchParams.set("chat", chat)
      expect(readNavigation(url)).toEqual({ page: "Chats", chat: "" })
      expect(navigationHref("Chats", chat, url)).toBe("/?section=Chats")
    }
  })
  it("maps legacy Tools / MCP links to tool permissions", () => {
    expect(readNavigation(new URL("https://example.com/?section=Tools+%2F+MCP&chat=42"))).toEqual({
      page: "Tool permissions",
      chat: "42",
    })
    expect(readNavigation(new URL("https://example.com/?section=MCP+connections"))).toEqual({
      page: "MCP connections",
      chat: "",
    })
  })
  it("accepts the normalized provider label while retaining old links", () => {
    expect(readNavigation(new URL("https://example.com/?section=Model+providers"))).toEqual({
      page: "Model Providers",
      chat: "",
    })
  })
  it("accepts supported sections and exact, non-zero chat IDs", () => {
    expect(
      readNavigation(new URL("https://example.com/?section=Model%20Providers&chat=-100")),
    ).toEqual({ page: "Model Providers", chat: "-100" })
  })
  it("preserves chat-scoped Durable deep links but clears stale object context on chat or page changes", () => {
    const href =
      "https://example.com/?section=Durable&chat=-100&view=documents&scope=task&conversationId=7&taskId=8&objectId=9"
    expect(readNavigation(new URL(href))).toEqual({ page: "Durable", chat: "-100" })
    expect(navigationHref("Durable", "-100", new URL(href))).toContain("objectId=9")
    expect(navigationHref("Durable", "42", new URL(href))).toBe("/?section=Durable&chat=42")
    expect(navigationHref("Chats", "-100", new URL(href))).toBe("/?section=Chats&chat=-100")
  })
  it("preserves all same-chat inspector fields but clears every old-chat field on selection", () => {
    const source = new URL(
      "https://example.com/admin?section=Durable&chat=-9001&view=documents&scope=task&conversationId=7&taskId=8&objectId=9&existing=1#details",
    )
    const same = new URL(navigationHref("Durable", "-9001", new URL(source)), source)
    for (const key of ["view", "scope", "conversationId", "taskId", "objectId"])
      expect(same.searchParams.get(key)).toBe(source.searchParams.get(key))
    const changed = new URL(navigationHref("Durable", "-9002", new URL(source)), source)
    expect(readNavigation(changed)).toEqual({ page: "Durable", chat: "-9002" })
    for (const key of ["view", "scope", "conversationId", "taskId", "objectId"])
      expect(changed.searchParams.has(key)).toBe(false)
    expect(changed.pathname).toBe("/admin")
    expect(changed.searchParams.get("existing")).toBe("1")
    expect(changed.hash).toBe("#details")
  })
  it("accepts safe complete IDs at both numeric limits", () => {
    for (const chat of ["9007199254740991", "-9007199254740991"]) {
      const url = new URL(`https://example.com/admin?section=Durable&chat=${chat}`)
      expect(readNavigation(url)).toEqual({ page: "Durable", chat })
      expect(navigationHref("Chats", chat, url)).toBe(`/admin?section=Chats&chat=${chat}`)
    }
  })
  it("removes known section targets only when their destination changes", () => {
    for (const [page, anchor] of [
      ["Model Providers", "model-availability"],
      ["Tool permissions", "default-tool-permissions"],
    ] as const) {
      const source = new URL(
        `https://example.com/admin?section=${encodeURIComponent(page)}&chat=42&existing=1#${anchor}`,
      )
      const same = new URL(navigationHref(page, "42", new URL(source)), source)
      expect(same.hash).toBe(`#${anchor}`)
      const changed = new URL(navigationHref("Defaults", "42", new URL(source)), source)
      expect(changed.hash).toBe("")
      expect(changed.searchParams.get("existing")).toBe("1")
      expect(changed.searchParams.get("chat")).toBe("42")
    }
  })
  it("creates compatible same-path section links while retaining other URL state", () => {
    expect(
      navigationHref("Tool permissions", "42", new URL("https://example.com/?existing=1")),
    ).toBe("/?existing=1&section=Tool+permissions&chat=42")
    expect(navigationHref("Chats", "", new URL("https://example.com/?chat=42"))).toBe(
      "/?section=Chats",
    )
  })
})
