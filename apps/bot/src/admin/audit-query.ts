import { AdminError } from "./store.js"

export type AuditFilters = {
  actor?: string
  operation?: string
  outcome?: string
  from?: number
  to?: number
}
export function auditFilters(params: URLSearchParams): AuditFilters {
  const filters: AuditFilters = {}
  for (const key of ["actor", "operation", "outcome", "from", "to"] as const) {
    const values = params.getAll(key)
    if (!values.length) continue
    if (values.length !== 1) throw new AdminError(400, "Duplicate audit filter")
    const value = values[0] ?? ""
    if (key === "from" || key === "to") {
      const time = Number(value)
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(time) || time > 8640000000000000)
        throw new AdminError(400, "Invalid audit date")
      filters[key] = time
    } else {
      if (
        !value ||
        value.length > 128 ||
        [...value].some((character) => character.charCodeAt(0) < 32)
      )
        throw new AdminError(400, "Invalid audit filter")
      filters[key] = value
    }
  }
  if (filters.from !== undefined && filters.to !== undefined && filters.from > filters.to)
    throw new AdminError(400, "Audit start date must precede end date")
  return filters
}
