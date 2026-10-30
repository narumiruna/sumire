import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { PageHeader, Panel, Prose } from "./surfaces.js"

describe("shared presentation primitives", () => {
  it("adds administration breadcrumbs without changing the page heading or action slot", () => {
    const html = renderToStaticMarkup(
      createElement(PageHeader, {
        title: "Conversation records",
        breadcrumb: "Administration",
        actions: createElement("button", { type: "button" }, "Account"),
      }),
    )
    expect(html).toContain('class="page-breadcrumb"')
    expect(html).toContain(">Administration</span>")
    expect(html).toContain(">Conversation records</span>")
    expect(html).toContain('id="current-section-heading"')
    expect(html).toContain('<button type="button">Account</button>')
  })

  it("keeps session screens free of administration breadcrumbs", () => {
    const html = renderToStaticMarkup(createElement(PageHeader, { title: "Sign in" }))
    expect(html).not.toContain("page-breadcrumb")
    expect(html).toContain(">Sign in</h1>")
  })

  it("keeps named section attributes and caller classes on the panel surface", () => {
    const html = renderToStaticMarkup(
      createElement(Panel, { "aria-label": "Chat details", className: "chat-detail", mt: "3" }),
    )
    expect(html).toContain("<section")
    expect(html).toContain('aria-label="Chat details"')
    expect(html).toContain("panel chat-detail")
    expect(html).toContain("rt-r-mt-3")
  })

  it("retains native fieldset, legend, and disabled semantics", () => {
    const html = renderToStaticMarkup(
      createElement(
        Panel,
        { as: "fieldset", disabled: true, name: "permissions" },
        createElement("legend", null, "Tool permissions"),
        createElement("input", { "aria-label": "Allow tool" }),
      ),
    )
    expect(html).toContain("<fieldset")
    expect(html).toContain('disabled=""')
    expect(html).toContain('name="permissions"')
    expect(html).toContain("<legend>Tool permissions</legend>")
    expect(html).toContain('aria-label="Allow tool"')
  })

  it("renders measured paragraphs without changing their accessible attributes", () => {
    const html = renderToStaticMarkup(
      createElement(
        Prose,
        { id: "scope", role: "status", size: "2", className: "notice" },
        "Saved",
      ),
    )
    expect(html).toContain("<p")
    expect(html).toContain("prose notice")
    expect(html).toContain('id="scope"')
    expect(html).toContain('role="status"')
    expect(html).toContain(">Saved</p>")
  })
})
