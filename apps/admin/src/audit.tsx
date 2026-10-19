import { Button, Flex, Heading, TextField } from "@radix-ui/themes"
import { useEffect, useState } from "react"
import { Activity, type AuditEntry } from "./activity.js"
import { ApiError, request } from "./api.js"
import { Panel, Prose } from "./surfaces.js"

const empty = { actor: "", operation: "", outcome: "", from: "", to: "" }
export function auditSearch(filters: typeof empty, offset: number) {
  const params = new URLSearchParams({ offset: String(offset) })
  for (const key of ["actor", "operation", "outcome"] as const)
    if (filters[key].trim()) params.set(key, filters[key].trim())
  for (const key of ["from", "to"] as const) {
    if (!filters[key]) continue
    const time = Date.parse(`${filters[key]}T00:00:00.000Z`)
    if (!Number.isFinite(time)) throw new Error("Enter valid dates.")
    params.set(key, String(time + (key === "to" ? 86400000 - 1 : 0)))
  }
  if (
    params.has("from") &&
    params.has("to") &&
    Number(params.get("from")) > Number(params.get("to"))
  )
    throw new Error("Start date must precede end date.")
  return params.toString()
}

export function AuditHistory({
  revision,
  run,
}: {
  revision: number
  run(action: () => Promise<void>): Promise<void>
}) {
  const [draft, setDraft] = useState(empty)
  const [query, setQuery] = useState({ filters: empty, offset: 0 })
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [retry, setRetry] = useState(0)
  // Saved revisions and explicit retry requests must refresh this independent read-only query.
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision and retry are refresh triggers.
  useEffect(() => {
    let stopped = false
    setLoading(true)
    setError("")
    void (async () => {
      try {
        const result = await request<AuditEntry[]>(
          `audit?${auditSearch(query.filters, query.offset)}`,
        )
        if (!stopped) setEntries(result)
      } catch (error) {
        if (!stopped) {
          setError("Could not load audit records. Retry the query.")
          if (error instanceof ApiError && error.status === 401)
            await run(async () => {
              throw error
            })
        }
      } finally {
        if (!stopped) setLoading(false)
      }
    })()
    return () => {
      stopped = true
    }
  }, [query, revision, retry, run])
  return (
    <>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          try {
            auditSearch(draft, 0)
            setQuery({ filters: { ...draft }, offset: 0 })
            setError("")
          } catch (error) {
            setError(error instanceof Error ? error.message : "Invalid filters")
          }
        }}
      >
        <Panel as="fieldset" aria-labelledby="audit-filter-heading">
          <Heading as="h3" size="3" id="audit-filter-heading">
            Filter all retained audit records
          </Heading>
          <div className="audit-filters">
            {[
              { className: "audit-text-filters", keys: ["actor", "operation", "outcome"] as const },
              { className: "audit-date-filters", keys: ["from", "to"] as const },
            ].map(({ className, keys }) => (
              <div className={className} key={className}>
                {keys.map((key) => (
                  <label key={key} htmlFor={`audit-${key}`}>
                    {
                      {
                        actor: "Actor (exact)",
                        operation: "Operation type (exact)",
                        outcome: "Result (exact)",
                        from: "From date (UTC)",
                        to: "Through date (UTC)",
                      }[key]
                    }
                    <TextField.Root
                      id={`audit-${key}`}
                      aria-label={`Audit ${key}`}
                      type={key === "from" || key === "to" ? "date" : "text"}
                      maxLength={128}
                      value={draft[key]}
                      onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                    />
                  </label>
                ))}
              </div>
            ))}
          </div>
          <Flex gap="2">
            <Button type="submit" disabled={loading}>
              Apply audit filters
            </Button>
            <Button
              type="button"
              variant="soft"
              onClick={() => {
                setDraft(empty)
                setQuery({ filters: empty, offset: 0 })
              }}
            >
              Clear audit filters
            </Button>
          </Flex>
        </Panel>
      </form>
      {error && <Prose role="alert">{error}</Prose>}
      {error && <Button onClick={() => setRetry((value) => value + 1)}>Retry audit</Button>}
      <Prose size="2">
        Showing records {entries.length ? query.offset + 1 : 0}–{query.offset + entries.length}.
        Older records may be available; the server retains up to 10,000 records. Filters cover all
        retained records. Groups cover this page only and can continue on adjacent pages; filtered
        views can omit related events. Field-level change details are unavailable.
      </Prose>
      {loading ? (
        <Prose role="status">Loading audit records…</Prose>
      ) : (
        !error && <Activity entries={entries} />
      )}
      <Flex gap="2">
        <Button
          disabled={loading || query.offset === 0}
          onClick={() => setQuery({ ...query, offset: Math.max(0, query.offset - 100) })}
        >
          Newer
        </Button>
        <Button
          disabled={loading || entries.length < 100}
          onClick={() => setQuery({ ...query, offset: query.offset + 100 })}
        >
          Older
        </Button>
      </Flex>
    </>
  )
}
