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
import { type MessageKey, t } from "./i18n.js"
import { SectionSelect as Select } from "./sections.js"
import { Prose } from "./surfaces.js"

class AuditFilterError extends Error {
  constructor(readonly key: MessageKey) {
    super(t(key))
  }
}
const filterLabels = () => ({
  actor: t("audit.actorExact"),
  operation: t("audit.operationType"),
  outcome: t("audit.result"),
  from: t("audit.fromDate"),
  to: t("audit.toDate"),
})
const empty = { actor: "", operation: "", outcome: "", from: "", to: "" }
export function auditSearch(filters: typeof empty, offset: number) {
  const params = new URLSearchParams({ offset: String(offset) })
  for (const key of ["actor", "operation", "outcome"] as const)
    if (filters[key].trim()) params.set(key, filters[key].trim())
  for (const key of ["from", "to"] as const) {
    if (!filters[key]) continue
    const time = Date.parse(`${filters[key]}T00:00:00.000Z`)
    if (!Number.isFinite(time)) throw new AuditFilterError("audit.validDates")
    params.set(key, String(time + (key === "to" ? 86400000 - 1 : 0)))
  }
  if (
    params.has("from") &&
    params.has("to") &&
    Number(params.get("from")) > Number(params.get("to"))
  )
    throw new AuditFilterError("audit.dateOrder")
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
  const [error, setError] = useState<MessageKey>()
  const [retry, setRetry] = useState(0)
  // Saved revisions and explicit retry requests must refresh this independent read-only query.
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision and retry are refresh triggers.
  useEffect(() => {
    let stopped = false
    setLoading(true)
    setError(undefined)
    void (async () => {
      try {
        const result = await request<AuditEntry[]>(
          `audit?${auditSearch(query.filters, query.offset)}`,
        )
        if (!stopped) setEntries(result)
      } catch (error) {
        if (!stopped) {
          setError("audit.loadFailed")
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
        <summary>{t("audit.filters")}</summary>
        <form
          className="audit-filter-form"
          onSubmit={(event) => {
            event.preventDefault()
            try {
              auditSearch(draft, 0)
              setQuery({ filters: { ...draft }, offset: 0 })
              setError(undefined)
            } catch (error) {
              setError(error instanceof AuditFilterError ? error.key : "audit.invalidFilters")
            }
          }}
        >
          <fieldset className="audit-filter-toolbar" aria-labelledby="audit-filter-heading">
            <Heading as="h4" size="2" id="audit-filter-heading" className="section-heading">
              {t("audit.filterHeading")}
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
                    <div key={key} className="form-field">
                      <label htmlFor={`audit-${key}`}>{filterLabels()[key]}</label>
                      {key === "operation" || key === "outcome" ? (
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
                          <Select.Trigger id={`audit-${key}`} />
                          <Select.Content>
                            <Select.Item value="__all">{t("audit.all")}</Select.Item>
                            {Object.entries(
                              key === "operation" ? operationNames() : outcomeNames(),
                            ).map(([value, label]) => (
                              <Select.Item key={value} value={value}>
                                {label}
                              </Select.Item>
                            ))}
                            <Select.Item value="__custom">{t("audit.otherExact")}</Select.Item>
                          </Select.Content>
                        </Select.Root>
                      ) : (
                        <TextField.Root
                          id={`audit-${key}`}
                          type={key === "actor" ? "text" : "date"}
                          maxLength={128}
                          value={draft[key]}
                          onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                        />
                      )}
                      {(key === "operation" || key === "outcome") && custom[key] && (
                        <TextField.Root
                          aria-label={t(
                            key === "operation" ? "audit.operationExact" : "audit.outcomeExact",
                          )}
                          maxLength={128}
                          value={draft[key]}
                          onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                        />
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <Flex gap="2" wrap="wrap" className="audit-filter-actions">
              <Button type="submit" disabled={loading}>
                <MagnifyingGlassIcon />
                {t("audit.applyFilters")}
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
                <ResetIcon />
                {t("audit.clearFilters")}
              </Button>
            </Flex>
          </fieldset>
        </form>
      </details>
      {Object.values(query.filters).some(Boolean) && (
        <Prose size="2" role="status" className="audit-active-filters">
          {t("audit.activeFilters", {
            filters: Object.entries(query.filters)
              .filter(([, value]) => value)
              .map(
                ([key, value]) =>
                  `${filterLabels()[key as keyof typeof empty]}: ${key === "operation" || key === "outcome" ? auditValueLabel(key, value) : value}`,
              )
              .join(" · "),
          })}
        </Prose>
      )}
      {error && (
        <Callout.Root color="red" size="1" role="alert">
          <Callout.Icon>
            <ExclamationTriangleIcon />
          </Callout.Icon>
          <Callout.Text>{t(error)}</Callout.Text>
        </Callout.Root>
      )}
      {error && (
        <Button variant="soft" onClick={() => setRetry((value) => value + 1)}>
          {t("audit.retry")}
        </Button>
      )}
      <Flex direction="column" gap="1" className="audit-results-summary">
        <Text as="p" size="2" weight="medium">
          {t("audit.recordsRange", {
            from: entries.length ? query.offset + 1 : 0,
            to: query.offset + entries.length,
          })}
        </Text>
        <details>
          <summary>{t("audit.historyScope")}</summary>
          <Prose size="1" color="gray">
            {t("audit.scopeNotice")}
          </Prose>
        </details>
      </Flex>
      {loading ? (
        <Prose role="status">{t("audit.loading")}</Prose>
      ) : (
        !error && <Activity entries={entries} />
      )}
      <Flex asChild gap="2" className="audit-pagination">
        <nav aria-label={t("audit.pagination")}>
          <Button
            variant="surface"
            disabled={loading || query.offset === 0}
            onClick={() => setQuery({ ...query, offset: Math.max(0, query.offset - 100) })}
          >
            <ChevronLeftIcon />
            {t("audit.newer")}
          </Button>
          <Button
            variant="surface"
            disabled={loading || entries.length < 100}
            onClick={() => setQuery({ ...query, offset: query.offset + 100 })}
          >
            {t("audit.older")}
            <ChevronRightIcon />
          </Button>
        </nav>
      </Flex>
    </Flex>
  )
}
