import type { IssuePage, IssueState } from "@narumitw/sumire-issues"
import { Badge } from "@react-spectrum/s2/Badge"
import { Button, Text } from "@react-spectrum/s2/Button"
import Image from "@react-spectrum/s2/icons/Image"
import Refresh from "@react-spectrum/s2/icons/Refresh"
import { iconStyle, style } from "@react-spectrum/s2/style" with { type: "macro" }
import { ToggleButton } from "@react-spectrum/s2/ToggleButton"
import { type ReactNode, type Ref, useId } from "react"
import { getLocale, t } from "./i18n.js"
import { Prose } from "./surfaces.js"

const fit = style({ width: "fit", minWidth: 0, maxWidth: "full" })
const screenshotIcon = iconStyle({ size: "XS", color: "purple" })

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
            <ToggleButton
              key={value}
              size="XL"
              styles={fit}
              isQuiet
              isEmphasized
              isSelected={filter === value}
              isDisabled={busy}
              onChange={(selected) => {
                if (selected) onFilter(value)
              }}
            >
              {t(filterLabels[value])}
            </ToggleButton>
          ))}
        </fieldset>
        <div className="issues-list-actions">
          <Button
            variant="secondary"
            fillStyle="outline"
            size="XL"
            styles={fit}
            isDisabled={busy}
            onPress={onRefresh}
          >
            <Refresh />
            <Text>{t("issues.list.refresh")}</Text>
          </Button>
          {grants}
        </div>
      </div>
      <div className="issues-list-body">
        {!page ? (
          <Prose color="gray" role="status">
            {t(failed ? "issues.list.notLoaded" : "issues.list.loading")}
          </Prose>
        ) : (
          <>
            <table
              className={`issues-list-table ${style({ font: "body-sm" })}`}
              aria-label={t("issues.list.table")}
            >
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
                          variant="secondary"
                          size="XL"
                          styles={fit}
                          data-issue-id={issue.id}
                          aria-describedby={`${row}-meta`}
                          isDisabled={busy}
                          onPress={() => onOpen(issue.id)}
                        >
                          {issue.title}
                        </Button>
                        <span className="issues-list-meta" id={`${row}-meta`}>
                          <span>#{issue.id}</span>
                          {issue.hasScreenshot && (
                            <span className="issues-list-attachment">
                              <Image aria-hidden styles={screenshotIcon} />{" "}
                              {t("issues.list.screenshot")}
                            </span>
                          )}
                        </span>
                      </th>
                      {/* biome-ignore lint/a11y/noRedundantRoles: Preserve cell semantics in the stacked layout. */}
                      <td role="cell" headers={`${row} ${id}-source`}>
                        <span className="issues-list-label" aria-hidden="true">
                          {source}
                        </span>
                        <Badge variant="purple" fillStyle="subtle" styles={fit}>
                          {issue.section}
                        </Badge>
                      </td>
                      {/* biome-ignore lint/a11y/noRedundantRoles: Preserve cell semantics in the stacked layout. */}
                      <td role="cell" headers={`${row} ${id}-status`}>
                        <span className="issues-list-label" aria-hidden="true">
                          {status}
                        </span>
                        <Badge
                          variant={issue.state === "open" ? "positive" : "neutral"}
                          fillStyle="subtle"
                          styles={fit}
                        >
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
              <Prose color="gray" role="status">
                {t("issues.list.empty")}
              </Prose>
            )}
          </>
        )}
      </div>
      <div className="issues-list-footer">
        <Prose size="1" color="gray" role="status">
          {page && t("issues.list.count", { count: page.issues.length })}
        </Prose>
        <fieldset className="issues-list-actions" aria-label={t("issues.list.pagination")}>
          <Button
            variant="secondary"
            size="XL"
            styles={fit}
            aria-disabled={busy || !page || !hasPrevious}
            onPress={() => {
              if (!busy && page && hasPrevious) onPrevious()
            }}
          >
            {t("issues.list.previous")}
          </Button>
          <Button
            variant="secondary"
            size="XL"
            styles={fit}
            aria-disabled={busy || next == null}
            onPress={() => {
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
