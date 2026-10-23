import { describe, expect, it } from "vitest"
import {
  type AuditEntry,
  auditValueLabel,
  groupActivity,
  operationNames,
  outcomeNames,
} from "./activity.js"
import { auditSearch } from "./audit.js"

const base: AuditEntry = {
  id: 1,
  time: 1,
  actor: "42",
  operation: "settings.update",
  revision: 2,
  outcome: "saved",
  target: "settings",
}
describe("audit views", () => {
  it("labels the current audit writer values without making the filters a closed enum", () => {
    // Verified against admin/{store,server,auth,import,mcp,application}.ts.
    expect(operationNames).toEqual({
      "tools.register": "Tools registered",
      "skills.register": "Skills registered",
      "settings.update": "Settings saved",
      "settings.apply": "Settings application",
      "chat.model.update": "Chat model changed",
      "chat.access.approve": "Chat access approved",
      "admin.login": "Administrator signed in",
      "admin.logout": "Administrator signed out",
      "admin.passkey.register": "Administrator passkey registered",
      "mcp.import": "MCP configuration imported",
      "mcp.update": "MCP configuration saved",
      "mcp.delete": "MCP server deleted",
      "models.import": "Model settings imported",
      "provider.credential": "Provider credential changed",
      "provider.oauth.complete": "Provider sign-in completed",
    })
    expect(outcomeNames).toEqual({
      saved: "Saved",
      applied: "Applied",
      failed: "Failed",
      stale: "Superseded",
      completed: "Completed",
      revoked: "Revoked",
      deleted: "Deleted",
      enabled: "Enabled",
      "imported; review required": "Imported — review required",
      "partial; review import report": "Partial import — review report",
    })
    for (const [value, label] of Object.entries(operationNames))
      expect(auditValueLabel("operation", value)).toBe(label)
    for (const [value, label] of Object.entries(outcomeNames))
      expect(auditValueLabel("outcome", value)).toBe(label)
  })
  it.each(["historical.operation", "constructor", "__proto__"])(
    "keeps unknown exact value %s readable and queryable",
    (value) => {
      expect(auditValueLabel("operation", value)).toBe(value)
      expect(auditValueLabel("outcome", value)).toBe(value)
      const params = new URLSearchParams(
        auditSearch({ actor: "", operation: value, outcome: value, from: "", to: "" }, 0),
      )
      expect(params.get("operation")).toBe(value)
      expect(params.get("outcome")).toBe(value)
    },
  )
  it("encodes exact filters with inclusive UTC date boundaries and stable pagination", () => {
    const params = new URLSearchParams(
      auditSearch(
        {
          actor: " 42 ",
          operation: "settings.apply",
          outcome: "failed",
          from: "2026-10-16",
          to: "2026-10-16",
        },
        100,
      ),
    )
    expect(Object.fromEntries(params)).toEqual({
      actor: "42",
      operation: "settings.apply",
      outcome: "failed",
      from: String(Date.parse("2026-10-16T00:00:00Z")),
      to: String(Date.parse("2026-10-16T23:59:59.999Z")),
      offset: "100",
    })
    expect(() =>
      auditSearch(
        { actor: "", operation: "", outcome: "", from: "2026-10-17", to: "2026-10-16" },
        0,
      ),
    ).toThrow("Start date")
  })
  it("groups retries without hiding failed application records", () => {
    const entries = [
      { ...base, id: 4, operation: "settings.apply", outcome: "applied" },
      { ...base, id: 3, operation: "settings.apply", outcome: "failed" },
      base,
    ]
    expect(groupActivity(entries)).toEqual([entries])
  })
  it("keeps unrelated events and targets separate, and never invents cross-page events", () => {
    const login = { ...base, id: 3, operation: "admin.login" }
    expect(groupActivity([base, login, { ...base, id: 4 }])).toHaveLength(3)
    expect(groupActivity([base, { ...base, id: 5, target: "chat:42" }])).toHaveLength(2)
    expect(groupActivity([{ ...base, revision: 3 }, base])).toHaveLength(2)
    expect(groupActivity([base])).toEqual([[base]])
    expect(groupActivity([])).toEqual([])
  })
})
