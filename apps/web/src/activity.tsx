import type { AuditEntry, ImportReport } from "@narumitw/sumire-contracts"
import { style } from "@react-spectrum/s2/style" with { type: "macro" }
import { getLocale, t } from "./i18n.js"
import { countText } from "./status-text.js"
import { Disclosure, Panel, Prose, StatusLabel } from "./surfaces.js"

export type { AuditEntry, ImportReport } from "@narumitw/sumire-contracts"

const stack = style({ display: "flex", flexDirection: "column", gap: 12 })
const inline = style({ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 })

function outcomeTone(outcome: string) {
  return outcome === "failed" ? "danger" : outcome === "applied" ? "success" : "neutral"
}

function failedImports(report: ImportReport["report"]) {
  return Array.isArray(report.failedChatIds) ? report.failedChatIds.length : 0
}

export function ImportHistory({ reports }: { reports: ImportReport[] }) {
  if (!reports.length)
    return (
      <Prose size="2" color="gray" className="empty-state">
        {t("audit.noImportHistory")}
      </Prose>
    )
  return (
    <div className={`import-history settings-stack ${stack}`}>
      <Prose size="2" color="gray" className="section-copy">
        {t("audit.importScope")}
      </Prose>
      {[...reports]
        .sort(
          (a, b) =>
            failedImports(b.report) - failedImports(a.report) ||
            Number(b.report.reviewRequired === true) - Number(a.report.reviewRequired === true),
        )
        .map(({ name, report }) => (
          <Panel key={name} className="import-report">
            <div className={stack}>
              <div className={`section-heading ${inline}`}>
                <h4 className={style({ font: "heading-xs", color: "title", margin: 0 })}>{name}</h4>
                {failedImports(report) > 0 && (
                  <StatusLabel tone="danger">{t("audit.importFailures")}</StatusLabel>
                )}
                {((typeof report.skippedServers === "number" && report.skippedServers > 0) ||
                  (typeof report.unscannedEntries === "number" && report.unscannedEntries > 0)) && (
                  <StatusLabel tone="warning">{t("audit.incompleteImport")}</StatusLabel>
                )}
                {report.reviewRequired === true && (
                  <StatusLabel tone="warning">{t("audit.reviewAtImport")}</StatusLabel>
                )}
              </div>
              <Prose size="2" className="import-report-summary">
                {typeof report.servers === "number" &&
                  t("audit.importedCount", { count: countText(report.servers, "server") })}
                {typeof report.imported === "number" &&
                  t("audit.importedCount", { count: countText(report.imported, "model setting") })}
                {Array.isArray(report.failedChatIds) &&
                  t("audit.failedCount", { count: countText(report.failedChatIds.length, "chat") })}
                {typeof report.skippedServers === "number" &&
                  t("audit.skippedCount", { count: countText(report.skippedServers, "server") })}
                {typeof report.unscannedEntries === "number" &&
                  t("audit.unscannedCount", {
                    count: countText(report.unscannedEntries, "entry"),
                  })}
                {Array.isArray(report.decisions) &&
                  t("audit.decisionCount", {
                    count: countText(report.decisions.length, "recorded access decision"),
                  })}
              </Prose>
              <Disclosure title={t("audit.importDetails")}>
                <pre>{JSON.stringify(report, null, 2)}</pre>
              </Disclosure>
            </div>
          </Panel>
        ))}
    </div>
  )
}

export const operationNames = (): Record<string, string> => ({
  "tools.register": t("audit.toolsRegistered"),
  "skills.register": t("audit.skillsRegistered"),
  "settings.update": t("audit.settingsSaved"),
  "settings.apply": t("audit.settingsApplication"),
  "chat.model.update": t("audit.chatModelChanged"),
  "chat.access.approve": t("audit.chatAccessApproved"),
  "admin.login": t("audit.adminSignedIn"),
  "admin.logout": t("audit.adminSignedOut"),
  "admin.passkey.register": t("audit.passkeyRegistered"),
  "mcp.import": t("audit.mcpImported"),
  "mcp.update": t("audit.mcpSaved"),
  "mcp.delete": t("audit.mcpDeleted"),
  "models.import": t("audit.modelsImported"),
  "provider.credential": t("audit.credentialChanged"),
  "provider.oauth.complete": t("audit.signInCompleted"),
})

export const outcomeNames = (): Record<string, string> => ({
  saved: t("audit.saved"),
  applied: t("audit.applied"),
  failed: t("record.failed"),
  stale: t("audit.superseded"),
  completed: t("record.completed"),
  revoked: t("audit.revoked"),
  deleted: t("audit.deleted"),
  enabled: t("audit.enabled"),
  "imported; review required": t("audit.importedReview"),
  "partial; review import report": t("audit.partialReview"),
})

export function auditValueLabel(field: "operation" | "outcome", value: string) {
  const names = field === "operation" ? operationNames() : outcomeNames()
  return Object.hasOwn(names, value) ? (names[value] ?? value) : value
}

export function groupActivity(entries: AuditEntry[]) {
  const groups: AuditEntry[][] = []
  const related = (entry: AuditEntry) =>
    entry.operation === "settings.apply" ||
    [
      "settings.update",
      "chat.model.update",
      "chat.access.approve",
      "mcp.update",
      "mcp.delete",
      "provider.credential",
      "provider.oauth.complete",
    ].includes(entry.operation)
  for (const entry of entries) {
    const last = groups.at(-1)
    if (
      last &&
      last[0]?.revision === entry.revision &&
      related(entry) &&
      last.every(related) &&
      (entry.operation === "settings.apply" ||
        last.every(
          (previous) => previous.operation === "settings.apply" || previous.target === entry.target,
        ))
    )
      last.push(entry)
    else groups.push([entry])
  }
  return groups
}

function AuditRecord({ entry }: { entry: AuditEntry }) {
  if (typeof entry.time !== "number" || !Number.isFinite(entry.time)) {
    throw new Error("Audit record time is missing or invalid.")
  }
  const time = new Date(entry.time)
  return (
    <div className={`activity-record ${stack}`}>
      <dl className="audit-record-fields">
        <div>
          <dt>{t("audit.timestamp")}</dt>
          <dd>
            <time dateTime={time.toISOString()}>{time.toLocaleString(getLocale())}</time>
          </dd>
        </div>
        <div>
          <dt>{t("audit.actor")}</dt>
          <dd>{entry.actor}</dd>
        </div>
        <div>
          <dt>{t("audit.action")}</dt>
          <dd>{auditValueLabel("operation", entry.operation)}</dd>
        </div>
        <div>
          <dt>{t("audit.target")}</dt>
          <dd>
            <code>{entry.target}</code>
          </dd>
        </div>
        <div>
          <dt>{t("audit.result")}</dt>
          <dd>
            <StatusLabel tone={outcomeTone(entry.outcome)}>
              {auditValueLabel("outcome", entry.outcome)}
            </StatusLabel>
          </dd>
        </div>
      </dl>
      <Disclosure title={t("audit.rawRecord")}>
        <Prose size="2">{t("audit.revisionNotice", { revision: entry.revision })}</Prose>
        <pre>{JSON.stringify(entry, null, 2)}</pre>
      </Disclosure>
    </div>
  )
}

export function Activity({ entries }: { entries: AuditEntry[] }) {
  if (!entries.length)
    return (
      <Prose size="2" color="gray" className="empty-state">
        {t("audit.noRecords")}
      </Prose>
    )
  return (
    <ol className="activity" aria-label={t("audit.activity")}>
      {groupActivity(entries).map((group) => (
        <li
          key={group[0]?.id}
          className="activity-group"
          data-outcome={
            group.some((entry) => entry.outcome === "failed") ? "failed" : group[0]?.outcome
          }
        >
          {group.length === 1 ? (
            group[0] && <AuditRecord entry={group[0]} />
          ) : (
            <>
              <div
                className={`activity-group-heading ${inline} ${style({ justifyContent: "space-between" })}`}
              >
                <span className={style({ font: "detail", color: "title" })}>
                  {countText(group.length, "save/application record")} ·{" "}
                  {group[0] && new Date(group[0].time).toLocaleString(getLocale())}
                </span>
                <div className={inline}>
                  {[...new Set(group.map((entry) => entry.outcome))].map((outcome) => (
                    <StatusLabel key={outcome} tone={outcomeTone(outcome)}>
                      {auditValueLabel("outcome", outcome)}
                    </StatusLabel>
                  ))}
                </div>
              </div>
              <Prose size="2" color="gray">
                {t("audit.failedNotice", {
                  count: countText(
                    group.filter((entry) => entry.outcome === "failed").length,
                    "failed application",
                  ),
                })}
              </Prose>
              <Disclosure open title={t("audit.individualRecords")}>
                <ul className="activity-group-records">
                  {group.map((entry) => (
                    <li key={entry.id}>
                      <AuditRecord entry={entry} />
                    </li>
                  ))}
                </ul>
              </Disclosure>
            </>
          )}
        </li>
      ))}
    </ol>
  )
}
