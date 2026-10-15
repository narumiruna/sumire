import { Badge, Card, Heading, Text } from "@radix-ui/themes"

export type AuditEntry = {
  id: number
  time: number
  actor: string
  operation: string
  revision: number
  outcome: string
  target: string
}
export type ImportReport = { name: string; report: Record<string, unknown> }

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

export function Activity({ entries }: { entries: AuditEntry[] }) {
  if (!entries.length) return <Text as="p">No audit records on this page.</Text>
  return (
    <ol className="activity" aria-label="Configuration activity">
      {entries.map((entry) => (
        <li key={entry.id} data-outcome={entry.outcome}>
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
        </li>
      ))}
    </ol>
  )
}
