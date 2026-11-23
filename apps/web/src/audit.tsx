import { Button, Text } from "@react-spectrum/s2/Button"
import { Content, InlineAlert } from "@react-spectrum/s2/InlineAlert"
import ChevronLeft from "@react-spectrum/s2/icons/ChevronLeft"
import ChevronRight from "@react-spectrum/s2/icons/ChevronRight"
import Refresh from "@react-spectrum/s2/icons/Refresh"
import Search from "@react-spectrum/s2/icons/Search"
import { style } from "@react-spectrum/s2/style" with { type: "macro" }
import { TextField } from "@react-spectrum/s2/TextField"
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
import { PickerOption, SectionPicker } from "./section-picker.js"
import { Disclosure, Prose } from "./surfaces.js"

const actions = style({ display: "flex", flexWrap: "wrap", gap: 8 })
// Native date inputs keep the date-only value used for the inclusive UTC query.
const dateField = style({
  outlineStyle: { ":focus-visible": "solid" },
  outlineColor: { default: "focus-ring", forcedColors: "Highlight" },
  outlineOffset: 2,
  outlineWidth: 2,
  boxSizing: "border-box",
  minWidth: 0,
  minHeight: 44,
  width: "full",
  paddingX: 12,
  borderStyle: "solid",
  borderWidth: 1,
  borderRadius: "default",
  borderColor: { default: "gray-500", ":hover": "gray-700" },
  backgroundColor: "layer-2",
  color: "neutral",
  font: "ui-lg",
})
const textField = style({ width: "full", minWidth: 0 })
const labelStyle = style({ color: "body", font: "ui-sm" })

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
    <div className="settings-stack">
      <Disclosure className="audit-filter-disclosure" title={t("audit.filters")}>
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
            <h4
              id="audit-filter-heading"
              className={`section-heading ${style({ font: "heading-xs", color: "title" })}`}
            >
              {t("audit.filterHeading")}
            </h4>
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
                      <label className={labelStyle} htmlFor={`audit-${key}`}>
                        {filterLabels()[key]}
                      </label>
                      {key === "operation" || key === "outcome" ? (
                        <SectionPicker
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
                          id={`audit-${key}`}
                          aria-label={filterLabels()[key]}
                        >
                          <PickerOption id="__all">{t("audit.all")}</PickerOption>
                          {Object.entries(
                            key === "operation" ? operationNames() : outcomeNames(),
                          ).map(([value, label]) => (
                            <PickerOption key={value} id={value}>
                              {label}
                            </PickerOption>
                          ))}
                          <PickerOption id="__custom">{t("audit.otherExact")}</PickerOption>
                        </SectionPicker>
                      ) : key === "actor" ? (
                        <TextField
                          id="audit-actor"
                          aria-label={filterLabels().actor}
                          UNSAFE_className="audit-text-control"
                          size="XL"
                          styles={textField}
                          maxLength={128}
                          value={draft.actor}
                          onChange={(actor) => setDraft({ ...draft, actor })}
                        />
                      ) : (
                        <input
                          id={`audit-${key}`}
                          className={`audit-date-control ${dateField}`}
                          type="date"
                          value={draft[key]}
                          onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                        />
                      )}
                      {(key === "operation" || key === "outcome") && custom[key] && (
                        <TextField
                          aria-label={t(
                            key === "operation" ? "audit.operationExact" : "audit.outcomeExact",
                          )}
                          UNSAFE_className="audit-text-control"
                          size="XL"
                          styles={textField}
                          maxLength={128}
                          value={draft[key]}
                          onChange={(value) => setDraft({ ...draft, [key]: value })}
                        />
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <div className={`audit-filter-actions ${actions}`}>
              <Button type="submit" variant="accent" size="XL" isDisabled={loading}>
                <Search />
                <Text>{t("audit.applyFilters")}</Text>
              </Button>
              <Button
                variant="secondary"
                size="XL"
                onPress={() => {
                  setDraft(empty)
                  setCustom({ operation: false, outcome: false })
                  setQuery({ filters: empty, offset: 0 })
                }}
              >
                <Refresh />
                <Text>{t("audit.clearFilters")}</Text>
              </Button>
            </div>
          </fieldset>
        </form>
      </Disclosure>
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
        <InlineAlert variant="negative">
          <Content>{t(error)}</Content>
        </InlineAlert>
      )}
      {error && (
        <Button variant="secondary" size="XL" onPress={() => setRetry((value) => value + 1)}>
          {t("audit.retry")}
        </Button>
      )}
      <div className={`audit-results-summary ${style({ display: "grid", gap: 4 })}`}>
        <Prose size="2" weight="medium">
          {t("audit.recordsRange", {
            from: entries.length ? query.offset + 1 : 0,
            to: query.offset + entries.length,
          })}
        </Prose>
        <Disclosure title={t("audit.historyScope")}>
          <Prose size="1" color="gray">
            {t("audit.scopeNotice")}
          </Prose>
        </Disclosure>
      </div>
      {loading ? (
        <Prose role="status">{t("audit.loading")}</Prose>
      ) : (
        !error && <Activity entries={entries} />
      )}
      <nav className={`audit-pagination ${actions}`} aria-label={t("audit.pagination")}>
        <Button
          variant="secondary"
          size="XL"
          isDisabled={loading || query.offset === 0}
          onPress={() => setQuery({ ...query, offset: Math.max(0, query.offset - 100) })}
        >
          <ChevronLeft />
          <Text>{t("audit.newer")}</Text>
        </Button>
        <Button
          variant="secondary"
          size="XL"
          isDisabled={loading || entries.length < 100}
          onPress={() => setQuery({ ...query, offset: query.offset + 100 })}
        >
          <Text styles={style({ order: -1 })}>{t("audit.older")}</Text>
          <ChevronRight />
        </Button>
      </nav>
    </div>
  )
}
