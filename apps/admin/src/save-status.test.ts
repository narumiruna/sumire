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
      entries: [],
      unfinished: [],
      reviewOpen: false,
      onReviewOpenChange: () => {},
      openEditor: () => {},
      dirty: false,
      busy: false,
      localPending: false,
      mcpDirty: false,
      providerPending: false,
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
      expect(html).not.toContain("Review and save changes</button>")
    },
  )
  it("shows only affected scopes and identifies the unfinished input", () => {
    const html = render({ localPending: true, unfinished: [pendingEditors.access] })
    expect(html).toContain("Continue editing: Chat access — Telegram ID to approve")
    expect(html).not.toContain("Review and save changes")
    expect(html).not.toContain("MCP: Unsaved configuration")
    expect(html).not.toContain("Provider: Unsaved selection or authentication")
    expect(html).not.toContain("All settings saved and applied.")
  })
  it("has one policy review entry point while preserving separate save scopes", () => {
    const html = render({
      dirty: true,
      entries: [
        {
          label: "Global tool availability",
          targets: [{ page: "Tool permissions", selector: "#default-tool-permissions" }],
        },
      ],
      localPending: true,
      unfinished: [pendingEditors.secret],
      mcpDirty: true,
      providerPending: true,
    })
    expect(html).toContain("1 unsaved change")
    expect(html.split("Review and save changes")).toHaveLength(2)
    expect(html).not.toContain("Review pending policy changes")
    expect(html).not.toContain("Policy: 1 change")
    expect(html).toContain("MCP: Unsaved configuration")
    expect(html).toContain("Provider: Unsaved selection or authentication")
    expect(html).toContain("Discard settings changes</button>")
  })
  it("retains pending-input guards on review and application retry", () => {
    expect(render({ dirty: true, localPending: true })).toMatch(
      /<button(?=[^>]*disabled=)[^>]*>Review and save changes<\/button>/,
    )
    expect(render({ localPending: true }, { status: "failed" })).toMatch(
      /<button(?=[^>]*disabled=)[^>]*>Retry application<\/button>/,
    )
  })
  it("blocks review and application actions while busy", () => {
    const html = render({ dirty: true, busy: true }, { status: "failed" })
    for (const label of [
      "Review and save changes",
      "Retry application",
      "Discard settings changes",
    ]) {
      expect(html).toMatch(new RegExp(`<button(?=[^>]*disabled=)[^>]*>${label}</button>`))
    }
  })
})
