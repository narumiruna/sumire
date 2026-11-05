import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DurableInspector } from "./durable-inspector.js"

afterEach(() => vi.unstubAllGlobals())

function renderWorkspace(chat: string, wide: boolean) {
  vi.stubGlobal("window", {
    location: { href: `https://example.com/?section=Durable${chat ? `&chat=${chat}` : ""}` },
    matchMedia: () => ({ matches: wide }),
  })
  return renderToStaticMarkup(
    createElement(DurableInspector, {
      chat,
      chatSelector: createElement("p", null, "Stored chat directory"),
      onChats: () => {},
      onSessionExpired: () => {},
    }),
  )
}

describe("conversation chat workspace", () => {
  it("shows the directory beside a useful read-only unselected state", () => {
    const html = renderWorkspace("", true)
    expect(html).toContain('aria-label="Conversation chat directory"')
    expect(html).toContain('class="durable-chat-picker" open=""')
    expect(html).toContain('class="durable-reader-pane"')
    expect(html).toContain("Read-only")
    expect(html).toContain("Choose a chat")
    expect(html).toContain("No chat is selected.")
    expect(html).toContain("Viewing records does not load a session or start work.")
    expect(html).not.toContain('aria-label="Conversation record views"')
    expect(html).not.toContain("Loading history…")
  })

  it.each([true, false])("opens an unselected directory at wide=%s", (wide) => {
    expect(renderWorkspace("", wide)).toContain('class="durable-chat-picker" open=""')
  })

  it("keeps the desktop directory open but starts a selected narrow picker closed", () => {
    expect(renderWorkspace("42", true)).toContain('class="durable-chat-picker" open=""')
    const narrow = renderWorkspace("42", false)
    expect(narrow).toContain('class="durable-chat-picker">')
    expect(narrow).toContain("Switch chat")
    expect(narrow).toContain("History")
    expect(narrow).toContain("Branch view")
    expect(narrow).toContain("Loading history…")
    expect(narrow).not.toContain("No saved entries on this page.")
  })
})
