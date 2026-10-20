import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { EmptyState, LoadingState, Panel, Prose } from "./surfaces.js"

describe("shared presentation primitives", () => {
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

  it("gives errors shared styling without changing the alert role", () => {
    const html = renderToStaticMarkup(
      createElement(
        Prose,
        { role: "alert", className: "validation", id: "validation" },
        "Invalid input",
      ),
    )
    expect(html).toContain("prose error-state validation")
    expect(html).toContain('role="alert"')
    expect(html).toContain('data-status="failed"')
    expect(html).toContain('id="validation"')
    expect(html).toContain("Invalid input")
  })

  it("renders labeled loading progress and hides decorative skeletons from assistive tools", () => {
    const html = renderToStaticMarkup(
      createElement(LoadingState, {
        label: "Loading audit records…",
        id: "audit-progress",
        className: "audit-loading",
        "aria-describedby": "audit-range",
      }),
    )
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-label="Loading audit records…"')
    expect(html).toContain('aria-describedby="audit-range"')
    expect(html).toContain('id="audit-progress"')
    expect(html).toContain("loading-state audit-loading")
    expect(html).toContain("rt-Spinner")
    expect(html.match(/rt-Skeleton/g)).toHaveLength(2)
    expect(html).toMatch(/aria-hidden="true"[^>]*loading-skeletons/)
    expect(html).toContain("Loading audit records…")
  })

  it("renders a structured empty panel with an optional next action", () => {
    const html = renderToStaticMarkup(
      createElement(EmptyState, {
        title: "No servers",
        description: "Add a connection to continue.",
        action: createElement("button", { type: "button" }, "Add server"),
        "aria-label": "MCP connections",
        className: "mcp-empty",
      }),
    )
    expect(html).toContain("<section")
    expect(html).toContain("panel empty-state mcp-empty")
    expect(html).toContain('aria-label="MCP connections"')
    expect(html).toContain("<h3")
    expect(html).toContain("No servers")
    expect(html).toContain("Add a connection to continue.")
    expect(html).toContain("empty-state-action")
    expect(html).toContain('type="button">Add server</button>')
    expect(html).not.toContain('role="alert"')
  })

  it("does not add an empty action container or description", () => {
    const html = renderToStaticMarkup(createElement(EmptyState, { title: "No import history." }))
    expect(html).not.toContain("empty-state-action")
    expect(html).not.toContain("<p")
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
