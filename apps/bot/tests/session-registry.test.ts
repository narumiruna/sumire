import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { AgentSessionEvent, AgentSessionEventListener } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"

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
  messages: AgentMessage[] = []
  readonly prompts: string[] = []
  readonly steering: string[] = []
  readonly followUps: string[] = []
  readonly contexts: string[] = []
  readonly listeners = new Set<AgentSessionEventListener>()
  aborted = false
  disposed = false

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

    await expect(registry.submit(1, "one")).resolves.toEqual({ kind: "completed", text: "AI: one" })
    await expect(registry.submit(1, "two")).resolves.toEqual({ kind: "completed", text: "AI: two" })
    await expect(registry.submit(2, "other")).resolves.toEqual({
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
    await expect(replacementSubmission).resolves.toEqual({ kind: "completed", text: "AI: fresh" })
    expect(staleSession.disposed).toBe(true)
    expect(staleSession.prompts).toEqual([])
    expect(replacementSession.prompts).toEqual(["fresh"])
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
