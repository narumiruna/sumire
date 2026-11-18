import { createHash } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import { initializeAnalysisStorage, insertInitialAnalysis } from "./analysis-store.js"
import { IssueError } from "./errors.js"
import {
  type Feedback,
  feedbackSchema,
  ISSUE_PAGE_SIZE,
  type Issue,
  type IssuePage,
  type IssueState,
  type IssueSummary,
  MAX_ATTACHMENT_STORAGE,
  MAX_ISSUES,
  MAX_SCREENSHOT_BYTES,
} from "./index.js"
import { transaction } from "./transaction.js"

export { IssueError } from "./errors.js"
export function initializeIssueStorage(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS feedback_issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
    description TEXT NOT NULL, source TEXT NOT NULL, title TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('open','closed')),
    screenshot BLOB, mime TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1, UNIQUE(actor, request_id)
  );`)
  initializeAnalysisStorage(db)
}
interface SummaryRow {
  id: number
  source: string
  title: string
  state: IssueState
  hasScreenshot: number
  created: number
  updated: number
  revision: number
}
type DetailRow = SummaryRow & { description: string }
const summaryColumns =
  "id, source, title, state, screenshot IS NOT NULL AS hasScreenshot, created, updated, revision"
function summary(row: SummaryRow): IssueSummary {
  const source = JSON.parse(row.source) as Issue["source"]
  return {
    id: row.id,
    title: row.title,
    state: row.state,
    section: source.section,
    hasScreenshot: Boolean(row.hasScreenshot),
    createdAt: row.created,
    updatedAt: row.updated,
    revision: row.revision,
  }
}
function fingerprint(feedback: Feedback, requestId = feedback.requestId): string {
  const canonical: Partial<Feedback> = { ...feedback, requestId }
  if (!canonical.analyze) delete canonical.analyze
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex")
}
/** Host owns the connection and lifecycle. All writes and audit callbacks share one transaction. */
export class IssueStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly audit: (actor: string, operation: string, id: number) => void = () => {},
    private readonly analysisRevision: () => number | null = () => null,
  ) {}
  create(
    input: unknown,
    actor: string,
    image?: { bytes: Uint8Array; mime: string },
  ): { issue: Issue; created: boolean } {
    const feedback = feedbackSchema.parse(input)
    if (
      Boolean(feedback.screenshot) !== Boolean(image) ||
      (image &&
        (image.bytes.byteLength > MAX_SCREENSHOT_BYTES ||
          !["image/png", "image/jpeg", "image/webp"].includes(image.mime)))
    )
      throw new IssueError(400, "Invalid screenshot")
    const digest = fingerprint(feedback)
    return transaction(this.db, () => {
      const existing = this.db
        .prepare(
          "SELECT id, request_id, fingerprint FROM feedback_issues WHERE actor=? AND request_id=? COLLATE NOCASE ORDER BY id",
        )
        .all(actor, feedback.requestId) as { id: number; request_id: string; fingerprint: string }[]
      if (existing.length) {
        // Legacy hashes include the UUID as it was submitted. Keep old issues and hashes intact.
        const match = existing.find(
          (row) =>
            row.fingerprint ===
            (row.request_id === feedback.requestId
              ? digest
              : fingerprint(feedback, row.request_id)),
        )
        if (!match)
          throw new IssueError(409, "This submission ID was already used for different feedback")
        return { issue: this.get(match.id), created: false }
      }
      const usage = this.db
        .prepare(
          "SELECT count(*) AS count, coalesce(sum(length(screenshot)),0) AS bytes FROM feedback_issues",
        )
        .get() as { count: number; bytes: number }
      if (
        usage.count >= MAX_ISSUES ||
        usage.bytes + (image?.bytes.byteLength ?? 0) > MAX_ATTACHMENT_STORAGE
      )
        throw new IssueError(
          413,
          "Issue storage is full. Delete older feedback before submitting again.",
        )
      const now = Date.now()
      const title =
        feedback.description.split(/\r?\n/, 1)[0]?.slice(0, 100) ||
        `畫面回饋 — ${feedback.source.section}`
      const result = this.db
        .prepare(`INSERT INTO feedback_issues
        (actor, request_id, fingerprint, description, source, title, state, screenshot, mime, created, updated)
        VALUES (?,?,?,?,?,?,'open',?,?,?,?)`)
        .run(
          actor,
          feedback.requestId,
          digest,
          feedback.description,
          JSON.stringify(feedback.source),
          title,
          image?.bytes ?? null,
          image?.mime ?? null,
          now,
          now,
        )
      const id = Number(result.lastInsertRowid)
      insertInitialAnalysis(this.db, id, actor, Boolean(feedback.analyze), this.analysisRevision())
      this.audit(actor, "issue.create", id)
      return { issue: this.get(id), created: true }
    })
  }
  list(before?: number, state?: IssueState): IssuePage {
    const rows = this.db
      .prepare(
        `SELECT ${summaryColumns} FROM feedback_issues WHERE id < ? AND (? IS NULL OR state=?) ORDER BY id DESC LIMIT ?`,
      )
      .all(
        before ?? Number.MAX_SAFE_INTEGER,
        state ?? null,
        state ?? null,
        ISSUE_PAGE_SIZE + 1,
      ) as unknown as SummaryRow[]
    const more = rows.length > ISSUE_PAGE_SIZE
    const visible = rows.slice(0, ISSUE_PAGE_SIZE)
    return { issues: visible.map(summary), next: more ? (visible.at(-1)?.id ?? null) : null }
  }
  get(id: number): Issue {
    const row = this.db
      .prepare(`SELECT ${summaryColumns}, description FROM feedback_issues WHERE id=?`)
      .get(id) as DetailRow | undefined
    if (!row) throw new IssueError(404, "Issue not found")
    return {
      ...summary(row),
      description: row.description,
      source: JSON.parse(row.source) as Issue["source"],
    }
  }
  attachment(id: number): { bytes: Uint8Array; mime: string } {
    const row = this.db
      .prepare("SELECT screenshot, mime FROM feedback_issues WHERE id=? AND screenshot IS NOT NULL")
      .get(id) as { screenshot: Uint8Array; mime: string } | undefined
    if (!row) throw new IssueError(404, "Screenshot not found")
    return { bytes: row.screenshot, mime: row.mime }
  }
  update(id: number, revision: number, state: IssueState, actor: string): Issue {
    return transaction(this.db, () => {
      const issue = this.get(id)
      if (issue.revision !== revision)
        throw new IssueError(409, "Issue changed. Refresh before trying again.")
      if (issue.state === state) return issue
      this.db
        .prepare("UPDATE feedback_issues SET state=?, updated=?, revision=revision+1 WHERE id=?")
        .run(state, Date.now(), id)
      if (state === "closed")
        this.db
          .prepare(
            "UPDATE feedback_analyses SET state='cancelled', reason='issue_closed', updated=?, revision=revision+1 WHERE issue_id=? AND state IN ('idle','queued','running','blocked')",
          )
          .run(Date.now(), id)
      this.audit(actor, `issue.${state}`, id)
      return this.get(id)
    })
  }
  delete(id: number, revision: number, actor: string) {
    transaction(this.db, () => {
      const issue = this.get(id)
      if (issue.revision !== revision)
        throw new IssueError(409, "Issue changed. Refresh before trying again.")
      // Overwrite deleted SQLite pages; snapshots/backups require separate retention controls.
      this.db.exec("PRAGMA secure_delete = ON")
      this.db
        .prepare(
          "INSERT OR IGNORE INTO feedback_analysis_gc SELECT id FROM feedback_analyses WHERE issue_id=?",
        )
        .run(id)
      this.db.prepare("DELETE FROM feedback_analyses WHERE issue_id=?").run(id)
      this.db.prepare("DELETE FROM feedback_issues WHERE id=?").run(id)
      this.audit(actor, "issue.delete", id)
    })
  }
}
