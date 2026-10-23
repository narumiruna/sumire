import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ExclamationTriangleIcon,
  MagnifyingGlassIcon,
  ResetIcon,
} from "@radix-ui/react-icons"
import { Button, Callout, Flex, Heading, Text, TextField } from "@radix-ui/themes"
import { useEffect, useState } from "react"
import {
  Activity,
  type AuditEntry,
  auditValueLabel,
  operationNames,
  outcomeNames,
} from "./activity.js"
import { ApiError, request } from "./api.js"
import { SectionSelect as Select } from "./sections.js"
import { Prose } from "./surfaces.js"

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
  const [custom, setCustom] = useState({ operation: false, outcome: false })
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
    <Flex direction="column" gap="3" className="settings-stack">
      <details className="audit-filter-disclosure">
        <summary>Filters</summary>
        <form
          className="audit-filter-form"
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
          <fieldset className="audit-filter-toolbar" aria-labelledby="audit-filter-heading">
            <Heading as="h4" size="2" id="audit-filter-heading" className="section-heading">
              Filter all retained audit records
            </Heading>
            <div className="audit-filters">
              {[
                {
                  className: "audit-text-filters",
                  keys: ["actor", "operation", "outcome"] as const,
                },
                { className: "audit-date-filters", keys: ["from", "to"] as const },
              ].map(({ className, keys }) => (
                <div className={className} key={className}>
                  {keys.map((key) => (
                    <label key={key} htmlFor={`audit-${key}`} className="form-field">
                      {
                        {
                          actor: "Actor (exact)",
                          operation: "Operation type",
                          outcome: "Result",
                          from: "From date (UTC)",
                          to: "Through date (UTC)",
                        }[key]
                      }
                      {key === "operation" || key === "outcome" ? (
                        <>
                          <Select.Root
                            value={custom[key] ? "__custom" : draft[key] || "__all"}
                            onValueChange={(value) => {
                              setCustom((previous) => ({
                                ...previous,
                                [key]: value === "__custom",
                              }))
                              setDraft((previous) => ({
                                ...previous,
                                [key]: value === "__custom" || value === "__all" ? "" : value,
                              }))
                            }}
                          >
                            <Select.Trigger id={`audit-${key}`} aria-label={`Audit ${key}`} />
                            <Select.Content>
                              <Select.Item value="__all">All</Select.Item>
                              {Object.entries(
                                key === "operation" ? operationNames : outcomeNames,
                              ).map(([value, label]) => (
                                <Select.Item key={value} value={value}>
                                  {label}
                                </Select.Item>
                              ))}
                              <Select.Item value="__custom">Other exact value</Select.Item>
                            </Select.Content>
                          </Select.Root>
                          {custom[key] && (
                            <TextField.Root
                              aria-label={`Audit ${key} exact value`}
                              maxLength={128}
                              value={draft[key]}
                              onChange={(event) =>
                                setDraft({ ...draft, [key]: event.target.value })
                              }
                            />
                          )}
                        </>
                      ) : (
                        <TextField.Root
                          id={`audit-${key}`}
                          aria-label={`Audit ${key}`}
                          type={key === "actor" ? "text" : "date"}
                          maxLength={128}
                          value={draft[key]}
                          onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                        />
                      )}
                    </label>
                  ))}
                </div>
              ))}
            </div>
            <Flex gap="2" wrap="wrap" className="audit-filter-actions">
              <Button type="submit" disabled={loading}>
                <MagnifyingGlassIcon /> Apply audit filters
              </Button>
              <Button
                type="button"
                variant="soft"
                onClick={() => {
                  setDraft(empty)
                  setCustom({ operation: false, outcome: false })
                  setQuery({ filters: empty, offset: 0 })
                }}
              >
                <ResetIcon /> Clear audit filters
              </Button>
            </Flex>
          </fieldset>
        </form>
      </details>
      {Object.values(query.filters).some(Boolean) && (
        <Prose size="2" role="status" className="audit-active-filters">
          Active filters:{" "}
          {Object.entries(query.filters)
            .filter(([, value]) => value)
            .map(
              ([key, value]) =>
                `${key}: ${key === "operation" || key === "outcome" ? auditValueLabel(key, value) : value}`,
            )
            .join(" · ")}
        </Prose>
      )}
      {error && (
        <Callout.Root color="red" size="1" role="alert">
          <Callout.Icon>
            <ExclamationTriangleIcon />
          </Callout.Icon>
          <Callout.Text>{error}</Callout.Text>
        </Callout.Root>
      )}
      {error && (
        <Button variant="soft" onClick={() => setRetry((value) => value + 1)}>
          Retry audit
        </Button>
      )}
      <Flex direction="column" gap="1" className="audit-results-summary">
        <Text as="p" size="2" weight="medium">
          Showing records {entries.length ? query.offset + 1 : 0}–{query.offset + entries.length}.
        </Text>
        <details>
          <summary>History scope and limits</summary>
          <Prose size="1" color="gray">
            Older records may be available; the server retains up to 10,000 records. Filters cover
            all retained records. Groups cover this page only and can continue on adjacent pages;
            filtered views can omit related events. Field-level change details are unavailable.
          </Prose>
        </details>
      </Flex>
      {loading ? (
        <Prose role="status">Loading audit records…</Prose>
      ) : (
        !error && <Activity entries={entries} />
      )}
      <Flex asChild gap="2" className="audit-pagination">
        <nav aria-label="Audit pagination">
          <Button
            variant="surface"
            disabled={loading || query.offset === 0}
            onClick={() => setQuery({ ...query, offset: Math.max(0, query.offset - 100) })}
          >
            <ChevronLeftIcon /> Newer
          </Button>
          <Button
            variant="surface"
            disabled={loading || entries.length < 100}
            onClick={() => setQuery({ ...query, offset: query.offset + 100 })}
          >
            Older <ChevronRightIcon />
          </Button>
        </nav>
      </Flex>
    </Flex>
  )
}
