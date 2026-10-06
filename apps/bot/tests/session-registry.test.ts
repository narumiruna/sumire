import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type {
  AgentSessionEvent,
  AgentSessionEventListener,
  SessionEntry,
} from "@earendil-works/pi-coding-agent"
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

const reasoningModel: NonNullable<SessionHandle["model"]> = {
  id: "reasoner",
  name: "Reasoner",
  provider: "test",
  api: "openai-responses",
  baseUrl: "https://api.example.test/v1",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 10_000,
}
const plainModel = { ...reasoningModel, id: "plain", reasoning: false }

class FakeSession implements SessionHandle {
  model = reasoningModel
  thinkingLevel: SessionHandle["thinkingLevel"] = "off"
  readonly modelRuntime = {
    getAvailable: vi.fn(async () => [plainModel, reasoningModel]),
  }
  getAvailableThinkingLevels(): ReturnType<SessionHandle["getAvailableThinkingLevels"]> {
    return this.model.reasoning ? ["off", "low", "medium", "high"] : ["off"]
  }
  setModel = vi.fn(async (model: NonNullable<SessionHandle["model"]>) => {
    this.model = model
    if (!model.reasoning) this.thinkingLevel = "off"
  })
  setThinkingLevel = vi.fn((level: SessionHandle["thinkingLevel"]) => {
    this.thinkingLevel = level
  })
  isStreaming = false
  readonly sessionId: string
  leafId: string | null = null
  readonly entries = new Set<string>()
  readonly branchEntries: SessionEntry[] = []
  readonly navigated: string[] = []
  readonly sessionManager = {
    getLeafId: () => this.leafId,
    getEntry: (id: string) => (this.entries.has(id) ? { id } : undefined),
    getBranch: () => this.branchEntries,
    buildSessionContext: () => ({
      messages: this.messages,
      model: { provider: this.model.provider, modelId: this.model.id },
      thinkingLevel: this.thinkingLevel,
    }),
    appendModelChange: vi.fn((_provider: string, _modelId: string) => "model-change"),
    appendThinkingLevelChange: vi.fn((_level: SessionHandle["thinkingLevel"]) => "thinking-change"),
  }
  messages: AgentMessage[] = []
  readonly prompts: string[] = []
  readonly steering: string[] = []
  readonly followUps: string[] = []
  readonly contexts: string[] = []
  readonly contextOptions: Array<{ triggerTurn?: boolean; deliverAs?: string } | undefined> = []
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

  async steer(text: string): ReturnType<SessionHandle["steer"]> {
    this.steering.push(text)
    return "queued"
  }

  async followUp(text: string): ReturnType<SessionHandle["followUp"]> {
    this.followUps.push(text)
    return "queued"
  }

  clearQueue() {
    const queued = { steering: [...this.steering], followUp: [...this.followUps] }
    this.steering.length = 0
    this.followUps.length = 0
    return queued
  }

  async sendCustomMessage(
    message: { content: string },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): Promise<void> {
    this.contexts.push(message.content)
    this.contextOptions.push(options)
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

describe("chat model settings", () => {
  async function setup(session = new FakeSession()) {
    const root = await mkdtemp(path.join(tmpdir(), "sumire-model-settings-"))
    const create = vi.fn(async () => session)
    return { session, create, registry: new ChatSessionRegistry(create, root, logger) }
  }

  it("lazily creates a session and lists authenticated models and supported levels without prompting", async () => {
    const { registry, session, create } = await setup()
    await expect(registry.getModelSettings(7)).resolves.toEqual({
      currentModel: "test/reasoner",
      thinkingLevel: "off",
      thinkingLevels: ["off", "low", "medium", "high"],
      models: ["test/plain", "test/reasoner"],
    })
    await registry.getModelSettings(7)
    expect(create).toHaveBeenCalledOnce()
    expect(session.prompts).toEqual([])
  })

  it("changes only the requested chat and delegates model capability clamping to Pi", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sumire-model-isolation-"))
    const first = new FakeSession("first")
    const second = new FakeSession("second")
    const registry = new ChatSessionRegistry(
      async (id) => (id === 7 ? first : second),
      root,
      logger,
    )
    await registry.setThinkingLevel(7, "high")
    await expect(registry.setModel(7, "test/plain")).resolves.toMatchObject({
      currentModel: "test/plain",
      thinkingLevel: "off",
      thinkingLevels: ["off"],
    })
    expect(first.setModel).toHaveBeenCalledExactlyOnceWith(plainModel)
    expect(first.setThinkingLevel).toHaveBeenCalledExactlyOnceWith("high")
    await expect(registry.getModelSettings(8)).resolves.toMatchObject({
      currentModel: "test/reasoner",
      thinkingLevel: "off",
    })
    expect(second.setModel).not.toHaveBeenCalled()
    expect(first.prompts).toEqual([])
  })

  it("accepts an unambiguous model ID but rejects unavailable and ambiguous choices", async () => {
    const { registry, session } = await setup()
    await registry.setModel(7, "plain")
    await expect(registry.setModel(7, "unknown")).rejects.toThrow("找不到可用")
    session.modelRuntime.getAvailable.mockResolvedValue([
      reasoningModel,
      { ...reasoningModel, provider: "other" },
    ])
    await expect(registry.setModel(7, "reasoner")).rejects.toThrow("名稱不唯一")
    expect(session.setModel).toHaveBeenCalledOnce()
  })

  it("prioritizes exact provider/model references over colliding bare IDs", async () => {
    const { registry, session } = await setup()
    const native = { ...reasoningModel, provider: "anthropic", id: "claude-sonnet-4" }
    const routed = { ...reasoningModel, provider: "openrouter", id: "anthropic/claude-sonnet-4" }
    session.modelRuntime.getAvailable.mockResolvedValue([native, routed])
    await registry.setModel(7, "anthropic/claude-sonnet-4")
    expect(session.setModel).toHaveBeenLastCalledWith(native)
    await registry.setModel(7, "openrouter/anthropic/claude-sonnet-4")
    expect(session.setModel).toHaveBeenLastCalledWith(routed)
    await registry.setModel(7, "claude-sonnet-4")
    expect(session.setModel).toHaveBeenLastCalledWith(native)
  })

  it("rejects unsupported thinking levels rather than silently clamping", async () => {
    const { registry, session } = await setup()
    await registry.setModel(7, "plain")
    for (const level of ["high", "invalid", "HIGH", "max"]) {
      await expect(registry.setThinkingLevel(7, level)).rejects.toThrow("不支援")
    }
    expect(session.setThinkingLevel).not.toHaveBeenCalled()
    await expect(registry.setThinkingLevel(7, "off")).resolves.toMatchObject({
      thinkingLevel: "off",
    })
  })

  it("rejects changes while the session is busy", async () => {
    const { registry, session } = await setup()
    session.isStreaming = true
    await expect(registry.setModel(7, "plain")).rejects.toThrow("任務執行中")
    await expect(registry.setThinkingLevel(7, "high")).rejects.toThrow("任務執行中")
    expect(session.setModel).not.toHaveBeenCalled()
    expect(session.setThinkingLevel).not.toHaveBeenCalled()
  })

  it("invalidates an availability result that finishes after reset", async () => {
    const { registry, session } = await setup()
    let finish = () => {}
    session.modelRuntime.getAvailable.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve([reasoningModel])
        }),
    )
    const pending = registry.getModelSettings(7)
    const outcome = expect(pending).rejects.toThrow("invalidated by reset")
    await vi.waitFor(() => expect(session.modelRuntime.getAvailable).toHaveBeenCalledOnce())
    await registry.reset(7)
    finish()
    await outcome
    expect(session.setModel).not.toHaveBeenCalled()
  })

  it("waits for an accepted model change before prompting and rejects overlapping changes", async () => {
    const { registry, session } = await setup()
    let finish = () => {}
    session.setModel.mockImplementationOnce(
      (model) =>
        new Promise((resolve) => {
          finish = () => {
            session.model = model
            resolve()
          }
        }),
    )
    const selection = registry.setModel(7, "plain")
    await vi.waitFor(() => expect(session.setModel).toHaveBeenCalledOnce())
    const submission = registry.submit(7, "next question")
    await expect(registry.setThinkingLevel(7, "high")).rejects.toThrow("正在切換")
    expect(session.prompts).toEqual([])
    finish()
    await selection
    await submission
    expect(session.prompts).toEqual(["next question"])
  })

  it.each(["read", "model", "thinking", "submit", "passive"] as const)(
    "waits for reset to finish before new %s operations",
    async (operation) => {
      const root = await mkdtemp(path.join(tmpdir(), "sumire-reset-settings-"))
      const first = new FakeSession("first")
      const replacement = new FakeSession("replacement")
      const create = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(replacement)
      const registry = new ChatSessionRegistry(create, root, logger)
      await registry.getModelSettings(7)
      const clearing = deferred()
      const finish = deferred()
      const clear = vi
        .spyOn(TelegramReplyIndex.prototype, "clear")
        .mockImplementationOnce(async () => {
          clearing.resolve()
          await finish.promise
        })
      try {
        const reset = registry.reset(7)
        await clearing.promise
        expect(first.disposed).toBe(true)
        const concurrentReset = registry.reset(7)
        const pending =
          operation === "read"
            ? registry.getModelSettings(7)
            : operation === "model"
              ? registry.setModel(7, "plain")
              : operation === "thinking"
                ? registry.setThinkingLevel(7, "high")
                : operation === "submit"
                  ? registry.submit(7, "fresh")
                  : registry.appendPassiveContext(7, "new context")
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(create).toHaveBeenCalledOnce()
        expect(replacement.setModel).not.toHaveBeenCalled()
        expect(replacement.setThinkingLevel).not.toHaveBeenCalled()
        finish.resolve()
        await Promise.all([reset, concurrentReset])
        expect(clear).toHaveBeenCalledOnce()
        await pending
        expect(create).toHaveBeenCalledTimes(2)
        expect(replacement.disposed).toBe(false)
      } finally {
        finish.resolve()
        clear.mockRestore()
        await registry.dispose()
      }
    },
  )

  it("rejects commands waiting on failed reset cleanup and releases the reset lock", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sumire-failed-reset-settings-"))
    const first = new FakeSession("first")
    const replacement = new FakeSession("replacement")
    const create = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(replacement)
    const registry = new ChatSessionRegistry(create, root, logger)
    await registry.getModelSettings(7)
    const clearing = deferred()
    const finish = deferred()
    const clear = vi
      .spyOn(TelegramReplyIndex.prototype, "clear")
      .mockImplementationOnce(async () => {
        clearing.resolve()
        await finish.promise
        throw new Error("fixture cleanup failed")
      })
    try {
      const reset = registry.reset(7)
      const resetOutcome = expect(reset).rejects.toThrow("fixture cleanup failed")
      await clearing.promise
      const read = registry.getModelSettings(7)
      const readOutcome = expect(read).rejects.toThrow("fixture cleanup failed")
      finish.resolve()
      await Promise.all([resetOutcome, readOutcome])
      expect(create).toHaveBeenCalledOnce()
      await expect(registry.getModelSettings(7)).resolves.toMatchObject({
        currentModel: "test/reasoner",
      })
      expect(create).toHaveBeenCalledTimes(2)
    } finally {
      finish.resolve()
      clear.mockRestore()
      await registry.dispose()
    }
  })

  it("waits for model mutation to settle before disposing on reset", async () => {
    const { registry, session } = await setup()
    let finish = () => {}
    session.setModel.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const selection = registry.setModel(7, "plain")
    const outcome = expect(selection).rejects.toThrow("invalidated by reset")
    await vi.waitFor(() => expect(session.setModel).toHaveBeenCalledOnce())
    const reset = registry.reset(7)
    expect(session.disposed).toBe(false)
    finish()
    await outcome
    await reset
    expect(session.disposed).toBe(true)
  })
})

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

  it("returns a distinct outcome when Pi produces no assistant text", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telegramagent-ts-"))
    const session = new FakeSession()
    session.prompt = vi.fn(async (text: string) => {
      session.prompts.push(text)
      session.messages.push({ role: "user", content: text, timestamp: Date.now() })
      session.leafId = "entry-1"
      session.entries.add("entry-1")
    })
    const registry = new ChatSessionRegistry(async () => session, root, logger)

    await expect(registry.submit(1, "silent")).resolves.toEqual({
      kind: "no_response",
      text: "模型沒有回覆內容，請稍後再試。",
    })
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
    const resetting = registry.reset(1)
    const replacementSubmission = registry.submit(1, "fresh")
    expect(createSession).toHaveBeenCalledOnce()
    finishCreation?.(staleSession)
    await resetting
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(2))

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

  it("reports real Pi activity even when no progress tool is called", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telegramagent-ts-"))
    const session = new FakeSession()
    const activities: string[] = []
    session.prompt = vi.fn(async (text: string) => {
      session.emit({ type: "agent_start" })
      session.emit({
        type: "tool_execution_start",
        toolCallId: "work",
        toolName: "read",
        args: { path: "secret.txt" },
      })
      session.emit({
        type: "tool_execution_end",
        toolCallId: "work",
        toolName: "read",
        result: { content: [], details: undefined },
        isError: false,
      })
      session.emit({
        type: "tool_execution_end",
        toolCallId: "progress",
        toolName: "update_progress",
        result: { content: [], details: { version: 1, steps: [] } },
        isError: false,
      })
      session.messages.push(assistant(`AI: ${text}`))
    })
    const registry = new ChatSessionRegistry(async () => session, root, logger)

    await registry.submit(1, "開始", { onActivity: (activity) => activities.push(activity) })
    session.emit({ type: "agent_start" })

    expect(activities).toEqual(["model", "tool", "tool_finished"])
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

  it("logs Pi session, tool outcome, model usage, retry and compaction without tool inputs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telegramagent-ts-"))
    const session = new FakeSession()
    const prompt = session.prompt.bind(session)
    session.prompt = vi.fn(async (text) => {
      session.emit({
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "load_public_url",
        args: { url: "https://example.com/?key=private" },
      })
      session.emit({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "load_public_url",
        result: { content: [], details: { text: "private content" } },
        isError: false,
      })
      session.emit({
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 2,
        delayMs: 100,
        errorMessage: "private failure",
      })
      session.emit({
        type: "compaction_end",
        reason: "threshold",
        result: undefined,
        aborted: false,
        willRetry: false,
      })
      session.emit({ type: "message_end", message: assistant("private content") })
      await prompt(text)
    })
    const registry = new ChatSessionRegistry(async () => session, root, logger)
    vi.mocked(logger.info).mockClear()

    await registry.submit(1, "request")

    const messages = vi.mocked(logger.info).mock.calls.map(([message]) => message)
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining("session_id=fake-session reply_branch_restored=false"),
        expect.stringContaining(
          "Pi tool started chat_id=1 session_id=fake-session tool=load_public_url call_id=call-1",
        ),
        expect.stringContaining(
          "Pi tool finished chat_id=1 session_id=fake-session tool=load_public_url call_id=call-1 success=true",
        ),
        expect.stringContaining(
          "Pi model response chat_id=1 session_id=fake-session model=test stop_reason=stop input_tokens=0",
        ),
        expect.stringContaining(
          "Pi retry chat_id=1 session_id=fake-session attempt=1 max_attempts=2",
        ),
        expect.stringContaining(
          "Pi compaction chat_id=1 session_id=fake-session reason=threshold aborted=false",
        ),
      ]),
    )
    expect(messages.join(" ")).not.toContain("private content")
    expect(messages.join(" ")).not.toContain("key=private")
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
    expect(session.contextOptions).toEqual([{ triggerTurn: false }])
    expect(session.aborted).toBe(true)
    expect(session.disposed).toBe(true)
  })

  it("adds background context without steering an active Pi run or carrying it across reset", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telegramagent-ts-"))
    const first = new FakeSession("first")
    const second = new FakeSession("second")
    let created = 0
    const registry = new ChatSessionRegistry(
      async () => (created++ === 0 ? first : second),
      root,
      logger,
    )

    first.isStreaming = true
    await registry.appendPassiveContext(1, "群組旁聽")
    expect(first.contextOptions).toEqual([{ triggerTurn: false }])
    expect(first.steering).toEqual([])
    expect(first.followUps).toEqual([])
    await registry.reset(1)
    await registry.submit(1, "當前請求")
    expect(second.contexts).toEqual([])
    expect(second.prompts).toEqual(["當前請求"])
  })

  it("waits for an active response capture before starting a separate new turn", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telegramagent-ts-"))
    const session = new FakeSession()
    const registry = new ChatSessionRegistry(async () => session, root, logger)
    const runningAccepted = deferred()
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
      session.leafId = "entry-1"
      session.entries.add("entry-1")
      session.isStreaming = false
      idle.resolve()
      await promptReturned.promise
    })

    const running = registry.submit(1, "running", { onAccepted: runningAccepted.resolve })
    await runningAccepted.promise
    agentFinished.resolve()
    await idle.promise

    const newTurnAccepted = vi.fn()
    const newTurn = registry.submit(1, "article", {
      intent: "newTurn",
      onAccepted: newTurnAccepted,
    })
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(session.isStreaming).toBe(false)
    expect(session.prompts).toEqual(["running"])
    expect(newTurnAccepted).not.toHaveBeenCalled()
    expect(session.steering).toEqual([])

    promptReturned.resolve()
    await expect(running).resolves.toMatchObject({ kind: "completed", text: "AI: running" })
    await expect(newTurn).resolves.toMatchObject({ kind: "completed", text: "AI: article" })
    expect(session.prompts).toEqual(["running", "article"])
    expect(newTurnAccepted).toHaveBeenCalledOnce()
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

  it("replays recent passive group context before a reply to an older branch", async () => {
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
    const timestamp = new Date().toISOString()
    session.branchEntries.push(
      {
        type: "custom_message",
        id: "old-context",
        parentId: null,
        timestamp,
        customType: "telegram-passive-context",
        content: "舊背景",
        display: false,
      },
      {
        type: "message",
        id: "latest-answer",
        parentId: "old-context",
        timestamp,
        message: assistant("latest answer"),
      },
      {
        type: "custom_message",
        id: "current-context",
        parentId: "latest-answer",
        timestamp,
        customType: "telegram-passive-context",
        content: "新背景",
        display: false,
      },
      {
        type: "custom_message",
        id: "second-context",
        parentId: "current-context",
        timestamp,
        customType: "telegram-passive-context",
        content: "第二則背景",
        display: false,
      },
    )
    await registry.appendPassiveContext(1, "新背景")
    await registry.appendPassiveContext(1, "第二則背景")
    await registry.submit(1, "reply", { replyToBotMessageId: 100 })

    expect(session.navigated).toEqual(["entry-1"])
    expect(session.contexts).toEqual(["新背景", "第二則背景", "新背景", "第二則背景"])
    expect(session.prompts).toEqual(["first", "latest", "reply"])
    await registry.dispose()
  })

  it("rolls back a restored branch when cancellation arrives during passive context replay", async () => {
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
    session.branchEntries.push({
      type: "custom_message",
      id: "recent-context",
      parentId: "entry-2",
      timestamp: new Date().toISOString(),
      customType: "telegram-passive-context",
      content: "新背景",
      display: false,
    })
    const replayStarted = deferred()
    const replayFinished = deferred()
    const send = vi.spyOn(session, "sendCustomMessage").mockImplementationOnce(async () => {
      replayStarted.resolve()
      await replayFinished.promise
    })
    let current = true
    try {
      const stale = registry.submit(1, "reply", {
        replyToBotMessageId: 100,
        isCurrent: () => current,
      })
      const outcome = expect(stale).rejects.toThrow("cancelled before acceptance")
      await replayStarted.promise
      current = false
      const cancellation = registry.cancel(1)
      replayFinished.resolve()
      await outcome
      await expect(cancellation).resolves.toBe(true)
      expect(session.navigated).toEqual(["entry-1", "entry-2"])
      expect(session.prompts).toEqual(["first", "latest"])
    } finally {
      replayFinished.resolve()
      send.mockRestore()
      await registry.dispose()
    }
  })

  it("uses a temporary checkpoint while final delivery is pending and releases it afterward", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telegramagent-ts-"))
    const session = new FakeSession()
    const registry = new ChatSessionRegistry(async () => session, root, logger, {
      replyTreeEnabled: true,
    })

    const first = await registry.submit(1, "first")
    await registry.submit(1, "newer leaf")
    const release = registry.holdReplyCheckpoint(
      1,
      first.kind === "completed" ? first.checkpoint : undefined,
      100,
    )
    await registry.submit(1, "reply to delivered progress", { replyToBotMessageId: 100 })
    expect(session.navigated).toEqual(["entry-1"])

    release()
    await registry.submit(1, "another leaf")
    await registry.submit(1, "unmapped", {
      replyToBotMessageId: 100,
      unresolvedReplyPrompt: "quoted progress fallback",
    })
    expect(session.navigated).toEqual(["entry-1"])
    expect(session.prompts.at(-1)).toBe("quoted progress fallback")
    await registry.dispose()
  })

  it("drops temporary reply checkpoints on reset", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telegramagent-ts-"))
    let session = new FakeSession()
    const registry = new ChatSessionRegistry(async () => session, root, logger, {
      replyTreeEnabled: true,
    })

    const first = await registry.submit(1, "first")
    const release = registry.holdReplyCheckpoint(
      1,
      first.kind === "completed" ? first.checkpoint : undefined,
      100,
    )
    await registry.reset(1)
    session = new FakeSession()
    release()
    await registry.submit(1, "after reset", {
      replyToBotMessageId: 100,
      unresolvedReplyPrompt: "unmapped after reset",
    })

    expect(session.navigated).toEqual([])
    expect(session.prompts).toEqual(["unmapped after reset"])
    await registry.dispose()
  })

  it("resolves a reply against an in-flight checkpoint write before navigating", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telegramagent-ts-"))
    const session = new FakeSession()
    const registry = new ChatSessionRegistry(async () => session, root, logger, {
      replyTreeEnabled: true,
    })

    const first = await registry.submit(1, "first")
    await registry.submit(1, "newer leaf")
    const recording = registry.recordDelivery(
      1,
      first.kind === "completed" ? first.checkpoint : undefined,
      [100],
    )
    const reply = registry.submit(1, "reply to progress", { replyToBotMessageId: 100 })
    await Promise.all([recording, reply])

    expect(session.navigated).toEqual(["entry-1"])
    expect(session.prompts).toEqual(["first", "newer leaf", "reply to progress"])
    await registry.dispose()
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

describe("recovery-only session ownership", () => {
  it("closes idle historical chats before opening the next database and reopens on demand", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sumire-recovery-"))
    let opened = 0
    let peak = 0
    const create = vi.fn(async (id: number) => {
      opened++
      peak = Math.max(peak, opened)
      const session = Object.assign(new FakeSession(`chat-${id}`), {
        hasPendingResponses: async () => false,
        recoverPending: vi.fn(async () => {}),
      })
      vi.spyOn(session, "dispose").mockImplementation(() => {
        opened--
      })
      return session
    })
    const registry = new ChatSessionRegistry(create, root, logger)
    try {
      await registry.recover([1, 2, 3, 4, 5], async () => true)
      expect(opened).toBe(0)
      expect(peak).toBe(1)
      await registry.submit(1, "new question")
      expect(create).toHaveBeenCalledTimes(6)
      expect(opened).toBe(1)
    } finally {
      await registry.dispose()
    }
  })

  it.each([true, false])(
    "evicts only after successful recovery delivery (success=%s)",
    async (success) => {
      const root = await mkdtemp(path.join(tmpdir(), "sumire-recovery-"))
      let pending = true
      const session = Object.assign(new FakeSession(), {
        hasPendingResponses: async () => pending,
        acknowledge: vi.fn(async () => {
          pending = false
        }),
        recoverPending: async (
          deliver: (
            answer: { text: string; requestId: string },
            delivery: { sourceMessageId: number; mode: "default" },
          ) => Promise<void>,
        ) => {
          await deliver(
            { text: "Recovered", requestId: "request" },
            { sourceMessageId: 1, mode: "default" },
          )
        },
      })
      const create = vi.fn(async () => session)
      const deliver = vi.fn(async () => success)
      const registry = new ChatSessionRegistry(create, root, logger)
      try {
        await registry.recover([1], deliver)
        if (success) {
          await vi.waitFor(() => expect(session.disposed).toBe(true))
          expect(session.acknowledge).toHaveBeenCalledExactlyOnceWith("request")
        } else {
          await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce())
          await registry.getModelSettings(1)
          expect(session.disposed).toBe(false)
          expect(session.acknowledge).not.toHaveBeenCalled()
          expect(create).toHaveBeenCalledOnce()
        }
      } finally {
        await registry.dispose()
      }
    },
  )

  it("does not evict a recovery session adopted by a live caller", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sumire-recovery-"))
    const gate = deferred()
    const session = Object.assign(new FakeSession(), {
      hasPendingResponses: vi.fn(async () => {
        await gate.promise
        return false
      }),
      recoverPending: async () => {},
    })
    const registry = new ChatSessionRegistry(async () => session, root, logger)
    const recovering = registry.recover([1], async () => true)
    try {
      await vi.waitFor(() => expect(session.hasPendingResponses).toHaveBeenCalled())
      await registry.getModelSettings(1)
      gate.resolve()
      await recovering
      expect(session.disposed).toBe(false)
    } finally {
      gate.resolve()
      await recovering
      await registry.dispose()
    }
  })

  it("leaves concurrent reset in charge of closing storage before cleanup", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sumire-recovery-"))
    const checking = deferred()
    const closing = deferred()
    const session = Object.assign(new FakeSession(), {
      hasPendingResponses: vi.fn(async () => {
        await checking.promise
        return false
      }),
      recoverPending: async () => {},
    })
    const dispose = vi.spyOn(session, "dispose").mockImplementation(async () => {
      await closing.promise
    })
    const registry = new ChatSessionRegistry(async () => session, root, logger)
    const recovering = registry.recover([1], async () => true)
    let resetting: Promise<void> | undefined
    try {
      await vi.waitFor(() => expect(session.hasPendingResponses).toHaveBeenCalled())
      let resetFinished = false
      resetting = registry.reset(1).then(() => {
        resetFinished = true
      })
      checking.resolve()
      await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce())
      expect(resetFinished).toBe(false)
      closing.resolve()
      await Promise.all([recovering, resetting])
      expect(resetFinished).toBe(true)
      expect(dispose).toHaveBeenCalledOnce()
    } finally {
      checking.resolve()
      closing.resolve()
      await Promise.all([recovering, resetting])
      await registry.dispose()
    }
  })

  it("waits for recovery eviction to close storage before reacquiring the chat", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sumire-recovery-"))
    const gate = deferred()
    const first = Object.assign(new FakeSession("first"), {
      hasPendingResponses: async () => false,
      recoverPending: async () => {},
    })
    const dispose = vi.spyOn(first, "dispose").mockImplementation(async () => {
      await gate.promise
    })
    const second = new FakeSession("second")
    let calls = 0
    const create = vi.fn(async () => (++calls === 1 ? first : second))
    const registry = new ChatSessionRegistry(create, root, logger)
    const recovering = registry.recover([1], async () => true)
    try {
      await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce())
      const submission = registry.submit(1, "new request")
      await Promise.resolve()
      expect(create).toHaveBeenCalledOnce()
      gate.resolve()
      await recovering
      await submission
      expect(create).toHaveBeenCalledTimes(2)
      expect(second.prompts).toEqual(["new request"])
    } finally {
      gate.resolve()
      await recovering
      await registry.dispose()
    }
  })
})

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
