import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { AgentSessionEvent, AgentSessionEventListener } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"

import { TelegramReplyIndex } from "../src/agent/reply-index.js"
import { ChatSessionRegistry, type SessionHandle } from "../src/agent/session-registry.js"
import type { Logger } from "../src/logging.js"

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}

class FakeSession implements SessionHandle {
  isStreaming = false
  readonly sessionId: string
  leafId: string | null = null
  readonly entries = new Set<string>()
  readonly navigated: string[] = []
  readonly sessionManager = {
    getLeafId: () => this.leafId,
    getEntry: (id: string) => (this.entries.has(id) ? { id } : undefined),
  }
  messages: AgentMessage[] = []
  readonly prompts: string[] = []
  readonly steering: string[] = []
  readonly followUps: string[] = []
  readonly contexts: string[] = []
  readonly listeners = new Set<AgentSessionEventListener>()
  aborted = false
  disposed = false
  waitForIdleCalls = 0

  constructor(sessionId = "fake-session") {
    this.sessionId = sessionId
  }

  get isIdle(): boolean {
    return !this.isStreaming
  }

  subscribe(listener: AgentSessionEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: AgentSessionEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  async prompt(text: string): Promise<void> {
    this.prompts.push(text)
    this.messages.push({ role: "user", content: text, timestamp: Date.now() })
    this.messages.push(assistant(`AI: ${text}`))
    this.leafId = `entry-${this.prompts.length}`
    this.entries.add(this.leafId)
  }

  async steer(text: string): Promise<void> {
    this.steering.push(text)
  }

  async followUp(text: string): Promise<void> {
    this.followUps.push(text)
  }

  clearQueue() {
    const queued = { steering: [...this.steering], followUp: [...this.followUps] }
    this.steering.length = 0
    this.followUps.length = 0
    return queued
  }

  async sendCustomMessage(message: { content: string }): Promise<void> {
    this.contexts.push(message.content)
  }

  async navigateTree(targetId: string): Promise<{ cancelled: boolean }> {
    this.navigated.push(targetId)
    this.leafId = targetId
    return { cancelled: false }
  }

  async waitForIdle(): Promise<void> {
    this.waitForIdleCalls += 1
    this.isStreaming = false
  }

  async abort(): Promise<void> {
    this.aborted = true
    this.isStreaming = false
  }

  dispose(): void {
    this.disposed = true
  }
}

describe("ChatSessionRegistry", () => {
  it("reuses one Pi session per chat and isolates different chats", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telegramagent-ts-"))
    const sessions = new Map<number, FakeSession>()
    const registry = new ChatSessionRegistry(
      async (chatId) => {
        const session = new FakeSession()
        sessions.set(chatId, session)
        return session
      },
      root,
      logger,
    )

    await expect(registry.submit(1, "one")).resolves.toMatchObject({
      kind: "completed",
      text: "AI: one",
      checkpoint: { sessionId: "fake-session", entryId: "entry-1" },
    })
    await expect(registry.submit(1, "two")).resolves.toMatchObject({
      kind: "completed",
      text: "AI: two",
      checkpoint: { sessionId: "fake-session", entryId: "entry-2" },
    })
    await expect(registry.submit(2, "other")).resolves.toMatchObject({
      kind: "completed",
      text: "AI: other",
    })

    expect(sessions.size).toBe(2)
    expect(sessions.get(1)?.prompts).toEqual(["one", "two"])
    expect(sessions.get(2)?.prompts).toEqual(["other"])
  })

  it("invalidates a session that finishes creating after reset", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telegramagent-ts-"))
    const staleSession = new FakeSession()
    const replacementSession = new FakeSession()
    let finishCreation: ((session: SessionHandle) => void) | undefined
    const pendingCreation = new Promise<SessionHandle>((resolve) => {
      finishCreation = resolve
    })
    const createSession = vi.fn(async () =>
      createSession.mock.calls.length === 1 ? pendingCreation : replacementSession,
    )
    const registry = new ChatSessionRegistry(createSession, root, logger)

    const staleSubmission = registry.submit(1, "stale")
    const concurrentStaleSubmission = registry.submit(1, "also stale")
    const staleOutcome = expect(staleSubmission).rejects.toThrow("invalidated by reset")
    const concurrentStaleOutcome =
      expect(concurrentStaleSubmission).rejects.toThrow("invalidated by reset")
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledOnce())
    await registry.reset(1)
    const replacementSubmission = registry.submit(1, "fresh")
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(2))
    finishCreation?.(staleSession)

    await Promise.all([staleOutcome, concurrentStaleOutcome])
    await expect(replacementSubmission).resolves.toMatchObject({
      kind: "completed",
      text: "AI: fresh",
    })
    expect(staleSession.disposed).toBe(true)
    expect(staleSession.prompts).toEqual([])
    expect(replacementSession.prompts).toEqual(["fresh"])
  })

  it("does not prompt when the host cancels during session creation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telegramagent-ts-"))
    const session = new FakeSession()
    let finishCreation: ((session: SessionHandle) => void) | undefined
    const pendingCreation = new Promise<SessionHandle>((resolve) => {
      finishCreation = resolve
    })
    const createSession = vi.fn(async () => pendingCreation)
    const registry = new ChatSessionRegistry(createSession, root, logger)
    const onAccepted = vi.fn()
    let current = true

    const staleSubmission = registry.submit(1, "stale", {
      isCurrent: () => current,
      onAccepted,
    })
    const staleOutcome = expect(staleSubmission).rejects.toThrow("cancelled before acceptance")
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledOnce())
    current = false
    finishCreation?.(session)

    await staleOutcome
    expect(session.prompts).toEqual([])
    expect(onAccepted).not.toHaveBeenCalled()
    await registry.dispose()
  })

  it("does not restore or prompt when the host cancels during reply lookup", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telegramagent-ts-"))
    const session = new FakeSession()
    const registry = new ChatSessionRegistry(async () => session, root, logger, {
      replyTreeEnabled: true,
    })
    const first = await registry.submit(1, "first")
    const checkpoint = first.kind === "completed" ? first.checkpoint : undefined
    await registry.recordDelivery(1, checkpoint, [100])
    await registry.submit(1, "latest")
    const lookupStarted = deferred()
    const lookupFinished = deferred()
    const lookup = vi
      .spyOn(TelegramReplyIndex.prototype, "resolve")
      .mockImplementationOnce(async () => {
        lookupStarted.resolve()
        await lookupFinished.promise
        return checkpoint
      })
    const onAccepted = vi.fn()
    let current = true
    try {
      const staleSubmission = registry.submit(1, "stale", {
        replyToBotMessageId: 100,
        isCurrent: () => current,
        onAccepted,
      })
      const staleOutcome = expect(staleSubmission).rejects.toThrow("cancelled before acceptance")
      await lookupStarted.promise
      current = false
      lookupFinished.resolve()

      await staleOutcome
      expect(session.navigated).toEqual([])
      expect(session.prompts).toEqual(["first", "latest"])
      expect(onAccepted).not.toHaveBeenCalled()
    } finally {
      lookupFinished.resolve()
      lookup.mockRestore()
      await registry.dispose()
    }
  })

  it("waits for cancelled branch navigation to roll back before cancellation completes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telegramagent-ts-"))
    const session = new FakeSession()
    const registry = new ChatSessionRegistry(async () => session, root, logger, {
      replyTreeEnabled: true,
    })
    const first = await registry.submit(1, "first")
    await registry.recordDelivery(
      1,
      first.kind === "completed" ? first.checkpoint : undefined,
      [100],
    )
    await registry.submit(1, "latest")
    const navigationStarted = deferred()
    const navigationFinished = deferred()
    const navigate = vi
      .spyOn(session, "navigateTree")
      .mockImplementationOnce(async (targetId: string) => {
        navigationStarted.resolve()
        await navigationFinished.promise
        session.navigated.push(targetId)
        session.leafId = targetId
        return { cancelled: false }
      })
    let current = true
    try {
      const staleSubmission = registry.submit(1, "stale", {
        replyToBotMessageId: 100,
        isCurrent: () => current,
      })
      const staleOutcome = expect(staleSubmission).rejects.toThrow("cancelled before acceptance")
      await navigationStarted.promise
      current = false
      let cancellationFinished = false
      const cancellation = registry.cancel(1).then((result) => {
        cancellationFinished = true
        return result
      })
      await Promise.resolve()
      expect(cancellationFinished).toBe(false)
      navigationFinished.resolve()

      await staleOutcome
      await expect(cancellation).resolves.toBe(true)
      expect(session.navigated).toEqual(["entry-1", "entry-2"])
      expect(session.leafId).toBe("entry-2")
      await expect(registry.submit(1, "fresh")).resolves.toMatchObject({ text: "AI: fresh" })
      expect(session.prompts).toEqual(["first", "latest", "fresh"])
    } finally {
      navigationFinished.resolve()
      navigate.mockRestore()
      await registry.dispose()
    }
  })

  it("rejects access to an existing session when reset wins the acceptance race", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telegramagent-ts-"))
    const session = new FakeSession()
    const registry = new ChatSessionRegistry(async () => session, root, logger)
    await registry.submit(1, "initial")

    const staleSubmission = registry.submit(1, "stale")
    const staleOutcome = expect(staleSubmission).rejects.toThrow("invalidated by reset")
    await registry.reset(1)

    await staleOutcome
    expect(session.prompts).toEqual(["initial"])
  })

  it.each([true, false])(
    "rejects reset during branch fallback with reply routing enabled=%s",
    async (replyTreeEnabled) => {
      const root = await mkdtemp(path.join(tmpdir(), "telegramagent-ts-"))
      const session = new FakeSession()
      const replacement = new FakeSession("replacement")
      const create = vi.fn().mockResolvedValueOnce(session).mockResolvedValue(replacement)
      const registry = new ChatSessionRegistry(create, root, logger, { replyTreeEnabled })
      await registry.submit(1, "initial")

      const onAccepted = vi.fn()
      const stale = registry.submit(1, "stale", { onAccepted })
      const outcome = expect(stale).rejects.toThrow("invalidated by reset")
      // Let submit pass its first generation check and await branch fallback.
      const reset = Promise.resolve().then(() => registry.reset(1))
      await Promise.all([outcome, reset])

      expect(session.disposed).toBe(true)
      expect(session.prompts).toEqual(["initial"])
      expect(onAccepted).not.toHaveBeenCalled()
      await expect(registry.submit(1, "fresh")).resolves.toMatchObject({ text: "AI: fresh" })
      expect(replacement.prompts).toEqual(["fresh"])
      await registry.dispose()
    },
  )

  it.each([
    { name: "absent mapping", target: undefined, streaming: false, intent: "steer" as const },
    {
      name: "stale session",
      target: { sessionId: "stale-session", entryId: "entry-1" },
      streaming: true,
      intent: "steer" as const,
    },
    {
      name: "missing entry",
      target: { sessionId: "fake-session", entryId: "missing" },
      streaming: true,
      intent: "followUp" as const,
    },
  ])("rejects reset during lookup fallback: $name", async ({ target, streaming, intent }) => {
    const root = await mkdtemp(path.join(tmpdir(), "telegramagent-ts-"))
    const session = new FakeSession()
    const registry = new ChatSessionRegistry(async () => session, root, logger, {
      replyTreeEnabled: true,
    })
    await registry.submit(1, "initial")
    session.isStreaming = streaming
    const lookupStarted = deferred()
    const lookupFinished = deferred()
    const lookup = vi
      .spyOn(TelegramReplyIndex.prototype, "resolve")
      .mockImplementationOnce(async () => {
        lookupStarted.resolve()
        await lookupFinished.promise
        return target
      })
    const onAccepted = vi.fn()
    const prompt = vi.spyOn(session, "prompt")
    const steer = vi.spyOn(session, "steer")
    const followUp = vi.spyOn(session, "followUp")
    try {
      const stale = registry.submit(1, "stale", { replyToBotMessageId: 999, intent, onAccepted })
      const outcome = expect(stale).rejects.toThrow("invalidated by reset")
      await lookupStarted.promise
      await registry.reset(1)
      lookupFinished.resolve()
      await outcome

      expect(session.disposed).toBe(true)
      expect(prompt).not.toHaveBeenCalled()
      expect(steer).not.toHaveBeenCalled()
      expect(followUp).not.toHaveBeenCalled()
      expect(onAccepted).not.toHaveBeenCalled()
    } finally {
      lookupFinished.resolve()
      lookup.mockRestore()
      await registry.dispose()
    }
  })

  it("forwards only successful, valid progress results while a prompt is active", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telegramagent-ts-"))
    const session = new FakeSession()
    const updates: unknown[] = []
    session.prompt = vi.fn(async (text: string) => {
      session.emit({
        type: "tool_execution_end",
        toolCallId: "progress",
        toolName: "update_progress",
        result: {
          content: [],
          details: {
            version: 1,
            steps: [{ text: "檢查資料", status: "in_progress" }],
          },
        },
        isError: false,
      })
      session.emit({
        type: "tool_execution_end",
        toolCallId: "invalid",
        toolName: "update_progress",
        result: { content: [], details: { version: 1, steps: "invalid" } },
        isError: false,
      })
      session.emit({
        type: "tool_execution_end",
        toolCallId: "failed",
        toolName: "update_progress",
        result: { content: [], details: { version: 1, steps: [] } },
        isError: true,
      })
      session.messages.push(assistant(`AI: ${text}`))
    })
    const registry = new ChatSessionRegistry(async () => session, root, logger)

    await registry.submit(1, "開始", { onProgress: (steps) => updates.push(steps) })
    session.emit({
      type: "tool_execution_end",
      toolCallId: "late",
      toolName: "update_progress",
      result: { content: [], details: { version: 1, steps: [] } },
      isError: false,
    })

    expect(updates).toEqual([[{ text: "檢查資料", status: "in_progress" }]])
    expect(session.listeners.size).toBe(0)
  })

  it("delegates steering, follow-up, passive context, cancellation, and reset to Pi sessions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telegramagent-ts-"))
    const session = new FakeSession()
    const registry = new ChatSessionRegistry(async () => session, root, logger)

    await registry.appendPassiveContext(1, "旁聽內容")
    session.isStreaming = true
    await expect(registry.submit(1, "改做這個")).resolves.toMatchObject({ kind: "steered" })
    await expect(registry.submit(1, "完成後處理", { intent: "followUp" })).resolves.toMatchObject({
      kind: "followed_up",
    })
    await expect(registry.cancel(1)).resolves.toBe(true)
    await registry.reset(1)

    expect(session.contexts).toEqual(["旁聽內容"])
    expect(session.aborted).toBe(true)
    expect(session.disposed).toBe(true)
  })

  it("restores a mapped older reply as a Pi branch and indexes every delivery alias", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telegramagent-ts-"))
    const session = new FakeSession()
    const registry = new ChatSessionRegistry(async () => session, root, logger, {
      replyTreeEnabled: true,
      replyTreeMaxRecordsPerChat: 10,
      replyTreeMaxIndexBytes: 10_000,
    })

    const first = await registry.submit(1, "first")
    expect(first.kind).toBe("completed")
    await registry.recordDelivery(
      1,
      first.kind === "completed" ? first.checkpoint : undefined,
      [100, 101],
    )
    await registry.submit(1, "latest")
    await registry.submit(1, "branch one", {
      replyToBotMessageId: 101,
      unresolvedReplyPrompt: "quoted branch one",
    })
    await registry.submit(1, "branch two", {
      replyToBotMessageId: 100,
      unresolvedReplyPrompt: "quoted branch two",
    })

    expect(session.navigated).toEqual(["entry-1", "entry-1"])
    expect(session.prompts).toEqual(["first", "latest", "branch one", "branch two"])
  })

  it("waits for an active run before restoring a mapped branch but keeps unmapped steering", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telegramagent-ts-"))
    const session = new FakeSession()
    const registry = new ChatSessionRegistry(async () => session, root, logger, {
      replyTreeEnabled: true,
    })
    const first = await registry.submit(1, "first")
    await registry.recordDelivery(
      1,
      first.kind === "completed" ? first.checkpoint : undefined,
      [100],
    )

    session.isStreaming = true
    await registry.submit(1, "mapped", { replyToBotMessageId: 100 })
    expect(session.waitForIdleCalls).toBe(1)
    expect(session.navigated).toEqual([])
    expect(session.prompts).toContain("mapped")

    session.isStreaming = true
    await expect(
      registry.submit(1, "unmapped", {
        replyToBotMessageId: 999,
        unresolvedReplyPrompt: "unmapped with quoted bot context",
      }),
    ).resolves.toMatchObject({ kind: "steered" })
    expect(session.steering).toEqual(["unmapped with quoted bot context"])
  })

  it.each(["completed", "failed", "reset"])(
    "waits for response capture after Pi becomes idle (%s)",
    async (outcome) => {
      const root = await mkdtemp(path.join(tmpdir(), "telegramagent-ts-"))
      const session = new FakeSession()
      const registry = new ChatSessionRegistry(async () => session, root, logger, {
        replyTreeEnabled: true,
      })
      const first = await registry.submit(1, "first")
      const firstMessages = [...session.messages]
      await registry.recordDelivery(
        1,
        first.kind === "completed" ? first.checkpoint : undefined,
        [100],
      )

      const accepted = deferred()
      const agentFinished = deferred()
      const idle = deferred()
      const promptReturned = deferred()
      const promptNormally = session.prompt.bind(session)
      session.prompt = vi.fn(async (text: string) => {
        if (text !== "running") return promptNormally(text)
        session.prompts.push(text)
        session.messages.push({ role: "user", content: text, timestamp: Date.now() })
        session.isStreaming = true
        await agentFinished.promise
        session.messages.push(assistant("AI: running"))
        session.leafId = "entry-2"
        session.entries.add("entry-2")
        session.isStreaming = false
        idle.resolve()
        // Pi signals idle before prompt() and the registry's result capture unwind.
        await promptReturned.promise
        if (outcome === "failed") throw new Error("prompt failed")
      })
      session.waitForIdle = vi.fn(() => idle.promise)
      session.navigateTree = vi.fn(async (targetId: string) => {
        session.navigated.push(targetId)
        session.leafId = targetId
        session.messages = [...firstMessages]
        return { cancelled: false }
      })

      const running = registry.submit(1, "running", { onAccepted: accepted.resolve })
      const runningOutcome = running.catch((error: unknown) => error)
      await accepted.promise
      // Unmapped input still goes to Pi's queues while capture is pending.
      await expect(registry.submit(1, "steer")).resolves.toMatchObject({ kind: "steered" })
      await expect(registry.submit(1, "follow", { intent: "followUp" })).resolves.toMatchObject({
        kind: "followed_up",
      })
      const branchAccepted = vi.fn()
      const branch = registry.submit(1, "branch", {
        replyToBotMessageId: 100,
        onAccepted: branchAccepted,
      })
      const branchOutcome = branch.catch((error: unknown) => error)

      // Let branch restoration reach its wait, then expose the idle-before-return window.
      await new Promise<void>((resolve) => setImmediate(resolve))
      agentFinished.resolve()
      await idle.promise
      await new Promise<void>((resolve) => setImmediate(resolve))
      const navigatedWhileCapturing = [...session.navigated]
      const acceptedWhileCapturing = branchAccepted.mock.calls.length
      const promptsWhileCapturing = [...session.prompts]

      if (outcome === "reset") await registry.reset(1)
      promptReturned.resolve()
      const [runningResult, branchResult] = await Promise.all([runningOutcome, branchOutcome])
      expect(navigatedWhileCapturing).toEqual([])
      expect(acceptedWhileCapturing).toBe(0)
      expect(promptsWhileCapturing).toEqual(["first", "running"])
      if (outcome === "failed") {
        expect(runningResult).toEqual(new Error("prompt failed"))
      } else {
        expect(runningResult).toMatchObject({
          kind: "completed",
          text: "AI: running",
          checkpoint: { entryId: "entry-2" },
        })
      }
      if (outcome === "reset") {
        expect(branchResult).toEqual(new Error("Pi session access was invalidated by reset"))
      } else {
        expect(branchResult).toMatchObject({ kind: "completed", text: "AI: branch" })
      }
      expect(session.navigated).toEqual(outcome === "reset" ? [] : ["entry-1"])
      expect(session.listeners.size).toBe(0)

      if (outcome === "completed") {
        const result = await running
        await registry.recordDelivery(
          1,
          result.kind === "completed" ? result.checkpoint : undefined,
          [102],
        )
        await registry.submit(1, "reply to running", { replyToBotMessageId: 102 })
        expect(session.navigated).toEqual(["entry-1", "entry-2"])
      }
      await registry.dispose()
    },
  )

  it("keeps successful delivery when reply-index persistence fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telegramagent-ts-"))
    const session = new FakeSession()
    const localLogger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }
    const registry = new ChatSessionRegistry(async () => session, root, localLogger, {
      replyTreeEnabled: true,
      replyTreeMaxIndexBytes: 1,
    })
    const result = await registry.submit(1, "delivered")

    await expect(
      registry.recordDelivery(
        1,
        result.kind === "completed" ? result.checkpoint : undefined,
        [100],
      ),
    ).resolves.toBeUndefined()
    expect(localLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Could not persist Telegram reply mapping"),
      expect.any(Error),
    )
  })

  it("ignores stale session IDs, missing entries, undefined checkpoints, and reset mappings", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telegramagent-ts-"))
    const firstSession = new FakeSession("first-session")
    const firstRegistry = new ChatSessionRegistry(async () => firstSession, root, logger, {
      replyTreeEnabled: true,
    })
    const first = await firstRegistry.submit(1, "first")
    await firstRegistry.recordDelivery(
      1,
      first.kind === "completed" ? first.checkpoint : undefined,
      [100],
    )
    await firstRegistry.recordDelivery(1, undefined, [200])
    firstSession.entries.clear()
    await firstRegistry.submit(1, "missing", { replyToBotMessageId: 100 })
    expect(firstSession.navigated).toEqual([])

    await firstRegistry.dispose()
    const replacement = new FakeSession("replacement-session")
    const replacementRegistry = new ChatSessionRegistry(async () => replacement, root, logger, {
      replyTreeEnabled: true,
    })
    await replacementRegistry.submit(1, "stale", { replyToBotMessageId: 100 })
    expect(replacement.navigated).toEqual([])
    await replacementRegistry.reset(1)

    const afterReset = new FakeSession("replacement-session")
    const afterResetRegistry = new ChatSessionRegistry(async () => afterReset, root, logger, {
      replyTreeEnabled: true,
    })
    await afterResetRegistry.submit(1, "after reset", { replyToBotMessageId: 100 })
    expect(afterReset.navigated).toEqual([])
  })
})

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function assistant(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  }
}
