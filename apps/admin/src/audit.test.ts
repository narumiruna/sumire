import { describe, expect, it } from "vitest"
import { type AuditEntry, groupActivity } from "./activity.js"
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
