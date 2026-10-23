import { initialPolicy } from "@narumitw/sumire-policy"
import { type ComponentProps, createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { Snapshot } from "./api.js"
import { pendingEditors } from "./navigation.js"
import { SaveStatus } from "./save-status.js"

type Props = ComponentProps<typeof SaveStatus>
function render(props: Partial<Props> = {}, snapshot: Partial<Snapshot> = {}) {
  return renderToStaticMarkup(
    createElement(SaveStatus, {
      snapshot: {
        revision: 5,
        applied: 5,
        status: "applied",
        policy: initialPolicy(),
        epoch: 1,
        ...snapshot,
      },
      changes: [],
      entries: [],
      unfinished: [],
      openEditor: () => {},
      dirty: false,
      busy: false,
      localPending: false,
      mcpDirty: false,
      providerPending: false,
      showHelp: true,
      navigate: () => {},
      apply: () => {},
      retry: () => {},
      discard: () => {},
      ...props,
    }),
  )
}

describe("SaveStatus", () => {
  it("keeps a clean applied state compact", () => {
    const html = render()
    expect(html).toContain('data-compact="true"')
    expect(html).toContain("All settings saved and applied.")
    expect(html).toContain("Revision details")
    expect(html).not.toContain("<button")
    expect(html).not.toContain("save-scopes")
    expect(html).not.toContain("How saving works")
  })
  it.each([
    { dirty: true },
    { mcpDirty: true },
    { providerPending: true },
    { localPending: true },
    { busy: true },
  ])("does not compact when attention is required: %j", (props) => {
    expect(render(props)).toContain('data-compact="false"')
  })
  it.each([
    ["pending", 5, 4],
    ["applied", 5, 4],
    ["applied", 4, 5],
    ["pending", 5, 5],
    ["unknown", 5, 5],
    ["failed", 5, 5],
    ["failed", 5, 4],
  ] as const)(
    "requires applied status and matching revisions: %s/%i/%i",
    (status, revision, applied) => {
      const html = render({}, { status, revision, applied })
      expect(html).toContain('data-compact="false"')
      expect(html).toContain(
        status === "failed"
          ? "Saved, but application failed. Retry application."
          : "Saved changes are waiting to apply.",
      )
      expect(html).toMatch(/<button(?![^>]*disabled=)[^>]*>Retry application<\/button>/)
      expect(html).not.toContain("Apply policy changes</button>")
    },
  )
  it("shows only affected scopes and source-specific input recovery", () => {
    const html = render({ localPending: true, unfinished: [pendingEditors.tool] })
    expect(html).toContain("Continue editing: Tool permissions — Additional approved tool name")
    expect(html).not.toContain("unfinished_tool")
    expect(html).not.toContain("Policy: No changes")
    expect(html).not.toContain("MCP: No browser edits")
    expect(html).not.toContain("Provider: No browser edits")
    expect(html).not.toContain("All settings saved and applied.")
  })
  it("lists actual policy destinations and retains mixed save scopes", () => {
    const label = "Global tool availability"
    const html = render({
      dirty: true,
      changes: [label],
      entries: [
        { label, targets: [{ page: "Tool permissions", selector: "#default-tool-permissions" }] },
      ],
      localPending: true,
      unfinished: [pendingEditors.secret],
      mcpDirty: true,
      providerPending: true,
    })
    expect(html).toContain("1 pending policy change")
    expect(html).toContain("Policy: 1 change")
    expect(html).toContain("Review Tool permissions")
    expect(html).toContain("MCP: Unsaved configuration")
    expect(html).toContain("Provider: Unsaved selection or authentication")
    expect(html).toContain("provider model selection, and authentication use separate actions")
    expect(html).toMatch(/<button(?=[^>]*disabled=)[^>]*>Apply policy changes<\/button>/)
    expect(html).toContain("Discard policy changes</button>")
  })
  it.each([{ busy: true }, { localPending: true }])("retains apply guards: %j", (guard) => {
    expect(render({ dirty: true, ...guard })).toMatch(
      /<button(?=[^>]*disabled=)[^>]*>Apply policy changes<\/button>/,
    )
    expect(render(guard, { status: "failed" })).toMatch(
      /<button(?=[^>]*disabled=)[^>]*>Retry application<\/button>/,
    )
  })
  it("hides saving help when the page does not request it", () => {
    expect(render({ showHelp: false, dirty: true })).not.toContain("How saving works")
  })
})
