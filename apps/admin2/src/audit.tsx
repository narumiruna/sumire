import { useEffect, useState } from "react"
import { type AuditEntry, errorMessage, request } from "./api.js"
import {
  type AuditFilters,
  auditApiQuery,
  auditPage,
  auditUrlParams,
  readAuditFilters,
} from "./audit-query.js"
import type { Navigate, Settings } from "./main.js"
import { href, type Route } from "./routes.js"
import { Chip, Empty, Failure, formatClock, formatDay, type Load, Skeleton } from "./ui.js"

const good = new Set(["completed", "applied", "approved"])
const bad = new Set(["failed", "rejected", "denied", "error"])

function groupByDay(entries: AuditEntry[]) {
  const days: { day: string; entries: AuditEntry[] }[] = []
  for (const entry of entries) {
    const day = formatDay(entry.time)
    const last = days.at(-1)
    if (last?.day === day) last.entries.push(entry)
    else days.push({ day, entries: [entry] })
  }
  return days
}

export function AuditPage({
  route,
  navigate,
  settings,
}: {
  route: Route
  navigate: Navigate
  settings: Settings
}) {
  const filters = readAuditFilters(route.params)
  const query = auditApiQuery(filters)
  const [draft, setDraft] = useState(filters)
  const [load, setLoad] = useState<Load<AuditEntry[]>>({ state: "loading" })
  const [reload, setReload] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: The URL owns the filters.
  useEffect(() => setDraft(filters), [route.params.toString()])
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reload on request.
  useEffect(() => {
    const controller = new AbortController()
    setLoad({ state: "loading" })
    request<AuditEntry[]>(query, undefined, controller.signal).then(
      (value) => setLoad({ state: "ready", value }),
      (e: unknown) => {
        if (!controller.signal.aborted) setLoad({ state: "error", message: errorMessage(e) })
      },
    )
    return () => controller.abort()
  }, [query, reload])
  const go = (next: AuditFilters) => navigate(href("audit", auditUrlParams(next)))
  const snapshot = settings.load.state === "ready" ? settings.load.value : undefined
  const entries = load.state === "ready" ? load.value : []
  const filtered = Boolean(
    filters.actor || filters.operation || filters.outcome || filters.from || filters.to,
  )
  const field = (key: "actor" | "operation" | "outcome", label: string) => (
    <div className="field">
      <label htmlFor={`audit-${key}`}>{label}</label>
      <input
        id={`audit-${key}`}
        className="input"
        name={key}
        autoComplete="off"
        maxLength={128}
        value={draft[key]}
        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
      />
    </div>
  )
  return (
    <div className="page">
      <header className="page__head page__head--reading">
        <div>
          <h1>Audit trail</h1>
          <p className="page__lede">Who changed the bot’s policy, when, and what came of it.</p>
        </div>
        {snapshot && (
          <div className="revision">
            <p className="reading-label">Current revision</p>
            <p className="reading reading--large">r{snapshot.revision}</p>
            <p className="revision__applied">
              {snapshot.applied === snapshot.revision
                ? "Applied to the running bot"
                : `Running bot is on r${snapshot.applied}`}
            </p>
          </div>
        )}
      </header>
      <form
        className="filters filters--audit"
        aria-label="Filter the audit trail"
        onSubmit={(event) => {
          event.preventDefault()
          if (draft.from && draft.to && draft.from > draft.to) return
          go({ ...draft, offset: 0 })
        }}
      >
        {field("actor", "Actor")}
        {field("operation", "Operation")}
        {field("outcome", "Outcome")}
        <div className="field">
          <label htmlFor="audit-from">From</label>
          <input
            id="audit-from"
            className="input"
            type="date"
            name="from"
            value={draft.from}
            onChange={(e) => setDraft({ ...draft, from: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="audit-to">To</label>
          <input
            id="audit-to"
            className="input"
            type="date"
            name="to"
            min={draft.from || undefined}
            value={draft.to}
            onChange={(e) => setDraft({ ...draft, to: e.target.value })}
          />
        </div>
        <button type="submit" className="btn">
          Filter
        </button>
        {filtered && (
          <a
            className="btn btn--quiet"
            href={href("audit")}
            onClick={(e) => {
              e.preventDefault()
              navigate(href("audit"))
            }}
          >
            Clear
          </a>
        )}
      </form>
      <section className="panel" aria-label="Audit entries">
        {load.state === "loading" && <Skeleton rows={8} label="Loading audit trail" />}
        {load.state === "error" && (
          <Failure message={load.message} retry={() => setReload((n) => n + 1)} />
        )}
        {load.state === "ready" && entries.length === 0 && (
          <Empty
            title={filtered ? "No entry matches these filters." : "Nothing has been recorded yet."}
          >
            <p className="state__body">
              {filtered
                ? "Filters match exact values. Clear them to see every entry."
                : "Sign-ins, approvals and policy saves appear here as they happen."}
            </p>
          </Empty>
        )}
        {groupByDay(entries).map(({ day, entries }) => (
          <section key={day} className="trail" aria-labelledby={`day-${day}`}>
            <h2 className="trail__day" id={`day-${day}`}>
              <time dateTime={day}>{day}</time>
            </h2>
            <ol className="trail__list">
              {entries.map((e) => (
                <li key={e.id} className="trail__entry">
                  <time className="measured instrument" dateTime={new Date(e.time).toISOString()}>
                    {formatClock(e.time)}
                  </time>
                  <span className="measured person trail__actor">{e.actor}</span>
                  <span className="trail__what">
                    <span className="measured">{e.operation}</span>
                    <span className="measured muted">{e.target}</span>
                  </span>
                  <span className="measured instrument">r{e.revision}</span>
                  <span>
                    <Chip tone={good.has(e.outcome) ? "ok" : bad.has(e.outcome) ? "bad" : "quiet"}>
                      {e.outcome}
                    </Chip>
                  </span>
                </li>
              ))}
            </ol>
          </section>
        ))}
        {(filters.offset > 0 || entries.length === auditPage) && (
          <div className="pager">
            <button
              type="button"
              className="btn btn--quiet"
              disabled={filters.offset === 0}
              onClick={() => go({ ...filters, offset: Math.max(0, filters.offset - auditPage) })}
            >
              Newer
            </button>
            <span className="measured">
              {filters.offset + 1} to {filters.offset + entries.length}
            </span>
            <button
              type="button"
              className="btn btn--quiet"
              disabled={entries.length < auditPage}
              onClick={() => go({ ...filters, offset: filters.offset + auditPage })}
            >
              Older
            </button>
          </div>
        )}
      </section>
    </div>
  )
}
