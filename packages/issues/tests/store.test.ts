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
  it("deduplicates identical submissions and rejects changed retry payloads", () => {
    const input = feedback()
    const first = store.create(input, "42")
    expect(store.create(input, "42")).toEqual({ issue: first.issue, created: false })
    expect(() => store.create({ ...input, description: "changed" }, "42")).toThrow("already used")
    expect(audit).toHaveBeenCalledTimes(1)
  })
  it("normalizes UUID case before retry lookup and fingerprinting", () => {
    const input = { ...feedback(), requestId: "a1234567-1234-4abc-8def-123456789abc" }
    const first = store.create({ ...input, requestId: input.requestId.toUpperCase() }, "42")
    expect(store.create(input, "42")).toEqual({ issue: first.issue, created: false })
    expect(() => store.create({ ...input, description: "changed" }, "42")).toThrow("already used")
    expect(store.list().issues).toHaveLength(1)
    expect(db.prepare("SELECT request_id FROM feedback_issues").get()?.request_id).toBe(
      input.requestId,
    )
  })
  it("recognizes case-variant retries of legacy uppercase UUIDs without duplicating old rows", () => {
    const input = { ...feedback(), requestId: "A1234567-1234-4ABC-8DEF-123456789ABC" }
    const first = store.create(input, "42")
    const oldHash = createHash("sha256").update(JSON.stringify(input)).digest("hex")
    db.prepare("UPDATE feedback_issues SET request_id=?, fingerprint=? WHERE id=?").run(
      input.requestId,
      oldHash,
      first.issue.id,
    )
    expect(
      store.create({ ...input, requestId: input.requestId.toLowerCase() }, "42").issue.id,
    ).toBe(first.issue.id)
    expect(() => store.create({ ...input, description: "changed" }, "42")).toThrow("already used")
    expect(store.list().issues).toHaveLength(1)
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
  it("does not materialize descriptions when querying the metadata list", () => {
    const { issue } = store.create(feedback("private description"), "42")
    const query = vi.spyOn(db, "prepare")
    try {
      store.list()
      expect(query.mock.calls[0]?.[0]).not.toContain("description")
      expect(store.get(issue.id).description).toBe("private description")
      expect(query.mock.calls[1]?.[0]).toContain("description")
    } finally {
      query.mockRestore()
    }
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
    for (let index = 0; index < ISSUE_PAGE_SIZE + 2; index++) store.create(feedback(), "42")
    const first = store.list()
    const inserted = store.create(feedback(), "42").issue
    const second = store.list(first.next ?? undefined)
    expect(first.issues).toHaveLength(ISSUE_PAGE_SIZE)
    expect(second.issues).toHaveLength(2)
    expect(first.issues.map((issue) => issue.id)).toEqual(
      Array.from({ length: ISSUE_PAGE_SIZE }, (_, index) => ISSUE_PAGE_SIZE + 2 - index),
    )
    expect(second.issues.map((issue) => issue.id)).toEqual([2, 1])
    expect(second.issues.map((issue) => issue.id)).not.toContain(inserted.id)
    expect(second.next).toBe(null)
    expect(first.issues.some((issue) => second.issues.some((other) => other.id === issue.id))).toBe(
      false,
    )
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
