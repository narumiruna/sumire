import type { AuditEntry, ImportReport } from "@narumitw/sumire-contracts"
import { Badge, Code, Flex, Heading, Text } from "@radix-ui/themes"
import { countText } from "./status-text.js"
import { Disclosure, Panel, Prose, StatusLabel } from "./surfaces.js"

export type { AuditEntry, ImportReport } from "@narumitw/sumire-contracts"

function failedImports(report: ImportReport["report"]) {
  return Array.isArray(report.failedChatIds) ? report.failedChatIds.length : 0
}

export function ImportHistory({ reports }: { reports: ImportReport[] }) {
  if (!reports.length)
    return (
      <Text as="p" size="2" color="gray" className="empty-state">
        No import history.
      </Text>
    )
  return (
    <Flex direction="column" gap="3" className="import-history settings-stack">
      <Prose size="2" color="gray" className="section-copy">
        Import history is read-only. It does not approve IDs or restore revoked access. Environment
        review history is limited to the latest 10 reviews.
      </Prose>
      {[...reports]
        .sort(
          (a, b) =>
            failedImports(b.report) - failedImports(a.report) ||
            Number(b.report.reviewRequired === true) - Number(a.report.reviewRequired === true),
        )
        .map(({ name, report }) => (
          <Panel key={name} className="import-report">
            <Flex direction="column" gap="3">
              <Flex align="center" gap="2" wrap="wrap" className="section-heading">
                <Heading as="h4" size="2">
                  {name}
                </Heading>
                {failedImports(report) > 0 && (
                  <Badge color="red">Import failures: review details</Badge>
                )}
                {((typeof report.skippedServers === "number" && report.skippedServers > 0) ||
                  (typeof report.unscannedEntries === "number" && report.unscannedEntries > 0)) && (
                  <Badge color="orange">Incomplete import</Badge>
                )}
                {report.reviewRequired === true && (
                  <Badge color="orange">Review required at import</Badge>
                )}
              </Flex>
              <Text as="p" size="2" className="import-report-summary">
                {typeof report.servers === "number" &&
                  `${countText(report.servers, "server")} imported. `}
                {typeof report.imported === "number" &&
                  `${countText(report.imported, "model setting")} imported. `}
                {Array.isArray(report.failedChatIds) &&
                  `${countText(report.failedChatIds.length, "chat")} failed. `}
                {typeof report.skippedServers === "number" &&
                  `${countText(report.skippedServers, "server")} skipped. `}
                {typeof report.unscannedEntries === "number" &&
                  `${countText(report.unscannedEntries, "entry", "entries")} not scanned. `}
                {Array.isArray(report.decisions) &&
                  `${countText(report.decisions.length, "recorded access decision")}. `}
              </Text>
              <details>
                <summary>Imported IDs and review details</summary>
                <pre>{JSON.stringify(report, null, 2)}</pre>
              </details>
            </Flex>
          </Panel>
        ))}
    </Flex>
  )
}

export const operationNames: Record<string, string> = {
  "tools.register": "Tools registered",
  "skills.register": "Skills registered",
  "settings.update": "Settings saved",
  "settings.apply": "Settings application",
  "chat.model.update": "Chat model changed",
  "chat.access.approve": "Chat access approved",
  "admin.login": "Administrator signed in",
  "admin.logout": "Administrator signed out",
  "admin.passkey.register": "Administrator passkey registered",
  "mcp.import": "MCP configuration imported",
  "mcp.update": "MCP configuration saved",
  "mcp.delete": "MCP server deleted",
  "models.import": "Model settings imported",
  "provider.credential": "Provider credential changed",
  "provider.oauth.complete": "Provider sign-in completed",
}

export const outcomeNames: Record<string, string> = {
  saved: "Saved",
  applied: "Applied",
  failed: "Failed",
  stale: "Superseded",
  completed: "Completed",
  revoked: "Revoked",
  deleted: "Deleted",
  enabled: "Enabled",
  "imported; review required": "Imported — review required",
  "partial; review import report": "Partial import — review report",
}

export function auditValueLabel(field: "operation" | "outcome", value: string) {
  const names = field === "operation" ? operationNames : outcomeNames
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
    <Flex direction="column" gap="2" className="activity-record">
      <dl className="audit-record-fields">
        <div>
          <dt>Timestamp</dt>
          <dd>
            <time dateTime={time.toISOString()}>{time.toLocaleString()}</time>
          </dd>
        </div>
        <div>
          <dt>Actor</dt>
          <dd>{entry.actor}</dd>
        </div>
        <div>
          <dt>Action</dt>
          <dd>{auditValueLabel("operation", entry.operation)}</dd>
        </div>
        <div>
          <dt>Target</dt>
          <dd>
            <Code variant="ghost">{entry.target}</Code>
          </dd>
        </div>
        <div>
          <dt>Result</dt>
          <dd>
            <StatusLabel
              tone={
                entry.outcome === "failed"
                  ? "danger"
                  : entry.outcome === "applied"
                    ? "success"
                    : "neutral"
              }
            >
              {entry.outcome}
            </StatusLabel>
          </dd>
        </div>
      </dl>
      <Disclosure title="Raw audit record">
        <Prose size="2">Revision {entry.revision}. Field-level changes were not recorded.</Prose>
        <pre>{JSON.stringify(entry, null, 2)}</pre>
      </Disclosure>
    </Flex>
  )
}

export function Activity({ entries }: { entries: AuditEntry[] }) {
  if (!entries.length)
    return (
      <Text as="p" size="2" color="gray" className="empty-state">
        No audit records on this page.
      </Text>
    )
  return (
    <ol className="activity" aria-label="Configuration activity">
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
              <Flex
                align="center"
                justify="between"
                gap="2"
                wrap="wrap"
                className="activity-group-heading"
              >
                <Text size="2" weight="medium">
                  {countText(group.length, "save/application record")} ·{" "}
                  {group[0] && new Date(group[0].time).toLocaleString()}
                </Text>
                <Flex gap="2" wrap="wrap">
                  {[...new Set(group.map((entry) => entry.outcome))].map((outcome) => (
                    <Badge
                      key={outcome}
                      color={outcome === "failed" ? "red" : outcome === "applied" ? "teal" : "gray"}
                    >
                      {outcome}
                    </Badge>
                  ))}
                </Flex>
              </Flex>
              <Text as="p" size="2" color="gray">
                {countText(
                  group.filter((entry) => entry.outcome === "failed").length,
                  "failed application",
                )}
                . Field-level changes were not recorded.
              </Text>
              <details open>
                <summary>Individual save and application records</summary>
                <ul className="activity-group-records">
                  {group.map((entry) => (
                    <li key={entry.id}>
                      <AuditRecord entry={entry} />
                    </li>
                  ))}
                </ul>
              </details>
            </>
          )}
        </li>
      ))}
    </ol>
  )
}
