import { initialPolicy } from "@narumitw/sumire-policy"
import {
  CheckCircledIcon,
  ClockIcon,
  CrossCircledIcon,
  Link2Icon,
  MinusCircledIcon,
  Pencil2Icon,
  QuestionMarkCircledIcon,
} from "@radix-ui/react-icons"
import { Theme } from "@radix-ui/themes"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { Activity, type AuditEntry, ImportHistory } from "./activity.js"
import type { Inventory, Snapshot } from "./api.js"
import { McpConnections } from "./mcp-connections.js"
import { SaveStatus } from "./save-status.js"
import { type SemanticStatus, StatusBadge, semanticStatuses } from "./semantic-status.js"
import { ToolPermissions } from "./tool-permissions.js"

const statuses = [
  ["approved", "green", "Approved", CheckCircledIcon],
  ["pending", "orange", "Pending", ClockIcon],
  ["failed", "red", "Failed", CrossCircledIcon],
  ["inherited", "blue", "Inherited", Link2Icon],
  ["overridden", "violet", "Overridden", Pencil2Icon],
  ["disabled", "gray", "Disabled", MinusCircledIcon],
  ["unknown", "gray", "Unknown", QuestionMarkCircledIcon],
] as const

const snapshot: Snapshot = {
  revision: 2,
  applied: 2,
  status: "applied",
  epoch: 1,
  policy: initialPolicy(),
}
const inventory: Inventory = {
  tools: ["read"],
  builtInTools: ["read"],
  providers: [],
  mcp: [],
}
const noop = () => {}
const run = async (action: () => Promise<void>) => action()

function saveMarkup(status: string, dirty = false, busy = false) {
  return renderToStaticMarkup(
    createElement(SaveStatus, {
      snapshot: { ...snapshot, status },
      changes: dirty ? ["Tool permissions"] : [],
      dirty,
      busy,
      localPending: false,
      mcpDirty: false,
      providerPending: false,
      showHelp: false,
      navigate: noop,
      apply: noop,
      retry: noop,
      discard: noop,
    }),
  )
}

function mcpMarkup(mcp: Inventory["mcp"]) {
  return renderToStaticMarkup(
    createElement(
      Theme,
      null,
      createElement(McpConnections, {
        inventory: { ...inventory, mcp },
        policy: snapshot.policy,
        snapshot,
        csrf: "fixture",
        busy: false,
        dirty: false,
        localPending: false,
        mcpDirty: false,
        secretPending: false,
        setMcpDirty: noop,
        markPending: noop,
        onTools: noop,
        run,
        load: async () => {},
      }),
    ),
  )
}

describe("semantic statuses", () => {
  it("defines exactly the seven shared states", () => {
    expect(Object.keys(semanticStatuses)).toEqual(statuses.map(([status]) => status))
  })

  it.each(statuses)(
    "renders %s with its shared color, label, and icon",
    (status, color, label, icon) => {
      expect(semanticStatuses[status]).toEqual({ color, label, icon })
      const html = renderToStaticMarkup(createElement(StatusBadge, { status }))
      expect(html).toContain(`data-status="${status}"`)
      expect(html).toContain(`data-accent-color="${color}"`)
      expect(html).toContain(label)
      expect(html).toContain('class="status-icon"')
      expect(html).toContain('aria-hidden="true"')
      expect(html).toContain('focusable="false"')
      expect(html).not.toContain('role="status"')
    },
  )

  it("retains contextual text, accessible attributes, and caller classes", () => {
    const html = renderToStaticMarkup(
      createElement(
        StatusBadge,
        {
          status: "failed",
          id: "application-result",
          className: "application-state",
          role: "status",
          "aria-label": "Application result",
          "aria-describedby": "revision-details",
          title: "Review the saved revision",
        },
        "Saved, but application failed. Retry application.",
      ),
    )
    expect(html).toContain("Saved, but application failed. Retry application.")
    expect(html).toContain("status-badge application-state")
    expect(html).toContain('id="application-result"')
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-label="Application result"')
    expect(html).toContain('aria-describedby="revision-details"')
    expect(html).toContain('title="Review the saved revision"')
  })
})

describe("semantic status consumers", () => {
  it.each([
    ["applied", false, false, "approved", "Saved revision applied."],
    ["applied", true, false, "pending", "1 pending policy change"],
    ["pending", false, false, "pending", "Saved changes are waiting to apply."],
    ["failed", false, false, "failed", "Saved, but application failed. Retry application."],
    ["failed", false, true, "pending", "Saving or checking…"],
  ] satisfies [string, boolean, boolean, SemanticStatus, string][])(
    "preserves save status precedence for %s (dirty=%s, busy=%s)",
    (status, dirty, busy, semantic, text) => {
      const html = saveMarkup(status, dirty, busy)
      expect(html).toContain(`data-status="${semantic}"`)
      expect(html).toContain(text)
      expect(html.match(/role="status"/g)).toHaveLength(1)
      expect(html.match(/status-badge/g)).toHaveLength(1)
      expect(html).toContain(`data-saved="${semantic === "approved"}"`)
    },
  )

  it.each([
    ["failed", "failed"],
    ["applied", "approved"],
    ["imported; review required", "pending"],
    ["future outcome", "unknown"],
  ])("keeps audit outcome %s visible with shared state %s", (outcome, status) => {
    const entry: AuditEntry = {
      id: 1,
      time: 1,
      actor: "fixture",
      operation: "settings.apply",
      revision: 2,
      outcome,
      target: "settings",
    }
    const html = renderToStaticMarkup(createElement(Activity, { entries: [entry] }))
    expect(html).toContain(`data-status="${status}"`)
    expect(html).toContain(`data-outcome="${outcome}"`)
    expect(html).toContain(outcome)
    expect(html).toContain("Raw audit record")
  })

  it("uses the shared import failure and review states", () => {
    const html = renderToStaticMarkup(
      createElement(ImportHistory, {
        reports: [{ name: "fixture", report: { failedChatIds: [42], reviewRequired: true } }],
      }),
    )
    expect(html).toContain('data-status="failed"')
    expect(html).toContain('data-status="pending"')
    expect(html).toContain("Import failures — review details")
    expect(html).toContain("Review required at import")
  })

  it("keeps permission descriptions and pending edits attached to their controls", () => {
    const policy = initialPolicy()
    policy.tools = ["read"]
    policy.defaults.tools = ["read"]
    const html = renderToStaticMarkup(
      createElement(ToolPermissions, {
        actor: "fixture",
        policy,
        saved: { ...policy, defaults: { ...policy.defaults, tools: [] } },
        inventory,
        onChange: noop,
        onChat: noop,
        defaultContext: false,
        dirty: true,
      }),
    )
    expect(html).toContain('data-status="inherited"')
    expect(html).toContain('data-status="pending"')
    expect(html).toContain("Allowed for inheriting chats")
    expect(html).toContain("Pending policy change")
    const describedBy = html.match(/aria-describedby="([^"]+-status)"/)?.[1]
    expect(describedBy).toBeDefined()
    expect(html).toContain(`id="${describedBy}"`)
  })

  it.each([
    ["connected", "approved"],
    ["not tested", "unknown"],
    // An empty catalog is not proof that the connection failed.
    ["no visible tools or unavailable", "unknown"],
    ["failed", "failed"],
    ["future result", "unknown"],
  ])("preserves MCP result %s and the repeated edit action name", (connection, status) => {
    const html = mcpMarkup([
      { name: "fixture", connection, enabled: false, tools: [], env: {}, headers: {} },
    ])
    expect(html).toContain('data-status="disabled"')
    expect(html).toContain(`data-status="${status}"`)
    expect(html).toContain(`Connection test: ${connection}`)
    expect(html).toContain('aria-label="Edit fields for fixture"')
    expect(html).toContain("rt-IconButton")
  })

  it("gives audit, import, and MCP empty states the same panel structure", () => {
    const views = [
      [
        renderToStaticMarkup(createElement(Activity, { entries: [] })),
        "No audit records on this page.",
      ],
      [renderToStaticMarkup(createElement(ImportHistory, { reports: [] })), "No import history."],
      [mcpMarkup([]), "No MCP connections configured."],
    ]
    for (const [html, title] of views) {
      expect(html).toContain("panel empty-state")
      expect(html).toContain("<h3")
      expect(html).toContain(title)
    }
  })
})
