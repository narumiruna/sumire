import { randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { type AnalysisReport, analysisReportSchema, MAX_ANALYSIS_QUEUE } from "../src/analysis.js"
import { AnalysisStore } from "../src/analysis-store.js"
import { renderProposalSvg } from "../src/preview.js"
import { IssueStore, initializeIssueStorage } from "../src/store.js"

let db: DatabaseSync
let issues: IssueStore
let analyses: AnalysisStore
const audit = vi.fn()
const report: AnalysisReport = {
  summary: "改善回饋入口",
  limitations: "尚未讀取原始碼",
  questions: [],
  proposals: [
    {
      title: "集中操作",
      rationale: "讓主要按鈕更容易辨識",
      changes: ["增加清楚的標籤"],
      tradeoffs: "需要更多版面空間",
      preview: {
        title: "概念畫面",
        layout: "stack",
        sections: [{ heading: "工具列", body: "主要操作區", button: "送出" }],
      },
    },
  ],
}
const feedback = (analyze = false) => ({
  requestId: randomUUID(),
  description: "改善按鈕",
  analyze,
  source: { section: "Chats", viewport: { width: 1280, height: 800 } },
})
const create = (analyze = false) => issues.create(feedback(analyze), "42").issue
const input = (revision = 1, context = "") => ({ requestId: randomUUID(), revision, context })
beforeEach(() => {
  db = new DatabaseSync(":memory:")
  db.exec("PRAGMA foreign_keys=ON")
  initializeIssueStorage(db)
  issues = new IssueStore(db, audit)
  analyses = new AnalysisStore(db, audit)
})
afterEach(() => {
  db.close()
  audit.mockReset()
})
describe("analysis queue and versioning", () => {
  it("creates only a session intent without inventing an actual session or model consent", () => {
    const issue = create()
    const intent = analyses.list(issue.id)[0]
    expect(intent).toMatchObject({
      state: "idle",
      attempt: 1,
      sessionId: null,
      conversationId: null,
      model: null,
    })
    expect(intent?.id).toMatch(/^[a-f0-9-]{36}$/)
    expect(analyses.next()?.id).toBe(intent?.id)
  })
  it("backfills existing feedback without retroactive model consent", () => {
    const issue = create()
    db.prepare("DELETE FROM feedback_analyses WHERE issue_id=?").run(issue.id)
    initializeIssueStorage(db)
    expect(analyses.list(issue.id)[0]?.state).toBe("idle")
    initializeIssueStorage(db)
    expect(analyses.list(issue.id)).toHaveLength(1)
  })
  it("idempotently admits one explicit analysis and rejects changed retry context", () => {
    const issue = create()
    const request = { ...input(), requestId: "a1234567-1234-4abc-8def-123456789abc" }
    const upper = { ...request, requestId: request.requestId.toUpperCase() }
    const job = analyses.request(issue.id, upper, "42")
    expect(job).toMatchObject({ state: "queued", attempt: 1 })
    expect(db.prepare("SELECT request_id FROM feedback_analyses WHERE id=?").get(job.id)).toEqual({
      request_id: request.requestId,
    })
    expect(analyses.request(issue.id, request, "42")).toEqual(job)
    expect(() => analyses.request(issue.id, { ...request, context: "changed" }, "42")).toThrow(
      "already used",
    )
    expect(() => analyses.request(issue.id, input(), "42")).toThrow("already admitted")
    expect(() => analyses.request(issue.id, { ...input(), model: "unapproved" }, "42")).toThrow()

    db.prepare("UPDATE feedback_analyses SET request_id=? WHERE id=?").run(upper.requestId, job.id)
    analyses.stop(job.id, "failed", "generation_failed")
    expect(analyses.request(issue.id, request, "42")).toMatchObject({ id: job.id, state: "failed" })
    expect(() => analyses.request(issue.id, request, "43")).toThrow("already used")
    expect(analyses.list(issue.id)).toHaveLength(1)
  })
  it("prioritizes requested work and bounds queue admission without losing feedback", () => {
    create()
    const requested = create(true)
    expect(analyses.next()?.issueId).toBe(requested.id)
    for (let index = 1; index < MAX_ANALYSIS_QUEUE; index++) create(true)
    const overflow = create(true)
    expect(analyses.list(overflow.id)[0]).toMatchObject({ state: "blocked", reason: "queue_full" })
    expect(issues.get(overflow.id)).toBeDefined()
    expect(() => analyses.request(overflow.id, input(), "42")).toThrow("queue is full")
  })
  it("attaches only actual host-created identity metadata and records immutable report versions", () => {
    const issue = create(true)
    const job = analyses.next()
    if (!job) throw new Error("Missing analysis")
    analyses.attach(job.id, "actual-session-id", 7)
    analyses.start(job.id, "provider/model", "off", 12)
    analyses.submitted(job.id, 8)
    analyses.finish(job.id, report)
    const completed = analyses.list(issue.id)[0]
    expect(completed).toMatchObject({
      state: "completed",
      sessionId: "actual-session-id",
      conversationId: 7,
      submissionId: 8,
      report,
    })
    if (!completed) throw new Error("Missing analysis")
    const selected = analyses.select(issue.id, job.id, completed.revision, 0, "42")
    expect(selected.selectedProposal).toBe(0)
    expect(() => analyses.select(issue.id, job.id, completed.revision, 0, "42")).toThrow(
      "version changed",
    )
    expect(() => analyses.select(issue.id, job.id, selected.revision, 1, "42")).toThrow(
      "Unknown proposal",
    )
    const next = analyses.request(issue.id, input(), "42")
    expect(next.attempt).toBe(2)
    expect(() => analyses.select(issue.id, job.id, selected.revision, 0, "42")).toThrow(
      "version changed",
    )
    expect(analyses.list(issue.id)[1]?.report).toEqual(report)
  })
  it("bounds attempts and prevents cancelled/closed work from publishing late", () => {
    const issue = create()
    for (let attempt = 1; attempt <= 3; attempt++) {
      const job = analyses.request(issue.id, input(), "42")
      analyses.start(job.id, "provider/model", "off", 1)
      const active = analyses.job(job.id)
      analyses.cancel(issue.id, job.id, active.revision, "42")
      expect(() => analyses.finish(job.id, report)).toThrow("no longer active")
    }
    expect(() => analyses.request(issue.id, input(), "42")).toThrow("attempt limit")
    const other = create(true)
    const job = analyses.list(other.id)[0]
    if (!job) throw new Error("Missing analysis")
    analyses.start(job.id, "provider/model", "off", 1)
    issues.update(other.id, 1, "closed", "42")
    expect(analyses.job(job.id)).toMatchObject({ state: "cancelled", reason: "issue_closed" })
    expect(() => analyses.request(other.id, input(2), "42")).toThrow("Reopen")
  })
  it("seals active intents closed by an older adapter before worker recovery", () => {
    const issue = create(true)
    db.prepare("UPDATE feedback_issues SET state='closed' WHERE id=?").run(issue.id)
    initializeIssueStorage(db)
    expect(analyses.list(issue.id)[0]).toMatchObject({ state: "cancelled", reason: "issue_closed" })
    expect(analyses.next()).toBeUndefined()
  })
  it("transactionally deletes private reports and schedules session file cleanup", () => {
    const issue = create()
    const job = analyses.list(issue.id)[0]
    if (!job) throw new Error("Missing analysis")
    issues.delete(issue.id, issue.revision, "42")
    expect(() => analyses.job(job.id)).toThrow("not found")
    expect(analyses.garbage()).toEqual([job.id])
    analyses.collected(job.id)
    expect(analyses.garbage()).toEqual([])
  })
  it("keeps deletion compatible with the phase-one adapter during rollback", () => {
    const issue = create()
    const job = analyses.list(issue.id)[0]
    if (!job) throw new Error("Missing analysis")
    db.prepare("DELETE FROM feedback_issues WHERE id=?").run(issue.id)
    expect(() => analyses.job(job.id)).toThrow("not found")
    expect(analyses.garbage()).toContain(job.id)
  })
  it("rolls back report publication and approvals when audit persistence fails", () => {
    const issue = create(true)
    const job = analyses.list(issue.id)[0]
    if (!job) throw new Error("Missing analysis")
    analyses.start(job.id, "provider/model", "off", 1)
    audit.mockImplementationOnce(() => {
      throw new Error("audit failed")
    })
    expect(() => analyses.finish(job.id, report)).toThrow("audit failed")
    expect(analyses.job(job.id).state).toBe("running")
    analyses.finish(job.id, report)
    const completed = analyses.job(job.id)
    audit.mockImplementationOnce(() => {
      throw new Error("audit failed")
    })
    expect(() => analyses.select(issue.id, job.id, completed.revision, 0, "42")).toThrow(
      "audit failed",
    )
    expect(analyses.job(job.id).selectedProposal).toBe(null)
  })
})
describe("structured proposals and inert preview templates", () => {
  it("requires useful proposals or clarification, with bounded structured fields only", () => {
    expect(
      analysisReportSchema.safeParse({ ...report, proposals: [], questions: [] }).success,
    ).toBe(false)
    expect(
      analysisReportSchema.safeParse({ ...report, proposals: [], questions: ["請說明想改哪裡？"] })
        .success,
    ).toBe(true)
    expect(analysisReportSchema.safeParse({ ...report, html: "<script/>" }).success).toBe(false)
    expect(
      analysisReportSchema.safeParse({ ...report, proposals: Array(4).fill(report.proposals[0]) })
        .success,
    ).toBe(false)
  })
  it("escapes markup instead of accepting model-supplied SVG, HTML, scripts or URLs", () => {
    const proposal = structuredClone(report.proposals[0])
    if (!proposal) throw new Error("Missing proposal")
    proposal.preview.title = '<script>alert("x")</script>'
    proposal.preview.sections[0] = {
      heading: '<img src="bad">',
      body: "<foreignObject>unsafe & text</foreignObject>",
      button: "<run>",
    }
    const svg = renderProposalSvg(proposal)
    expect(svg).toContain("&lt;script&gt;")
    expect(svg).toContain("&amp;")
    expect(svg).not.toMatch(/<(script|image|foreignObject)\b/)
    expect(svg).not.toContain("href=")
    expect(svg.length).toBeLessThan(20000)
    proposal.preview.title = "\uD800 broken \u0000 XML"
    expect(() => encodeURIComponent(renderProposalSvg(proposal))).not.toThrow()
    expect(renderProposalSvg(proposal)).not.toContain("\u0000")
  })
})
