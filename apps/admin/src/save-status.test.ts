import { initialPolicy } from "@narumitw/sumire-policy"
import { type ComponentProps, createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { Snapshot } from "./api.js"
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

function expectAttention(html: string) {
  expect(html).toContain('data-compact="false"')
  expect(html).toContain("save-scopes")
  expect(html.match(/navigation-control/g)).toHaveLength(3)
}

describe("SaveStatus", () => {
  it("renders only the saved/applied line and optional revision details when every scope is clean", () => {
    const html = render()
    expect(html).toContain('data-compact="true"')
    expect(html).toContain('data-pending="false"')
    expect(html).toContain("All settings saved and applied.")
    expect(html).not.toContain("Saved revision applied.")
    expect(html).toContain('tabindex="-1"')
    expect(html).toContain("Revision details")
    expect(html).toContain("Saved 5 · Applied 5 · applied")
    expect(html).not.toContain("<button")
    expect(html).not.toContain("save-scopes")
    expect(html).not.toContain("How saving works")
    expect(html).not.toContain("Review pending policy changes")
    expect(html).not.toContain("save-actions")
  })

  it.each([
    ["policy draft", { dirty: true, changes: ["Private-message access: revoke 42"] }],
    ["MCP draft", { mcpDirty: true }],
    ["provider selection or authentication", { providerPending: true }],
    ["unstaged input", { localPending: true }],
    ["active operation", { busy: true }],
  ] satisfies [string, Partial<Props>][])("does not compact with %s", (_, props) => {
    const html = render(props)
    expectAttention(html)
    expect(html).toContain("How saving works")
  })

  it.each([
    ["pending", 5, 4, "Saved changes are waiting to apply."],
    ["applied", 5, 4, "Saved changes are waiting to apply."],
    ["applied", 4, 5, "Saved changes are waiting to apply."],
    ["pending", 5, 5, "Saved changes are waiting to apply."],
    ["unknown", 5, 5, "Saved changes are waiting to apply."],
    ["failed", 5, 5, "Saved, but application failed. Retry application."],
    ["failed", 5, 4, "Saved, but application failed. Retry application."],
  ])(
    "requires applied status and matching revisions: %s/%i/%i",
    (status, revision, applied, message) => {
      const html = render({}, { status, revision, applied })
      expectAttention(html)
      expect(html).toContain(message)
      expect(html).toContain(`Saved ${revision} · Applied ${applied} · ${status}`)
      expect(html).toMatch(/<button(?![^>]*disabled=)[^>]*>Retry application<\/button>/)
      expect(html).not.toContain("Apply policy changes</button>")
    },
  )

  it("keeps the policy review, counts, and save actions without counting other scopes", () => {
    const change = "Chat 42: Authorized tools (explicit empty override) — this chat only."
    const html = render({ dirty: true, changes: [change] })
    expectAttention(html)
    expect(html).toContain("1 pending policy change")
    expect(html).toContain("Policy: 1 change")
    expect(html).toContain("Review pending policy changes")
    expect(html).toContain(change)
    expect(html).toContain("Discard policy changes</button>")
    expect(html).toMatch(/<button(?![^>]*disabled=)[^>]*>Apply policy changes<\/button>/)
    expect(html).not.toContain("Retry application</button>")
  })

  it("preserves all mixed draft notices and separate-save help", () => {
    const html = render({
      dirty: true,
      changes: ["Private-message access: revoke 42", "Group/channel access: approve -100"],
      mcpDirty: true,
      providerPending: true,
      localPending: true,
    })
    expectAttention(html)
    expect(html).toContain("2 pending policy changes")
    expect(html).toContain("Policy: 2 changes")
    expect(html).toContain("MCP: Unsaved configuration")
    expect(html).toContain("Provider: Unsaved selection or authentication")
    expect(html).toContain("Unstaged editor input")
    expect(html).toContain("Save unavailable: finish or clear this input.")
    expect(html).toContain("provider model selection, and authentication use separate actions")
    expect(html).toMatch(/<button(?=[^>]*disabled=)[^>]*>Apply policy changes<\/button>/)
  })

  it("does not present separate MCP or provider drafts as policy changes", () => {
    const html = render({ mcpDirty: true, providerPending: true })
    expectAttention(html)
    expect(html).toContain("Saved revision applied.")
    expect(html).not.toContain("All settings saved and applied.")
    expect(html).toContain("Policy: No changes")
    expect(html).toContain("MCP: Unsaved configuration")
    expect(html).toContain("Provider: Unsaved selection or authentication")
    expect(html).not.toContain("save-actions")
    expect(html).not.toContain("pending policy change")
  })

  it.each([
    { busy: true },
    { dirty: true, changes: ["Private-message access: revoke 42"] },
    { localPending: true },
    { dirty: true, busy: true, localPending: true, changes: ["Private-message access: revoke 42"] },
  ] satisfies Partial<Props>[])("does not retry application with conflicting work: %j", (props) => {
    const html = render(props, { status: "failed", applied: 4 })
    expectAttention(html)
    expect(html).toMatch(/<button(?=[^>]*disabled=)[^>]*>Retry application<\/button>/)
  })

  it("keeps busy operations visible and disables policy save and discard", () => {
    const html = render({ dirty: true, busy: true, changes: ["Private-message access: revoke 42"] })
    expectAttention(html)
    expect(html).toContain("Saving or checking…")
    expect(html).toMatch(/<button(?=[^>]*disabled=)[^>]*>Discard policy changes<\/button>/)
    expect(html).toMatch(/<button(?=[^>]*disabled=)[^>]*>Apply policy changes<\/button>/)
  })

  it("respects hidden help without hiding attention notices or revision details", () => {
    const html = render({ localPending: true, showHelp: false })
    expectAttention(html)
    expect(html).toContain("Unstaged editor input")
    expect(html).toContain("Revision details")
    expect(html).not.toContain("How saving works")
  })
})
