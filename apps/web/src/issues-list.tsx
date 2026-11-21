import type { IssuePage, IssueState } from "@narumitw/sumire-issues"
import { ImageIcon, ReloadIcon } from "@radix-ui/react-icons"
import { Badge, Button, Text } from "@radix-ui/themes"
import { type ReactNode, type Ref, useId } from "react"
import { getLocale, t } from "./i18n.js"

type Filter = IssueState | ""
const filters = ["", "open", "closed"] as const
const filterLabels = {
  "": "issues.list.all",
  open: "issues.list.open",
  closed: "issues.list.closed",
} as const

export function IssuesList({
  page,
  filter,
  failed,
  busy,
  hasPrevious,
  grants,
  listRef,
  onFilter,
  onRefresh,
  onPrevious,
  onNext,
  onOpen,
}: {
  page: IssuePage | undefined
  filter: Filter
  failed: boolean
  busy: boolean
  hasPrevious: boolean
  grants: ReactNode
  listRef: Ref<HTMLDivElement>
  onFilter(filter: Filter): void
  onRefresh(): void
  onPrevious(): void
  onNext(next: number): void
  onOpen(id: number): void
}) {
  const id = useId()
  const dateFormat = new Intl.DateTimeFormat(getLocale(), {
    dateStyle: "medium",
    timeStyle: "short",
  })
  const source = t("issues.list.source")
  const status = t("issues.list.status")
  const updated = t("issues.list.updated")
  const next = page?.next
  return (
    <div className="issues-list" ref={listRef}>
      <div className="issues-list-toolbar">
        <fieldset className="issues-list-filters" aria-label={t("issues.list.filter")}>
          {filters.map((value) => (
            <Button
              key={value}
              type="button"
              variant={filter === value ? "soft" : "ghost"}
              aria-pressed={filter === value}
              disabled={busy}
              onClick={() => {
                if (filter !== value) onFilter(value)
              }}
            >
              {t(filterLabels[value])}
            </Button>
          ))}
        </fieldset>
        <div className="issues-list-actions">
          <Button type="button" variant="outline" disabled={busy} onClick={onRefresh}>
            <ReloadIcon aria-hidden />
            {t("issues.list.refresh")}
          </Button>
          {grants}
        </div>
      </div>
      <div className="issues-list-body">
        {!page ? (
          <Text as="p" role="status">
            {t(failed ? "issues.list.notLoaded" : "issues.list.loading")}
          </Text>
        ) : (
          <>
            <table className="issues-list-table" aria-label={t("issues.list.table")}>
              {/* biome-ignore lint/a11y/noRedundantRoles: Positioning the header on narrow layouts changes its CSS table display. */}
              <thead className="issues-list-head" role="rowgroup">
                <tr>
                  <th id={`${id}-title`} scope="col">
                    {t("issues.list.title")}
                  </th>
                  <th id={`${id}-source`} scope="col">
                    {source}
                  </th>
                  <th id={`${id}-status`} scope="col">
                    {status}
                  </th>
                  <th id={`${id}-updated`} scope="col">
                    {updated}
                  </th>
                </tr>
              </thead>
              {/* biome-ignore lint/a11y/noRedundantRoles: Preserve table semantics in the stacked layout. */}
              <tbody role="rowgroup">
                {page.issues.map((issue) => {
                  const row = `${id}-${issue.id}`
                  const updatedAt = new Date(issue.updatedAt)
                  return (
                    // biome-ignore lint/a11y/noRedundantRoles: Preserve row semantics in the stacked layout.
                    <tr key={issue.id} role="row">
                      {/* biome-ignore lint/a11y/noRedundantRoles: Preserve row-header semantics in the stacked layout. */}
                      <th scope="row" role="rowheader" id={row} headers={`${id}-title`}>
                        <Button
                          type="button"
                          variant="ghost"
                          className="issues-list-title"
                          data-issue-id={issue.id}
                          aria-describedby={`${row}-meta`}
                          disabled={busy}
                          onClick={() => onOpen(issue.id)}
                        >
                          {issue.title}
                        </Button>
                        <span className="issues-list-meta" id={`${row}-meta`}>
                          <span>#{issue.id}</span>
                          {issue.hasScreenshot && (
                            <span className="issues-list-attachment">
                              <ImageIcon aria-hidden /> {t("issues.list.screenshot")}
                            </span>
                          )}
                        </span>
                      </th>
                      {/* biome-ignore lint/a11y/noRedundantRoles: Preserve cell semantics in the stacked layout. */}
                      <td role="cell" headers={`${row} ${id}-source`}>
                        <span className="issues-list-label" aria-hidden="true">
                          {source}
                        </span>
                        <Badge color="violet" variant="soft">
                          {issue.section}
                        </Badge>
                      </td>
                      {/* biome-ignore lint/a11y/noRedundantRoles: Preserve cell semantics in the stacked layout. */}
                      <td role="cell" headers={`${row} ${id}-status`}>
                        <span className="issues-list-label" aria-hidden="true">
                          {status}
                        </span>
                        <Badge color={issue.state === "open" ? "green" : "gray"} variant="soft">
                          {t(filterLabels[issue.state])}
                        </Badge>
                      </td>
                      {/* biome-ignore lint/a11y/noRedundantRoles: Preserve cell semantics in the stacked layout. */}
                      <td role="cell" headers={`${row} ${id}-updated`}>
                        <span className="issues-list-label" aria-hidden="true">
                          {updated}
                        </span>
                        <time dateTime={updatedAt.toISOString()}>
                          {dateFormat.format(updatedAt)}
                        </time>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {!page.issues.length && (
              <Text as="p" role="status">
                {t("issues.list.empty")}
              </Text>
            )}
          </>
        )}
      </div>
      <div className="issues-list-footer">
        <Text as="p" size="2" color="gray" role="status">
          {page && t("issues.list.count", { count: page.issues.length })}
        </Text>
        <fieldset className="issues-list-actions" aria-label={t("issues.list.pagination")}>
          <Button
            variant="soft"
            aria-disabled={busy || !page || !hasPrevious}
            onClick={() => {
              if (!busy && page && hasPrevious) onPrevious()
            }}
          >
            {t("issues.list.previous")}
          </Button>
          <Button
            variant="soft"
            aria-disabled={busy || next == null}
            onClick={() => {
              if (!busy && next != null) onNext(next)
            }}
          >
            {t("issues.list.next")}
          </Button>
        </fieldset>
      </div>
    </div>
  )
}
