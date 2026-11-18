import { createHash, randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  feedbackSchema,
  ISSUE_PAGE_SIZE,
  MAX_ATTACHMENT_STORAGE,
  MAX_ISSUES,
  MAX_SCREENSHOT_BYTES,
} from "../src/index.js"
import { IssueStore, initializeIssueStorage } from "../src/store.js"

let directory: string
let db: DatabaseSync
let store: IssueStore
const audit = vi.fn()
const requestId = "a1234567-1234-4abc-8def-123456789abc"
const feedback = (description = "改善這個按鈕") => ({
  requestId: randomUUID(),
  description,
  source: { section: "Chats", viewport: { width: 1280, height: 800 } },
})
beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "sumire-issues-"))
  db = new DatabaseSync(path.join(directory, "issues.sqlite"))
  initializeIssueStorage(db)
  store = new IssueStore(db, audit)
})
afterEach(() => {
  db.close()
  rmSync(directory, { recursive: true, force: true })
  audit.mockReset()
})
describe("feedback contract", () => {
  it("requires content, bounds fields and refuses arbitrary browser context", () => {
    expect(feedbackSchema.safeParse(feedback(" ")).success).toBe(false)
    expect(feedbackSchema.safeParse({ ...feedback(), description: "x".repeat(8001) }).success).toBe(
      false,
    )
    expect(
      feedbackSchema.safeParse({ ...feedback(), source: { ...feedback().source, url: "private" } })
        .success,
    ).toBe(false)
    expect(feedbackSchema.safeParse({ ...feedback(), sessionId: "invented" }).success).toBe(false)
  })
})
describe("issue storage", () => {
  it("persists issues without fabricating an agent session", () => {
    const { issue } = store.create(feedback(), "42")
    expect(issue).toMatchObject({ id: 1, state: "open", revision: 1, hasScreenshot: false })
    expect(issue).not.toHaveProperty("session")
    db.close()
    db = new DatabaseSync(path.join(directory, "issues.sqlite"))
    initializeIssueStorage(db)
    expect(new IssueStore(db).get(issue.id)).toEqual(issue)
  })
  it("deduplicates case-variant submissions and rejects changed retry payloads", () => {
    const input = { ...feedback(), requestId }
    const first = store.create({ ...input, requestId: requestId.toUpperCase() }, "42")
    expect(db.prepare("SELECT request_id FROM feedback_issues").get()).toEqual({
      request_id: requestId,
    })
    expect(store.create(input, "42")).toEqual({ issue: first.issue, created: false })
    expect(() => store.create({ ...input, description: "changed" }, "42")).toThrow(
      expect.objectContaining({ status: 409 }),
    )
    expect(audit).toHaveBeenCalledTimes(1)
  })
  it("matches legacy UUID spellings against their original fingerprints", () => {
    const input = { ...feedback(""), requestId, screenshot: "aGVsbG8=" }
    const image = { bytes: Buffer.from("hello"), mime: "image/png" }
    const { issue } = store.create(input, "42", image)
    const legacy = { ...input, requestId: requestId.toUpperCase() }
    const legacyHash = createHash("sha256").update(JSON.stringify(legacy)).digest("hex")
    db.prepare("UPDATE feedback_issues SET request_id=?, fingerprint=? WHERE id=?").run(
      legacy.requestId,
      legacyHash,
      issue.id,
    )

    expect(store.create(input, "42", image)).toEqual({ issue, created: false })
    expect(store.create(legacy, "42", image)).toEqual({ issue, created: false })
    expect(() => store.create({ ...input, analyze: true }, "42", image)).toThrow(
      expect.objectContaining({ status: 409 }),
    )
    expect(db.prepare("SELECT request_id, fingerprint FROM feedback_issues").get()).toEqual({
      request_id: legacy.requestId,
      fingerprint: legacyHash,
    })
    expect(audit).toHaveBeenCalledTimes(1)
  })
  it("preserves matching historical submissions when UUID spellings already coexist", () => {
    const first = { ...feedback(), requestId: requestId.toUpperCase() }
    const second = { ...feedback("other feedback"), requestId }
    const { issue: oldIssue } = store.create(first, "42")
    db.prepare("UPDATE feedback_issues SET request_id=?, fingerprint=? WHERE id=?").run(
      first.requestId,
      createHash("sha256").update(JSON.stringify(first)).digest("hex"),
      oldIssue.id,
    )
    const { issue: otherIssue } = store.create({ ...second, requestId: randomUUID() }, "42")
    db.prepare("UPDATE feedback_issues SET request_id=?, fingerprint=? WHERE id=?").run(
      second.requestId,
      createHash("sha256").update(JSON.stringify(second)).digest("hex"),
      otherIssue.id,
    )

    expect(store.create({ ...first, requestId }, "42")).toEqual({
      issue: oldIssue,
      created: false,
    })
    expect(store.create({ ...second, requestId: first.requestId }, "42")).toEqual({
      issue: otherIssue,
      created: false,
    })
    expect(audit).toHaveBeenCalledTimes(2)
  })
  it("scopes retry keys to the authenticated actor", () => {
    const input = feedback()
    expect(store.create(input, "42").issue.id).not.toBe(store.create(input, "43").issue.id)
  })
  it("accepts image-only feedback and separates bytes from bounded list/detail projections", () => {
    const input = { ...feedback(""), screenshot: "aGVsbG8=" }
    const { issue } = store.create(input, "42", { bytes: Buffer.from("hello"), mime: "image/png" })
    expect(issue.title).toBe("畫面回饋 — Chats")
    expect(issue.hasScreenshot).toBe(true)
    expect(Buffer.from(store.attachment(issue.id).bytes)).toEqual(Buffer.from("hello"))
    expect(store.list().issues[0]).not.toHaveProperty("description")
    expect(JSON.stringify(store.get(issue.id))).not.toContain(input.screenshot)
    expect(audit.mock.calls[0]).toEqual(["42", "issue.create", issue.id])
  })
  it("rejects missing, mismatched and oversized attachment envelopes", () => {
    expect(() => store.create({ ...feedback(""), screenshot: "aGVsbG8=" }, "42")).toThrow(
      "Invalid screenshot",
    )
    expect(() =>
      store.create(feedback(), "42", { bytes: Buffer.from("x"), mime: "image/png" }),
    ).toThrow("Invalid screenshot")
    expect(() =>
      store.create({ ...feedback(""), screenshot: "aGVsbG8=" }, "42", {
        bytes: Buffer.alloc(MAX_SCREENSHOT_BYTES + 1),
        mime: "image/png",
      }),
    ).toThrow("Invalid screenshot")
  })
  it("paginates newest-first without repeating rows after concurrent insertion", () => {
    const ids = Array.from(
      { length: ISSUE_PAGE_SIZE + 2 },
      () => store.create(feedback(), "42").issue.id,
    ).reverse()
    const first = store.list()
    const { issue: inserted } = store.create(feedback(), "42")
    const second = store.list(first.next ?? undefined)
    expect(first.issues.map((issue) => issue.id)).toEqual(ids.slice(0, ISSUE_PAGE_SIZE))
    expect(first.next).toBe(ids[ISSUE_PAGE_SIZE - 1])
    const secondIds = second.issues.map((issue) => issue.id)
    expect(secondIds).toEqual(ids.slice(ISSUE_PAGE_SIZE))
    expect(secondIds).not.toContain(inserted.id)
    expect(second.next).toBe(null)
  })
  it("uses optimistic revisions for close, reopen and delete", () => {
    const { issue } = store.create(feedback(), "42")
    const closed = store.update(issue.id, 1, "closed", "42")
    expect(closed).toMatchObject({ revision: 2, state: "closed" })
    expect(store.list(undefined, "open").issues).toEqual([])
    expect(() => store.update(issue.id, 1, "open", "42")).toThrow("Issue changed")
    expect(() => store.delete(issue.id, 1, "42")).toThrow("Issue changed")
    const reopened = store.update(issue.id, 2, "open", "42")
    store.delete(issue.id, reopened.revision, "42")
    expect(() => store.get(issue.id)).toThrow("not found")
    expect(() => store.attachment(issue.id)).toThrow("not found")
  })
  it("keeps idempotent state updates from incrementing the revision", () => {
    const { issue } = store.create(feedback(), "42")
    expect(store.update(issue.id, 1, "open", "42")).toEqual(issue)
    expect(audit).toHaveBeenCalledTimes(1)
  })
  it("rolls back both creation and state changes when audit persistence fails", () => {
    audit.mockImplementationOnce(() => {
      throw new Error("audit failed")
    })
    expect(() => store.create(feedback(), "42")).toThrow("audit failed")
    expect(store.list().issues).toEqual([])
    const { issue } = store.create(feedback(), "42")
    audit.mockImplementationOnce(() => {
      throw new Error("audit failed")
    })
    expect(() => store.update(issue.id, 1, "closed", "42")).toThrow("audit failed")
    expect(store.get(issue.id).revision).toBe(1)
  })
  it("preserves an audit error when SQLite has already rolled back", () => {
    db.exec("CREATE TABLE audit_guard (id INTEGER PRIMARY KEY); INSERT INTO audit_guard VALUES (1)")
    audit.mockImplementationOnce(() => {
      db.exec("INSERT OR ROLLBACK INTO audit_guard VALUES (1)")
    })
    expect(() => store.create(feedback(), "42")).toThrow("UNIQUE constraint failed: audit_guard.id")
    expect(db.isTransaction).toBe(false)
    expect(store.list().issues).toEqual([])
  })
  it("preserves an audit error even if rollback fails", () => {
    const exec = db.exec.bind(db)
    const cleanup = vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (sql === "ROLLBACK") throw new Error("rollback failed")
      exec(sql)
    })
    audit.mockImplementationOnce(() => {
      throw new Error("audit failed")
    })
    try {
      expect(() => store.create(feedback(), "42")).toThrow("audit failed")
      expect(cleanup).toHaveBeenCalledWith("ROLLBACK")
    } finally {
      cleanup.mockRestore()
      if (db.isTransaction) db.exec("ROLLBACK")
    }
  })
  it("bounds total issue count while permitting existing retries", () => {
    const input = feedback()
    const first = store.create(input, "42")
    db.exec("BEGIN")
    const seed = db.prepare(`INSERT INTO feedback_issues
      (actor, request_id, fingerprint, description, source, title, state, screenshot, mime, created, updated, revision)
      SELECT actor, ?, fingerprint, description, source, title, state, screenshot, mime, created, updated, revision FROM feedback_issues WHERE id=?`)
    for (let index = 1; index < MAX_ISSUES; index++) seed.run(randomUUID(), first.issue.id)
    db.exec("COMMIT")
    expect(() => store.create(feedback(), "42")).toThrow("storage is full")
    expect(store.create(input, "42").issue.id).toBe(first.issue.id)
  })
  it("bounds aggregate attachment bytes and frees quota after deletion", () => {
    const memory = new DatabaseSync(":memory:")
    try {
      initializeIssueStorage(memory)
      const issues = new IssueStore(memory)
      const { issue } = issues.create(feedback(), "42")
      memory
        .prepare("UPDATE feedback_issues SET screenshot=zeroblob(?) WHERE id=?")
        .run(MAX_ATTACHMENT_STORAGE, issue.id)
      const image = { ...feedback(""), screenshot: "aGVsbG8=" }
      const raster = { bytes: Buffer.from("hello"), mime: "image/png" }
      expect(() => issues.create(image, "42", raster)).toThrow("storage is full")
      expect(issues.create(feedback("text still fits"), "42").created).toBe(true)
      issues.delete(issue.id, issue.revision, "42")
      expect(issues.create(image, "42", raster).created).toBe(true)
    } finally {
      memory.close()
    }
  })
  it("never reuses a deleted ID", () => {
    const { issue } = store.create(feedback(), "42")
    store.delete(issue.id, issue.revision, "42")
    expect(store.create(feedback(), "42").issue.id).toBeGreaterThan(issue.id)
  })
})
