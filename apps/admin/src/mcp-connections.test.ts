import { initialPolicy } from "@narumitw/sumire-policy"
import { Theme } from "@radix-ui/themes"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { Inventory } from "./api.js"
import { McpConnections, mcpObservationView } from "./mcp-connections.js"

const server: Inventory["mcp"][number] = {
  name: "fixture",
  connection: "connected",
  tools: [],
  enabled: true,
  env: { TOKEN: null },
  headers: {},
}
const policy = initialPolicy()
const snapshot = { policy, revision: 2, applied: 2, status: "applied", epoch: 1 }
function markup(connection = server) {
  return renderToStaticMarkup(
    createElement(
      Theme,
      {},
      createElement(McpConnections, {
        inventory: { tools: [], providers: [], mcp: [connection] },
        policy,
        snapshot,
        csrf: "fixture",
        busy: false,
        dirty: false,
        localPending: false,
        mcpDirty: false,
        secretPending: false,
        setMcpDirty: () => {},
        markPending: () => {},
        onTools: () => {},
        run: async () => {},
        load: async () => {},
      }),
    ),
  )
}

describe("MCP observation presentation", () => {
  it.each(["connected", "not tested", "failed", "no visible tools or unavailable"])(
    "does not parse legacy prose: %s",
    (connection) => {
      const view = mcpObservationView({ ...server, connection }, 2)
      expect(view).toMatchObject({
        label: "Unknown",
        succeeded: false,
        count: "Published tool names: Unknown",
      })
      expect(markup({ ...server, connection })).not.toContain("0 published tool names")
    },
  )

  it.each([
    [{ state: "untested" }, "Not tested"],
    [{ state: "checking", revision: 2, startedAt: 1000 }, "Checking"],
    [{ state: "failed", revision: 2, completedAt: 2000, reason: "listing" }, "Failed"],
  ] as const)("shows %j with unknown count", (observation, label) => {
    const view = mcpObservationView({ ...server, observation, tools: ["old-name"] }, 2)
    expect(view).toMatchObject({ label, succeeded: false, count: "Published tool names: Unknown" })
    expect(markup({ ...server, observation, tools: ["old-name"] })).not.toContain("old-name")
  })

  it.each([{ tools: [] }, { tools: ["mcp__fixture__read"] }])(
    "only current explicit success establishes a count: $tools",
    ({ tools }) => {
      const observation = { state: "succeeded", revision: 2, completedAt: 2000 } as const
      const view = mcpObservationView({ ...server, observation, tools }, 2)
      expect(view.label).toBe("Succeeded")
      expect(view.count).toBe(`${tools.length} published tool name${tools.length === 1 ? "" : "s"}`)
      expect(mcpObservationView({ ...server, observation, tools }, 3)).toMatchObject({
        label: "Not tested",
        succeeded: false,
        count: "Published tool names: Unknown",
      })
    },
  )

  it("keeps action names specific, visible labels short, and permission claims accurate", () => {
    const html = markup({
      ...server,
      observation: { state: "succeeded", revision: 2, completedAt: 2000 },
    })
    expect(html).toContain('aria-label="Test and discover fixture"')
    expect(html).toContain('aria-label="Edit fields for fixture"')
    expect(html).toContain("Test &amp; discover")
    expect(html).not.toContain("Test and discover fixture</button>")
    expect(html).toContain("Configuration revision 2")
    expect(html).toContain('dateTime="1970-01-01T00:00:02.000Z"')
    expect(html).toContain("No published tool names.")
    expect(html).toContain("not every remote tool")
    expect(html).toContain("does not add global")
    expect(html).not.toContain("adds new tools to global and default permissions")
    expect(html).toContain("Not globally available")
    expect(html).toContain("Shared default server gate: not selected")
    expect(policy.tools).toEqual([])
    expect(policy.defaults.tools).toEqual([])
    expect(policy.servers).toEqual([])
  })
})
