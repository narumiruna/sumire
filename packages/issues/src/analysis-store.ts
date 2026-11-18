import { randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import {
  ANALYSIS_TIMEOUT_MS,
  type AnalysisReason,
  type AnalysisState,
  analysisReportSchema,
  analysisRequestSchema,
  type IssueAnalysis,
  MAX_ANALYSIS_ATTEMPTS,
  MAX_ANALYSIS_QUEUE,
} from "./analysis.js"
import { IssueError } from "./errors.js"
import { transaction } from "./transaction.js"

export function initializeAnalysisStorage(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS feedback_analyses (
    id TEXT PRIMARY KEY, issue_id INTEGER NOT NULL REFERENCES feedback_issues(id),
    attempt INTEGER NOT NULL, actor TEXT NOT NULL, request_id TEXT, context TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL, reason TEXT, session_id TEXT, conversation_id INTEGER, submission_id INTEGER,
    model TEXT, thinking TEXT, policy_revision INTEGER, deadline INTEGER, report TEXT,
    selected_proposal INTEGER, revision INTEGER NOT NULL DEFAULT 1, created INTEGER NOT NULL, updated INTEGER NOT NULL,
    UNIQUE(issue_id, attempt), UNIQUE(issue_id, request_id)
  );
  CREATE INDEX IF NOT EXISTS feedback_analyses_queue ON feedback_analyses(state, created);
  CREATE TABLE IF NOT EXISTS feedback_analysis_gc (id TEXT PRIMARY KEY);
  CREATE TRIGGER IF NOT EXISTS feedback_issues_analysis_delete BEFORE DELETE ON feedback_issues BEGIN
    INSERT OR IGNORE INTO feedback_analysis_gc SELECT id FROM feedback_analyses WHERE issue_id=OLD.id;
    DELETE FROM feedback_analyses WHERE issue_id=OLD.id;
  END;
  `)
  // Existing feedback gets empty local sessions, never retroactive model consent.
  const missing = db
    .prepare(
      "SELECT id, actor FROM feedback_issues WHERE NOT EXISTS (SELECT 1 FROM feedback_analyses WHERE issue_id=feedback_issues.id)",
    )
    .all() as { id: number; actor: string }[]
  for (const issue of missing) insertInitialAnalysis(db, issue.id, issue.actor, false)
  db.prepare(
    "UPDATE feedback_analyses SET state='cancelled', reason='issue_closed', updated=?, revision=revision+1 WHERE state IN ('idle','queued','running','blocked') AND issue_id IN (SELECT id FROM feedback_issues WHERE state='closed')",
  ).run(Date.now())
}
export function insertInitialAnalysis(
  db: DatabaseSync,
  issueId: number,
  actor: string,
  requested: boolean,
  policyRevision: number | null = null,
) {
  const count = db
    .prepare("SELECT count(*) AS count FROM feedback_analyses WHERE state IN ('queued','running')")
    .get() as { count: number }
  const full = requested && count.count >= MAX_ANALYSIS_QUEUE
  const now = Date.now()
  db.prepare(`INSERT INTO feedback_analyses (id, issue_id, attempt, actor, state, reason, created, updated, policy_revision)
    VALUES (?,?,1,?,?,?,?,?,?)`).run(
    randomUUID(),
    issueId,
    actor,
    full ? "blocked" : requested ? "queued" : "idle",
    full ? "queue_full" : null,
    now,
    now,
    requested ? policyRevision : null,
  )
}
interface Row {
  id: string
  issue_id: number
  attempt: number
  actor: string
  request_id: string | null
  context: string
  state: AnalysisState
  reason: AnalysisReason | null
  session_id: string | null
  conversation_id: number | null
  submission_id: number | null
  model: string | null
  thinking: string | null
  policy_revision: number | null
  deadline: number | null
  report: string | null
  selected_proposal: number | null
  revision: number
  created: number
  updated: number
}
export interface AnalysisJob extends IssueAnalysis {
  actor: string
  context: string
  thinking: string | null
  policyRevision: number | null
}
function project(row: Row): IssueAnalysis {
  return {
    id: row.id,
    issueId: row.issue_id,
    attempt: row.attempt,
    state: row.state,
    reason: row.reason,
    sessionId: row.session_id,
    conversationId: row.conversation_id,
    submissionId: row.submission_id,
    model: row.model,
    deadline: row.deadline,
    createdAt: row.created,
    updatedAt: row.updated,
    report: row.report ? analysisReportSchema.parse(JSON.parse(row.report)) : null,
    selectedProposal: row.selected_proposal,
    revision: row.revision,
  }
}
export class AnalysisStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly audit: (actor: string, operation: string, id: number) => void = () => {},
  ) {}
  private transaction<T>(work: () => T): T {
    return transaction(this.db, work)
  }
  private row(id: string): Row {
    const row = this.db.prepare("SELECT * FROM feedback_analyses WHERE id=?").get(id) as
      | Row
      | undefined
    if (!row) throw new IssueError(404, "Analysis not found")
    return row
  }
  private issue(id: number, revision?: number) {
    const issue = this.db
      .prepare("SELECT state, revision FROM feedback_issues WHERE id=?")
      .get(id) as { state: string; revision: number } | undefined
    if (!issue) throw new IssueError(404, "Issue not found")
    if (revision !== undefined && revision !== issue.revision)
      throw new IssueError(409, "Issue changed. Refresh before trying again.")
    return issue
  }
  list(issueId: number): IssueAnalysis[] {
    this.issue(issueId)
    return (
      this.db
        .prepare("SELECT * FROM feedback_analyses WHERE issue_id=? ORDER BY attempt DESC")
        .all(issueId) as unknown as Row[]
    ).map(project)
  }
  job(id: string): AnalysisJob {
    const row = this.row(id)
    return {
      ...project(row),
      actor: row.actor,
      context: row.context,
      thinking: row.thinking,
      policyRevision: row.policy_revision,
    }
  }
  request(
    issueId: number,
    input: unknown,
    actor: string,
    policyRevision: number | null = null,
  ): IssueAnalysis {
    const request = analysisRequestSchema.parse(input)
    return this.transaction(() => {
      if (this.issue(issueId, request.revision).state !== "open")
        throw new IssueError(409, "Reopen the issue before requesting analysis")
      const existing = this.db
        .prepare(
          "SELECT * FROM feedback_analyses WHERE issue_id=? AND request_id=? COLLATE NOCASE ORDER BY attempt LIMIT 1",
        )
        .get(issueId, request.requestId) as Row | undefined
      if (existing) {
        if (existing.actor !== actor || existing.context !== request.context)
          throw new IssueError(409, "Analysis submission ID was already used")
        return project(existing)
      }
      const latest = this.db
        .prepare("SELECT * FROM feedback_analyses WHERE issue_id=? ORDER BY attempt DESC LIMIT 1")
        .get(issueId) as unknown as Row
      if (["queued", "running"].includes(latest.state))
        throw new IssueError(409, "An analysis is already admitted")
      const usage = this.db
        .prepare(
          "SELECT count(*) AS count FROM feedback_analyses WHERE state IN ('queued','running')",
        )
        .get() as { count: number }
      if (usage.count >= MAX_ANALYSIS_QUEUE) throw new IssueError(429, "Analysis queue is full")
      const now = Date.now()
      if (latest.state === "idle") {
        this.db
          .prepare(
            "UPDATE feedback_analyses SET state='queued', request_id=?, context=?, actor=?, updated=?, policy_revision=?, revision=revision+1 WHERE id=?",
          )
          .run(request.requestId, request.context, actor, now, policyRevision, latest.id)
        this.audit(actor, "issue.analysis.request", issueId)
        return project(this.row(latest.id))
      }
      if (latest.attempt >= MAX_ANALYSIS_ATTEMPTS)
        throw new IssueError(409, "Analysis attempt limit reached")
      const id = randomUUID()
      this.db
        .prepare(`INSERT INTO feedback_analyses (id,issue_id,attempt,actor,request_id,context,state,created,updated,policy_revision)
        VALUES (?,?,?,?,?,?,'queued',?,?,?)`)
        .run(
          id,
          issueId,
          latest.attempt + 1,
          actor,
          request.requestId,
          request.context,
          now,
          now,
          policyRevision,
        )
      this.audit(actor, "issue.analysis.request", issueId)
      return project(this.row(id))
    })
  }
  next(): AnalysisJob | undefined {
    const row = this.db
      .prepare(`SELECT a.* FROM feedback_analyses a JOIN feedback_issues i ON i.id=a.issue_id
      WHERE i.state='open' AND (a.state IN ('queued','running') OR (a.session_id IS NULL AND a.state IN ('idle','blocked')))
      ORDER BY CASE WHEN a.state IN ('queued','running') THEN 0 ELSE 1 END, a.created LIMIT 1`)
      .get() as Row | undefined
    return row ? this.job(row.id) : undefined
  }
  attach(id: string, sessionId: string, conversationId: number) {
    this.db
      .prepare(
        "UPDATE feedback_analyses SET session_id=?, conversation_id=?, updated=?, revision=revision+1 WHERE id=? AND session_id IS NULL",
      )
      .run(sessionId, conversationId, Date.now(), id)
  }
  start(id: string, model: string, thinking: string, policyRevision: number): AnalysisJob {
    this.db
      .prepare(`UPDATE feedback_analyses SET state='running', model=?, thinking=?, policy_revision=?, deadline=?, updated=?, revision=revision+1
      WHERE id=? AND state='queued'`)
      .run(model, thinking, policyRevision, Date.now() + ANALYSIS_TIMEOUT_MS, Date.now(), id)
    return this.job(id)
  }
  submitted(id: string, submissionId: number) {
    this.db
      .prepare(
        "UPDATE feedback_analyses SET submission_id=?, updated=? WHERE id=? AND state='running'",
      )
      .run(submissionId, Date.now(), id)
  }
  finish(id: string, report: unknown) {
    const parsed = analysisReportSchema.parse(report)
    this.transaction(() => {
      const row = this.row(id)
      if (row.state !== "running" || this.issue(row.issue_id).state !== "open")
        throw new IssueError(409, "Analysis is no longer active")
      this.db
        .prepare(
          "UPDATE feedback_analyses SET state='completed', reason=NULL, report=?, updated=?, revision=revision+1 WHERE id=?",
        )
        .run(JSON.stringify(parsed), Date.now(), id)
      this.audit(row.actor, "issue.analysis.completed", row.issue_id)
    })
  }
  stop(id: string, state: "blocked" | "failed", reason: AnalysisReason) {
    this.db
      .prepare(
        "UPDATE feedback_analyses SET state=?, reason=?, updated=?, revision=revision+1 WHERE id=? AND state IN ('idle','queued','running','blocked')",
      )
      .run(state, reason, Date.now(), id)
  }
  cancel(issueId: number, id: string, revision: number, actor: string): IssueAnalysis {
    return this.transaction(() => {
      this.issue(issueId)
      const row = this.row(id)
      if (row.issue_id !== issueId) throw new IssueError(404, "Analysis not found")
      if (row.revision !== revision)
        throw new IssueError(409, "Analysis changed. Refresh before trying again.")
      if (!["idle", "queued", "running", "blocked"].includes(row.state))
        throw new IssueError(409, "Analysis is not active")
      this.db
        .prepare(
          "UPDATE feedback_analyses SET state='cancelled', reason='cancelled', updated=?, revision=revision+1 WHERE id=?",
        )
        .run(Date.now(), id)
      this.audit(actor, "issue.analysis.cancel", issueId)
      return project(this.row(id))
    })
  }
  select(
    issueId: number,
    id: string,
    revision: number,
    proposal: number | null,
    actor: string,
  ): IssueAnalysis {
    return this.transaction(() => {
      if (this.issue(issueId).state !== "open")
        throw new IssueError(409, "Reopen the issue before selecting a proposal")
      const row = this.row(id)
      if (row.issue_id !== issueId) throw new IssueError(404, "Analysis not found")
      const latest = this.db
        .prepare("SELECT id FROM feedback_analyses WHERE issue_id=? ORDER BY attempt DESC LIMIT 1")
        .get(issueId) as { id: string }
      if (row.state !== "completed" || latest.id !== id || row.revision !== revision)
        throw new IssueError(409, "Proposal version changed. Refresh before selecting.")
      const report = analysisReportSchema.parse(JSON.parse(row.report ?? "null"))
      if (
        proposal !== null &&
        (!Number.isInteger(proposal) || proposal < 0 || proposal >= report.proposals.length)
      )
        throw new IssueError(400, "Unknown proposal")
      this.db
        .prepare(
          "UPDATE feedback_analyses SET selected_proposal=?, updated=?, revision=revision+1 WHERE id=?",
        )
        .run(proposal, Date.now(), id)
      this.audit(actor, "issue.proposal.select", issueId)
      return project(this.row(id))
    })
  }
  garbage(): string[] {
    return (
      this.db.prepare("SELECT id FROM feedback_analysis_gc LIMIT 32").all() as { id: string }[]
    ).map((row) => row.id)
  }
  collected(id: string) {
    this.db.prepare("DELETE FROM feedback_analysis_gc WHERE id=?").run(id)
  }
}
