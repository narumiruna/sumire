import type { AuditEntry, ImportReport } from "@narumitw/sumire-contracts"
import { Heading, Separator, Text } from "@radix-ui/themes"
import type { SemanticStatus } from "./semantic-status.js"
import { countText } from "./status-text.js"
import { EmptyState, Panel, Prose, StatusBadge } from "./surfaces.js"

export type { AuditEntry, ImportReport } from "@narumitw/sumire-contracts"

function failedImports(report: ImportReport["report"]) {
  return Array.isArray(report.failedChatIds) ? report.failedChatIds.length : 0
}

export function ImportHistory({ reports }: { reports: ImportReport[] }) {
  if (!reports.length)
    return (
      <EmptyState
        title="No import history."
        description="Import reports appear here after configuration is imported."
      />
    )
  return (
    <>
      <Prose>
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
          <Panel key={name}>
            <Heading size="3">{name}</Heading>
            {failedImports(report) > 0 && (
              <StatusBadge status="failed">Import failures — review details</StatusBadge>
            )}
            {((typeof report.skippedServers === "number" && report.skippedServers > 0) ||
              (typeof report.unscannedEntries === "number" && report.unscannedEntries > 0)) && (
              <StatusBadge status="pending">Incomplete import</StatusBadge>
            )}
            {report.reviewRequired === true && (
              <StatusBadge status="pending">Review required at import</StatusBadge>
            )}
            <Text as="p" size="2">
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
          </Panel>
        ))}
    </>
  )
}

const operationNames: Record<string, string> = {
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

function auditStatus(outcome: string): SemanticStatus {
  switch (outcome) {
    case "failed":
    case "partial; review import report":
      return "failed"
    case "pending":
    case "imported; review required":
      return "pending"
    case "saved":
    case "applied":
    case "completed":
    case "enabled":
    case "deleted":
    case "revoked":
      return "approved"
    default:
      return "unknown"
  }
}

function AuditRecord({ entry }: { entry: AuditEntry }) {
  if (typeof entry.time !== "number" || !Number.isFinite(entry.time)) {
    throw new Error("Audit record time is missing or invalid.")
  }
  const time = new Date(entry.time)
  return (
    <>
      <strong>{operationNames[entry.operation] ?? entry.operation}</strong> —{" "}
      <StatusBadge status={auditStatus(entry.outcome)}>{entry.outcome}</StatusBadge>
      <Text as="p" size="2">
        <time dateTime={time.toISOString()}>{time.toLocaleString()}</time>
        {" · Actor "}
        <span className="numeric">{entry.actor}</span>
        {" · Revision "}
        <span className="numeric">{entry.revision}</span>
        {` · ${entry.target}`}
      </Text>
      <details>
        <summary>Raw audit record</summary>
        <pre>{JSON.stringify(entry, null, 2)}</pre>
      </details>
    </>
  )
}

export function Activity({ entries }: { entries: AuditEntry[] }) {
  if (!entries.length)
    return (
      <EmptyState
        title="No audit records on this page."
        description="Recorded configuration and access changes appear here."
      />
    )
  return (
    <ol className="activity" aria-label="Configuration activity">
      {groupActivity(entries).map((group) => (
        <li
          key={group[0]?.id}
          data-outcome={
            group.some((entry) => entry.outcome === "failed") ? "failed" : group[0]?.outcome
          }
          data-status={
            group.some((entry) => auditStatus(entry.outcome) === "failed")
              ? "failed"
              : auditStatus(group[0]?.outcome ?? "")
          }
        >
          {group.length === 1 ? (
            group[0] && <AuditRecord entry={group[0]} />
          ) : (
            <>
              <strong>
                Revision <span className="numeric">{group[0]?.revision}</span>:{" "}
                <span className="numeric">
                  {countText(group.length, "save/application record")}
                </span>
              </strong>
              <Text as="p">
                {countText(
                  group.filter((entry) => entry.outcome === "failed").length,
                  "failed application",
                )}
                . Field-level changes were not recorded.
              </Text>
              <details>
                <summary>Individual save and application records</summary>
                <ul>
                  {group.map((entry) => (
                    <li key={entry.id}>
                      <AuditRecord entry={entry} />
                    </li>
                  ))}
                </ul>
              </details>
            </>
          )}
          <Separator size="4" mt="3" />
        </li>
      ))}
    </ol>
  )
}
