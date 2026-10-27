import { describe, expect, it } from "vitest"
import { auditApiQuery, readAuditFilters } from "./audit-query.js"

describe("audit filters", () => {
  it("drops malformed dates and offsets that are not page boundaries", () => {
    const filters = readAuditFilters(new URLSearchParams("from=yesterday&offset=37&actor=%2042%20"))
    expect(filters).toMatchObject({ from: "", offset: 0, actor: "42" })
  })
  it("sends whole local days as epoch milliseconds", () => {
    const filters = readAuditFilters(
      new URLSearchParams("from=2026-10-01&to=2026-10-01&offset=100"),
    )
    const params = new URLSearchParams(auditApiQuery(filters).split("?")[1])
    expect(Number(params.get("from"))).toBe(new Date(2026, 9, 1).getTime())
    expect(Number(params.get("to"))).toBe(new Date(2026, 9, 2).getTime() - 1)
    expect(params.get("offset")).toBe("100")
  })
  it("omits empty filters", () => {
    expect(auditApiQuery(readAuditFilters(new URLSearchParams()))).toBe("audit?offset=0")
  })
})
