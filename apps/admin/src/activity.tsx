import type { AuditEntry, ImportReport } from "@narumitw/sumire-contracts"
import { Badge, Card, Heading, Text } from "@radix-ui/themes"

export type { AuditEntry, ImportReport } from "@narumitw/sumire-contracts"

function failedImports(report: ImportReport["report"]) {
  return Array.isArray(report.failedChatIds) ? report.failedChatIds.length : 0
}

export function ImportHistory({ reports }: { reports: ImportReport[] }) {
  if (!reports.length) return <Text as="p">No import history.</Text>
  return (
    <>
      <Text as="p">
        Import history is read-only. It does not approve IDs or restore revoked access. Environment
        review history is limited to the latest 10 reviews.
      </Text>
      {[...reports]
        .sort(
          (a, b) =>
            failedImports(b.report) - failedImports(a.report) ||
            Number(b.report.reviewRequired === true) - Number(a.report.reviewRequired === true),
        )
        .map(({ name, report }) => (
          <Card key={name}>
            <Heading size="3">{name}</Heading>
            {failedImports(report) > 0 && (
              <Badge color="red">Import failures — review details</Badge>
            )}
            {((typeof report.skippedServers === "number" && report.skippedServers > 0) ||
              (typeof report.unscannedEntries === "number" && report.unscannedEntries > 0)) && (
              <Badge color="orange">Incomplete import</Badge>
            )}
            {report.reviewRequired === true && (
              <Badge color="orange">Review required at import</Badge>
            )}
            <Text as="p" size="2">
              {typeof report.servers === "number" && `${report.servers} servers imported. `}
              {typeof report.imported === "number" &&
                `${report.imported} model settings imported. `}
              {Array.isArray(report.failedChatIds) &&
                `${report.failedChatIds.length} chats failed. `}
              {typeof report.skippedServers === "number" &&
                `${report.skippedServers} servers skipped. `}
              {typeof report.unscannedEntries === "number" &&
                `${report.unscannedEntries} entries not scanned. `}
              {Array.isArray(report.decisions) &&
                `${report.decisions.length} recorded access decisions. `}
            </Text>
            <details>
              <summary>Imported IDs and review details</summary>
              <pre>{JSON.stringify(report, null, 2)}</pre>
            </details>
          </Card>
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

function AuditRecord({ entry }: { entry: AuditEntry }) {
  return (
    <>
      <strong>{operationNames[entry.operation] ?? entry.operation}</strong> — {entry.outcome}
      <Text as="p" size="2">
        <time dateTime={new Date(entry.time).toISOString()}>
          {new Date(entry.time).toLocaleString()}
        </time>
        {` · Actor ${entry.actor} · Revision ${entry.revision} · ${entry.target}`}
      </Text>
      <details>
        <summary>Raw audit record</summary>
        <pre>{JSON.stringify(entry, null, 2)}</pre>
      </details>
    </>
  )
}

export function Activity({ entries }: { entries: AuditEntry[] }) {
  if (!entries.length) return <Text as="p">No audit records on this page.</Text>
  return (
    <ol className="activity" aria-label="Configuration activity">
      {groupActivity(entries).map((group) => (
        <li
          key={group[0]?.id}
          data-outcome={
            group.some((entry) => entry.outcome === "failed") ? "failed" : group[0]?.outcome
          }
        >
          {group.length === 1 ? (
            group[0] && <AuditRecord entry={group[0]} />
          ) : (
            <>
              <strong>
                Revision {group[0]?.revision}: {group.length} save/application records
              </strong>
              <Text as="p">
                {group.filter((entry) => entry.outcome === "failed").length} failed applications.
                Field-level changes were not recorded.
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
        </li>
      ))}
    </ol>
  )
}
