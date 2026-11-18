import { randomUUID } from "node:crypto"
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { expect, it, vi } from "vitest"
import { PNG } from "../../../packages/imagegen/tests/fixtures.js"
import { IssueAnalysisRuntime } from "../src/issues/runtime.js"
import { report } from "./helpers/issue-report.js"
import { createPiFixture } from "./helpers/pi-fixture.js"

async function fixture() {
  const f = await createPiFixture()
  const store = f.factory.control
  const snapshot = store.snapshot()
  snapshot.policy.defaults.thinking = "off"
  snapshot.policy.providers = [{ id: "openai", enabled: true, models: [] }]
  store.save(snapshot.policy, snapshot.revision, "7")
  store.applied(store.snapshot().revision, true)
  const directory = path.join(f.root, "issue-analysis")
  const options = { store, runtime: f.modelRuntime, directory }
  let worker = new IssueAnalysisRuntime(options)
  return {
    ...f,
    get pendingReplies() {
      return f.pendingReplies
    },
    store,
    directory,
    get worker() {
      return worker
    },
    restart() {
      worker = new IssueAnalysisRuntime(options)
    },
    create(analyze = false) {
      return worker.issues.create(
        {
          requestId: randomUUID(),
          description: "找不到按鈕",
          analyze,
          source: { section: "Chats", viewport: { width: 1280, height: 800 } },
        },
        "7",
      ).issue
    },
    async close() {
      await worker.close()
      await f.cleanup()
    },
  }
}
it("creates real local sessions without retroactive model consent; explicit analysis publishes one report", async () => {
  const f = await fixture()
  try {
    const issue = f.create()
    await f.worker.wake()
    const idle = f.worker.analyses.list(issue.id)[0]
    expect(idle).toMatchObject({
      state: "idle",
      sessionId: expect.any(String),
      conversationId: expect.any(Number),
      submissionId: null,
    })
    expect(f.requests).toHaveLength(0)
    f.enqueue("publish_issue_proposals", report, false)
    f.worker.request(issue.id, { requestId: randomUUID(), revision: issue.revision }, "7")
    await f.worker.wake()
    const complete = f.worker.analyses.list(issue.id)[0]
    expect(complete).toMatchObject({
      state: "completed",
      report,
      sessionId: idle?.sessionId,
      submissionId: expect.any(Number),
      model: "openai/gpt-6.1-sol",
    })
    expect(f.requests).toHaveLength(1)
    await f.worker.wake()
    expect(f.requests).toHaveLength(1)
  } finally {
    await f.close()
  }
})
it("retains feedback and a real session while model configuration is blocked, then retries only on explicit request", async () => {
  const f = await fixture()
  try {
    let snapshot = f.store.snapshot()
    snapshot.policy.providers = []
    f.store.save(snapshot.policy, snapshot.revision, "7")
    f.store.applied(f.store.snapshot().revision, true)
    const issue = f.create(true)
    await f.worker.wake()
    const blocked = f.worker.analyses.list(issue.id)[0]
    expect(blocked).toMatchObject({
      state: "blocked",
      reason: "model_unavailable",
      sessionId: expect.any(String),
    })
    expect(f.worker.issues.get(issue.id)).toBeDefined()
    snapshot = f.store.snapshot()
    snapshot.policy.providers = [{ id: "openai", enabled: true, models: [] }]
    f.store.save(snapshot.policy, snapshot.revision, "7")
    f.store.applied(f.store.snapshot().revision, true)
    await f.worker.wake()
    expect(f.requests).toHaveLength(0)
    f.enqueue("publish_issue_proposals", report, false)
    f.worker.request(issue.id, { requestId: randomUUID(), revision: 1 }, "7")
    await f.worker.wake()
    expect(f.worker.analyses.list(issue.id)[0]).toMatchObject({ state: "completed", attempt: 2 })
  } finally {
    await f.close()
  }
})
it("cancels in-flight native work and never publishes a late report for the cancelled version", async () => {
  const f = await fixture()
  const release = f.pauseNextRequest()
  try {
    const issue = f.create(true)
    f.enqueue("publish_issue_proposals", report, false)
    const running = f.worker.wake()
    await vi.waitFor(() => expect(f.requests).toHaveLength(1))
    const active = f.worker.analyses.list(issue.id)[0]
    if (!active) throw new Error("Missing active analysis")
    const cancelling = f.worker.cancel(issue.id, active.id, active.revision, "7")
    release()
    await cancelling
    await running
    expect(f.worker.analyses.list(issue.id)[0]).toMatchObject({ state: "cancelled", report: null })
    if (f.pendingReplies === 0) f.enqueue("publish_issue_proposals", report, false)
    f.worker.request(issue.id, { requestId: randomUUID(), revision: 1 }, "7")
    await f.worker.wake()
    expect(f.worker.analyses.list(issue.id)[0]).toMatchObject({ state: "completed", attempt: 2 })
    expect(f.worker.analyses.list(issue.id)[1]?.report).toBe(null)
  } finally {
    release()
    await f.close()
  }
})
it("preserves admitted work on shutdown and reopens the same durable session/submission", async () => {
  const f = await fixture()
  const release = f.pauseNextRequest()
  try {
    const issue = f.create(true)
    f.enqueue("publish_issue_proposals", report, false)
    const running = f.worker.wake()
    await vi.waitFor(() => expect(f.requests).toHaveLength(1))
    const before = f.worker.analyses.list(issue.id)[0]
    const closing = f.worker.close()
    release()
    await closing
    await running
    expect(f.worker.analyses.list(issue.id)[0]?.state).toBe("running")
    if (f.pendingReplies === 0) f.enqueue("publish_issue_proposals", report, false)
    f.restart()
    await f.worker.wake()
    expect(f.worker.analyses.list(issue.id)[0]).toMatchObject({
      state: "completed",
      sessionId: before?.sessionId,
      submissionId: before?.submissionId,
      report,
    })
    expect(f.requests).toHaveLength(2)
  } finally {
    release()
    await f.close()
  }
})
it("honors the persisted deadline and policy revision before resuming any model work", async () => {
  const f = await fixture()
  try {
    const issue = f.create(true)
    const job = f.worker.analyses.list(issue.id)[0]
    if (!job) throw new Error("Missing job")
    f.worker.analyses.start(job.id, "openai/gpt-6.1-sol", "off", f.store.snapshot().revision)
    f.store.db
      .prepare("UPDATE feedback_analyses SET deadline=? WHERE id=?")
      .run(Date.now() - 1, job.id)
    await f.worker.wake()
    expect(f.worker.analyses.job(job.id)).toMatchObject({ state: "failed", reason: "timeout" })
    const other = f.create(true)
    const next = f.worker.analyses.list(other.id)[0]
    if (!next) throw new Error("Missing job")
    f.worker.analyses.start(next.id, "openai/gpt-6.1-sol", "off", f.store.snapshot().revision - 1)
    await f.worker.wake()
    expect(f.worker.analyses.job(next.id)).toMatchObject({
      state: "blocked",
      reason: "policy_changed",
    })
    expect(f.requests).toHaveLength(0)
  } finally {
    await f.close()
  }
})
it("deletes all private durable files after a feedback deletion, with restart-safe cleanup receipts", async () => {
  const f = await fixture()
  try {
    const issue = f.create()
    await f.worker.wake()
    const job = f.worker.analyses.list(issue.id)[0]
    if (!job) throw new Error("Missing analysis")
    expect((await stat(path.join(f.directory, `${job.id}.sqlite`))).size).toBeGreaterThan(0)
    f.worker.issues.delete(issue.id, issue.revision, "7")
    expect(f.worker.analyses.garbage()).toContain(job.id)
    await f.worker.close()
    f.restart()
    await f.worker.wake()
    expect(await readdir(f.directory)).toEqual([])
    expect(f.worker.analyses.garbage()).toEqual([])
    expect(f.requests).toHaveLength(0)
  } finally {
    await f.close()
  }
})
it("treats invalid prose output as a failed report, not a generated proposal", async () => {
  const f = await fixture()
  try {
    const issue = f.create(true)
    f.enqueueAnswer("A nice suggestion, not a structured report")
    await f.worker.wake()
    expect(f.worker.analyses.list(issue.id)[0]).toMatchObject({
      state: "failed",
      reason: "invalid_report",
      report: null,
    })
  } finally {
    await f.close()
  }
})

it("revokes an in-flight analysis when settings change and requires a fresh explicit request", async () => {
  const f = await fixture()
  const release = f.pauseNextRequest()
  try {
    const issue = f.create(true)
    f.enqueue("publish_issue_proposals", report, false)
    const running = f.worker.wake()
    await vi.waitFor(() => expect(f.requests).toHaveLength(1))
    const snapshot = f.store.snapshot()
    snapshot.policy.providers = []
    f.store.save(snapshot.policy, snapshot.revision, "7")
    f.store.applied(f.store.snapshot().revision, true)
    await vi.waitFor(() => expect(f.worker.analyses.list(issue.id)[0]?.state).toBe("blocked"), {
      timeout: 3000,
    })
    release()
    await running
    expect(f.worker.analyses.list(issue.id)[0]).toMatchObject({
      reason: "policy_changed",
      report: null,
    })
    const repair = f.store.snapshot()
    repair.policy.providers = [{ id: "openai", enabled: true, models: [] }]
    f.store.save(repair.policy, repair.revision, "7")
    f.store.applied(f.store.snapshot().revision, true)
    await f.worker.wake()
    expect(f.requests).toHaveLength(1)
    if (f.pendingReplies === 0) f.enqueue("publish_issue_proposals", report, false)
    f.worker.request(issue.id, { requestId: randomUUID(), revision: 1 }, "7")
    await f.worker.wake()
    expect(f.worker.analyses.list(issue.id)[0]?.state).toBe("completed")
    expect(f.requests).toHaveLength(2)
  } finally {
    release()
    await f.close()
  }
})
it("blocks unsupported image input before sending any screenshot to the model", async () => {
  const f = await fixture()
  const getModel = f.modelRuntime.getModel.bind(f.modelRuntime)
  const model = vi.spyOn(f.modelRuntime, "getModel").mockImplementation((provider, id) => {
    const value = getModel(provider, id)
    return value ? { ...value, input: ["text"] } : value
  })
  try {
    const issue = f.worker.issues.create(
      {
        requestId: randomUUID(),
        description: "",
        analyze: true,
        screenshot: PNG.toString("base64"),
        source: { section: "Chats", viewport: { width: 1000, height: 800 } },
      },
      "7",
      { bytes: PNG, mime: "image/png" },
    ).issue
    await f.worker.wake()
    expect(f.worker.analyses.list(issue.id)[0]).toMatchObject({
      state: "blocked",
      reason: "image_unsupported",
      sessionId: expect.any(String),
    })
    expect(f.requests).toHaveLength(0)
  } finally {
    model.mockRestore()
    await f.close()
  }
})
it("stops an uninitialized session at the disk budget without an automatic retry loop", async () => {
  const f = await fixture()
  try {
    const issue = f.create(true)
    const job = f.worker.analyses.list(issue.id)[0]
    if (!job) throw new Error("Missing analysis")
    await mkdir(f.directory, { recursive: true })
    await writeFile(path.join(f.directory, `${job.id}.sqlite`), Buffer.alloc(16 * 1024 * 1024 + 1))
    await f.worker.wake()
    expect(f.worker.analyses.job(job.id)).toMatchObject({
      state: "failed",
      reason: "storage_limit",
      sessionId: null,
    })
    await f.worker.wake()
    expect(f.requests).toHaveLength(0)
    expect(f.worker.available).toBe(true)
  } finally {
    await f.close()
  }
})

it("does not silently recreate a previously linked durable session after its file is lost", async () => {
  const f = await fixture()
  try {
    const issue = f.create()
    await f.worker.wake()
    const original = f.worker.analyses.list(issue.id)[0]
    if (!original) throw new Error("Missing session")
    await rm(path.join(f.directory, `${original.id}.sqlite`))
    f.worker.request(issue.id, { requestId: randomUUID(), revision: 1 }, "7")
    await f.worker.wake()
    expect(f.worker.analyses.list(issue.id)[0]).toMatchObject({
      state: "failed",
      reason: "session_unavailable",
      sessionId: original.sessionId,
    })
    expect(f.requests).toHaveLength(0)
  } finally {
    await f.close()
  }
})
it("starts the persisted deadline before waiting for provider authentication", async () => {
  const f = await fixture()
  const auth = vi.spyOn(f.modelRuntime, "checkAuth").mockImplementation(
    (_provider, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("Auth aborted")), {
          once: true,
        })
      }),
  )
  try {
    const issue = f.create(true)
    const running = f.worker.wake()
    await vi.waitFor(() => expect(auth).toHaveBeenCalled())
    const current = f.worker.analyses.list(issue.id)[0]
    if (!current) throw new Error("Missing analysis")
    expect(current.state).toBe("running")
    expect(current.deadline).not.toBe(null)
    f.store.db
      .prepare("UPDATE feedback_analyses SET deadline=? WHERE id=?")
      .run(Date.now() - 1, current.id)
    await running
    expect(f.worker.analyses.job(current.id)).toMatchObject({ state: "failed", reason: "timeout" })
    expect(f.requests).toHaveLength(0)
  } finally {
    auth.mockRestore()
    await f.close()
  }
})

it("quiesces in-flight work before deleting every private session file", async () => {
  const f = await fixture()
  const release = f.pauseNextRequest()
  try {
    const issue = f.create(true)
    f.enqueue("publish_issue_proposals", report, false)
    const running = f.worker.wake()
    await vi.waitFor(() => expect(f.requests).toHaveLength(1))
    f.worker.issues.delete(issue.id, issue.revision, "7")
    const deleting = f.worker.changed(issue.id)
    release()
    await deleting
    await running
    expect(await readdir(f.directory)).toEqual([])
    expect(f.worker.analyses.garbage()).toEqual([])
    expect(() => f.worker.issues.get(issue.id)).toThrow("not found")
    if (f.pendingReplies === 0) f.enqueue("publish_issue_proposals", report, false)
    f.create(true)
    await f.worker.wake()
    expect(f.requests).toHaveLength(2)
  } finally {
    release()
    await f.close()
  }
})

it("does not adopt a different policy revision while a consented request is still queued", async () => {
  const f = await fixture()
  try {
    const issue = f.create(true)
    const previous = f.worker.analyses.list(issue.id)[0]
    if (!previous) throw new Error("Missing analysis")
    expect(f.worker.analyses.job(previous.id).policyRevision).toBe(f.store.snapshot().revision)
    const changed = f.store.snapshot()
    f.store.save(changed.policy, changed.revision, "7")
    f.store.applied(f.store.snapshot().revision, true)
    await f.worker.wake()
    expect(f.worker.analyses.list(issue.id)[0]).toMatchObject({
      state: "blocked",
      reason: "policy_changed",
    })
    expect(f.requests).toHaveLength(0)
  } finally {
    await f.close()
  }
})
