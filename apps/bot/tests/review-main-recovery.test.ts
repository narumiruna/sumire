import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { DurableSession } from "../src/agent/durable/session.js"
import { OutboxDoc } from "../src/agent/durable/state.js"
import { ChatSessionRegistry, type SubmissionOptions } from "../src/agent/session-registry.js"
import { createPiFixture } from "./helpers/pi-fixture.js"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function gate() {
  let release = () => {}
  const done = new Promise<void>((resolve) => {
    release = resolve
  })
  return { done, release }
}

async function setup() {
  const pi = await createPiFixture()
  let owner: DurableSession
  const registries: ChatSessionRegistry[] = []
  const releases: Array<() => void> = []
  const work: Promise<unknown>[] = []
  const open = () => {
    const registry = new ChatSessionRegistry(
      async (chatId) => {
        owner = await pi.createSession(chatId)
        return owner
      },
      pi.settings.botSessionLogDir,
      pi.logger,
      { control: pi.factory.control },
    )
    registries.push(registry)
    return registry
  }
  let registry = open()
  const pause = () => {
    const release = pi.pauseNextRequest()
    releases.push(release)
    return release
  }
  const submit = (text: string, source: number, options: SubmissionOptions = {}) => {
    const result = registry.submit(-100, text, {
      routing: "main",
      delivery: { sourceMessageId: source, statusMessageId: source + 1_000, mode: "default" },
      ...options,
    })
    void result.catch(() => {})
    work.push(result)
    return result
  }
  cleanups.push(async () => {
    await Promise.all(registries.map((item) => item.dispose()))
    for (const release of releases) release()
    await Promise.allSettled(work)
    await pi.cleanup()
  })
  return {
    pi,
    pause,
    submit,
    get owner() {
      return owner
    },
    get registry() {
      return registry
    },
    async restoreMain(resume = true) {
      const releaseOld = pause()
      const old = submit("Main before restart", 10)
      await requests(pi, 1)
      const pending = (await owner.harness.snapshot(OutboxDoc, context))?.pending[0]
      if (!pending) throw new Error("Missing retained main request")
      await registry.dispose()
      await Promise.allSettled([old])
      await vi.waitFor(() => expect(pi.disconnectedRequests).toBe(1))
      releaseOld()
      registry = open()
      expect(await registry.isPendingStatus(-100, 1_010)).toBe(true)
      expect(owner.isMainStreaming).toBe(true)
      expect(pi.requests).toHaveLength(1)
      const releaseRestored = pause()
      if (resume) {
        owner.harness.resume()
        await requests(pi, 2)
      }
      const native = await owner.harness.commit(
        (tx) => tx.submissionByRequest(pending.conversationId, pending.requestId),
        context,
      )
      if (!native) throw new Error("Missing retained native submission")
      const submission = await owner.harness.submission(native.id, context)
      if (!submission) throw new Error("Missing retained submission handle")
      return { releaseRestored, submission }
    },
  }
}

async function requests(pi: Awaited<ReturnType<typeof createPiFixture>>, count: number) {
  await vi.waitFor(() => expect(pi.requests).toHaveLength(count), { timeout: 2_000 })
}

function enteredMain(owner: DurableSession) {
  const entered = gate()
  const original = owner.waitForIdle.bind(owner)
  const wait = vi.spyOn(owner, "waitForIdle").mockImplementation(async () => {
    entered.release()
    await original()
  })
  const accepted = vi.fn(entered.release)
  return { entered: entered.done, wait, accepted }
}

describe("restored main routing", () => {
  it("starts new and later main requests after a restored main run fails", async () => {
    const f = await setup()
    const restored = await f.restoreMain()
    const main = enteredMain(f.owner)
    const next = f.submit("New main after restart", 20, { onAccepted: main.accepted })
    await main.entered
    const releaseNext = f.pause()
    f.pi.enqueueFailure()
    restored.releaseRestored()
    expect(await restored.submission.wait(context)).toMatchObject({
      status: "unanswered",
      reason: "model_error",
    })
    const later = f.submit("Later host main", 30)
    // A queued input under afterFailedRun=keep cannot start this request.
    await requests(f.pi, 3)
    const releaseLater = f.pause()
    f.pi.enqueueAnswer("New main answer")
    releaseNext()
    expect(await next).toMatchObject({ kind: "completed", text: "New main answer" })
    await requests(f.pi, 4)
    f.pi.enqueueAnswer("Later main answer")
    releaseLater()
    expect(await later).toMatchObject({ kind: "completed", text: "Later main answer" })
    expect(main.wait).toHaveBeenCalledOnce()
    expect(main.accepted).toHaveBeenCalledOnce()
  })

  it("rejects host cancellation during the restored main idle wait before acceptance", async () => {
    const f = await setup()
    const restored = await f.restoreMain()
    const main = enteredMain(f.owner)
    let current = true
    const next = f.submit("Cancelled waiting main", 20, {
      isCurrent: () => current,
      onAccepted: main.accepted,
    })
    await main.entered
    current = false
    f.pi.enqueueFailure()
    restored.releaseRestored()
    await restored.submission.wait(context)
    expect(main.accepted).not.toHaveBeenCalled()
    await expect(next).rejects.toMatchObject({ name: "AbortError" })
    expect(f.pi.requests).toHaveLength(2)
  })

  it("rejects registry cancellation during the restored main idle wait", async () => {
    const f = await setup()
    const restored = await f.restoreMain()
    const main = enteredMain(f.owner)
    const next = f.submit("Cancelled generation main", 20, { onAccepted: main.accepted })
    await main.entered
    expect(await f.registry.cancel(-100)).toBe(true)
    await expect(next).rejects.toMatchObject({ name: "AbortError" })
    expect(main.accepted).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(f.pi.disconnectedRequests).toBe(2))
    restored.releaseRestored()
    expect(f.pi.requests).toHaveLength(2)
  })

  it("resumes a cold retained main through its native idle wait without explicit recovery", async () => {
    const f = await setup()
    const restored = await f.restoreMain(false)
    const wait = vi.spyOn(f.owner, "waitForIdle")
    const resume = vi.spyOn(f.owner.harness, "resume")
    const accepted = vi.fn()
    try {
      expect(f.pi.requests).toHaveLength(1)
      const next = f.submit("New main from cold owner", 20, { onAccepted: accepted })
      await requests(f.pi, 2)
      expect(wait).toHaveBeenCalledOnce()
      expect(resume).not.toHaveBeenCalled()
      expect(accepted).not.toHaveBeenCalled()
      expect(JSON.stringify(f.pi.requests[1]?.messages)).toContain("Main before restart")
      expect(JSON.stringify(f.pi.requests[1]?.messages)).not.toContain("New main from cold owner")

      const releaseNext = f.pause()
      f.pi.enqueueAnswer("Retained main answer")
      restored.releaseRestored()
      await requests(f.pi, 3)
      expect(resume).toHaveBeenCalledOnce()
      expect(accepted).toHaveBeenCalledOnce()
      f.pi.enqueueAnswer("New cold main answer")
      releaseNext()
      expect(await next).toMatchObject({ kind: "completed", text: "New cold main answer" })
      expect(f.pi.pendingReplies).toBe(0)
    } finally {
      wait.mockRestore()
      resume.mockRestore()
    }
  })

  it("does not wait for a blocked article when main is idle", async () => {
    const f = await setup()
    f.pi.enqueueAnswer("Seed main answer")
    await f.submit("Seed main", 10)
    const releaseArticle = f.pause()
    const article = f.submit("Blocked article", 20, { routing: "article" })
    await requests(f.pi, 2)
    expect(f.owner.isStreaming).toBe(true)
    expect(f.owner.isMainStreaming).toBe(false)
    const wait = vi.spyOn(f.owner, "waitForIdle")
    f.pi.enqueueAnswer("Independent main answer")
    expect(await f.submit("Main past article", 30)).toMatchObject({
      kind: "completed",
      text: "Independent main answer",
    })
    expect(wait).not.toHaveBeenCalled()
    expect(f.owner.isStreaming).toBe(true)
    f.pi.enqueueAnswer("Article answer")
    releaseArticle()
    expect(await article).toMatchObject({ kind: "completed", text: "Article answer" })
  })
})
