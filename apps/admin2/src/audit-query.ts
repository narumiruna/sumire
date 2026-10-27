export const auditPage = 100

export type AuditFilters = {
  actor: string
  operation: string
  outcome: string
  /** Calendar days as YYYY-MM-DD, interpreted in the browser's time zone. */
  from: string
  to: string
  offset: number
}

const day = /^\d{4}-\d{2}-\d{2}$/

export function readAuditFilters(params: URLSearchParams): AuditFilters {
  const text = (key: string) => (params.get(key) ?? "").trim().slice(0, 128)
  const date = (key: string) => (day.test(params.get(key) ?? "") ? (params.get(key) ?? "") : "")
  const offset = Number(params.get("offset") ?? 0)
  return {
    actor: text("actor"),
    operation: text("operation"),
    outcome: text("outcome"),
    from: date("from"),
    to: date("to"),
    offset:
      Number.isSafeInteger(offset) && offset >= 0 && offset % auditPage === 0
        ? Math.min(offset, 10000)
        : 0,
  }
}

/** The bot expects epoch milliseconds; `to` covers the whole of its last day. */
export function auditApiQuery(filters: AuditFilters) {
  const search = new URLSearchParams({ offset: String(filters.offset) })
  for (const key of ["actor", "operation", "outcome"] as const)
    if (filters[key]) search.set(key, filters[key])
  if (filters.from) search.set("from", String(new Date(`${filters.from}T00:00:00`).getTime()))
  if (filters.to) search.set("to", String(new Date(`${filters.to}T23:59:59.999`).getTime()))
  return `audit?${search}`
}

export function auditUrlParams(filters: AuditFilters) {
  return {
    actor: filters.actor,
    operation: filters.operation,
    outcome: filters.outcome,
    from: filters.from,
    to: filters.to,
    offset: filters.offset || undefined,
  }
}
