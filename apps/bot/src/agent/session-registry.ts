import { rm } from "node:fs/promises"
import path from "node:path"

import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { ImageContent } from "@earendil-works/pi-ai"
import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionEventListener,
} from "@earendil-works/pi-coding-agent"
import {
  PROGRESS_TOOL_NAME,
  type ProgressStep,
  parseProgressDetails,
} from "@narumitw/sumire-progress"

import type { Logger } from "../logging.js"
import { type PiReplyCheckpoint, TelegramReplyIndex } from "./reply-index.js"

export interface SubmissionCheckpoint extends PiReplyCheckpoint {
  generation: number
}

export type SubmissionResult =
  | { kind: "completed"; text: string; checkpoint?: SubmissionCheckpoint }
  | { kind: "steered"; text: string }
  | { kind: "followed_up"; text: string }

export type SubmissionIntent = "steer" | "followUp" | "newTurn"

export interface SessionHandle {
  readonly isStreaming: boolean
  readonly isIdle: boolean
  readonly sessionId: string
  readonly messages: AgentMessage[]
  readonly sessionManager: {
    getLeafId(): string | null
    getEntry(id: string): unknown
  }
  subscribe(listener: AgentSessionEventListener): () => void
  prompt(text: string, options?: { images?: ImageContent[] }): Promise<void>
  steer(text: string, images?: ImageContent[]): Promise<void>
  followUp(text: string, images?: ImageContent[]): Promise<void>
  clearQueue(): { steering: string[]; followUp: string[] }
  sendCustomMessage(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): Promise<void>
  navigateTree(targetId: string, options?: { summarize?: boolean }): Promise<{ cancelled: boolean }>
  waitForIdle(): Promise<void>
  abort(): Promise<void>
  dispose(): void
}

export type SessionCreator = (chatId: number) => Promise<SessionHandle>

interface ChatSessionRegistryOptions {
  replyTreeEnabled?: boolean
  replyTreeMaxRecordsPerChat?: number
  replyTreeMaxIndexBytes?: number
}

export class ChatSessionRegistry {
  readonly #sessions = new Map<number, SessionHandle>()
  readonly #creating = new Map<number, Promise<SessionHandle>>()
  readonly #generations = new Map<number, number>()
  readonly #activePromptCaptures = new Map<number, { generation: number; done: Promise<void> }>()
  readonly #branchNavigations = new Map<number, Promise<void>>()
  readonly #replyTreeEnabled: boolean
  readonly #replyIndex: TelegramReplyIndex

  constructor(
    private readonly createSession: SessionCreator,
    private readonly sessionRoot: string,
    private readonly logger: Logger,
    options: ChatSessionRegistryOptions = {},
  ) {
    this.#replyTreeEnabled = options.replyTreeEnabled ?? false
    this.#replyIndex = new TelegramReplyIndex(
      sessionRoot,
      options.replyTreeMaxRecordsPerChat ?? 1_000,
      options.replyTreeMaxIndexBytes ?? 1_000_000,
      logger,
    )
  }

  async submit(
    chatId: number,
    prompt: string,
    options: {
      images?: ImageContent[]
      intent?: SubmissionIntent
      replyToBotMessageId?: number
      unresolvedReplyPrompt?: string
      onAccepted?: () => void
      onProgress?: (steps: readonly ProgressStep[]) => void
      isCurrent?: () => boolean
    } = {},
  ): Promise<SubmissionResult> {
    const generation = this.#generations.get(chatId) ?? 0
    const assertCurrent = () => {
      this.#assertCurrentGeneration(chatId, generation)
      if (options.isCurrent?.() === false) {
        throw new Error("Pi session submission was cancelled before acceptance")
      }
    }
    const session = await this.#getOrCreate(chatId)
    assertCurrent()
    const restoredBranch = await this.#restoreReplyBranch(
      chatId,
      session,
      options.replyToBotMessageId,
      generation,
      assertCurrent,
    )
    assertCurrent()
    const images = options.images ?? []
    const submissionPrompt =
      !restoredBranch && options.unresolvedReplyPrompt ? options.unresolvedReplyPrompt : prompt
    if (!restoredBranch && options.intent === "newTurn") {
      const activeCapture = this.#activePromptCaptures.get(chatId)
      if (activeCapture?.generation === generation) await activeCapture.done
      if (!session.isIdle) await session.waitForIdle()
      assertCurrent()
    } else if (!restoredBranch && session.isStreaming) {
      assertCurrent()
      if (options.intent === "followUp") {
        const submission = session.followUp(submissionPrompt, images)
        options.onAccepted?.()
        await submission
        return { kind: "followed_up", text: "已將新訊息排在目前任務完成後處理。" }
      }
      const submission = session.steer(submissionPrompt, images)
      options.onAccepted?.()
      await submission
      return { kind: "steered", text: "已將新訊息加入目前任務。" }
    }

    assertCurrent()
    const previousMessageCount = session.messages.length
    const unsubscribe = options.onProgress
      ? session.subscribe(progressListener(options.onProgress, this.logger))
      : undefined
    let finishCapture = () => {}
    const capture = {
      generation,
      done: new Promise<void>((resolve) => {
        finishCapture = resolve
      }),
    }
    this.#activePromptCaptures.set(chatId, capture)
    try {
      const submission = session.prompt(
        submissionPrompt,
        images.length > 0 ? { images } : undefined,
      )
      options.onAccepted?.()
      await submission
      const entryId = session.sessionManager.getLeafId()
      return {
        kind: "completed",
        text:
          lastAssistantText(session.messages.slice(previousMessageCount)) ||
          "模型沒有回覆內容，請稍後再試。",
        ...(entryId ? { checkpoint: { sessionId: session.sessionId, entryId, generation } } : {}),
      }
    } finally {
      unsubscribe?.()
      if (this.#activePromptCaptures.get(chatId) === capture) {
        this.#activePromptCaptures.delete(chatId)
      }
      finishCapture()
    }
  }

  async recordDelivery(
    chatId: number,
    checkpoint: SubmissionCheckpoint | undefined,
    telegramMessageIds: readonly number[],
  ): Promise<void> {
    if (!this.#replyTreeEnabled || !checkpoint) return
    const session = this.#sessions.get(chatId)
    if (
      !session ||
      (this.#generations.get(chatId) ?? 0) !== checkpoint.generation ||
      session.sessionId !== checkpoint.sessionId ||
      !session.sessionManager.getEntry(checkpoint.entryId)
    ) {
      return
    }
    try {
      await this.#replyIndex.record(chatId, telegramMessageIds, checkpoint)
    } catch (error) {
      this.logger.warn(
        `Could not persist Telegram reply mapping for chat_id=${chatId}; branch restoration is unavailable for this reply`,
        error,
      )
    }
  }

  async appendPassiveContext(chatId: number, text: string): Promise<void> {
    if (!text) return
    const generation = this.#generations.get(chatId) ?? 0
    const session = await this.#getOrCreate(chatId)
    this.#assertCurrentGeneration(chatId, generation)
    await session.sendCustomMessage(
      { customType: "telegram-passive-context", content: text, display: false },
      { triggerTurn: false, deliverAs: "nextTurn" },
    )
  }

  async cancel(chatId: number): Promise<boolean> {
    const branchNavigation = this.#branchNavigations.get(chatId)
    if (branchNavigation) await branchNavigation
    const session = this.#sessions.get(chatId)
    if (!session?.isStreaming) return branchNavigation !== undefined
    session.clearQueue()
    await session.abort()
    return true
  }

  async reset(chatId: number): Promise<void> {
    this.#generations.set(chatId, (this.#generations.get(chatId) ?? 0) + 1)
    const session = this.#sessions.get(chatId)
    if (session) {
      if (session.isStreaming) {
        session.clearQueue()
        await session.abort()
      }
      session.dispose()
      this.#sessions.delete(chatId)
    }
    this.#creating.delete(chatId)
    await Promise.all([
      rm(path.join(this.sessionRoot, String(chatId), "pi"), { force: true, recursive: true }),
      this.#replyIndex.clear(chatId),
    ])
  }

  async dispose(): Promise<void> {
    for (const chatId of this.#creating.keys()) {
      this.#generations.set(chatId, (this.#generations.get(chatId) ?? 0) + 1)
    }
    await Promise.all(
      [...this.#sessions.values()].map(async (session) => {
        if (session.isStreaming) {
          session.clearQueue()
          await session.abort()
        }
        session.dispose()
      }),
    )
    this.#sessions.clear()
    this.#creating.clear()
  }

  #assertCurrentGeneration(chatId: number, generation: number): void {
    if ((this.#generations.get(chatId) ?? 0) !== generation) {
      throw new Error("Pi session access was invalidated by reset")
    }
  }

  async #restoreReplyBranch(
    chatId: number,
    session: SessionHandle,
    telegramMessageId: number | undefined,
    generation: number,
    assertCurrent: () => void,
  ): Promise<boolean> {
    if (!this.#replyTreeEnabled || telegramMessageId === undefined) return false
    const target = await this.#replyIndex.resolve(chatId, telegramMessageId)
    assertCurrent()
    if (
      !target ||
      target.sessionId !== session.sessionId ||
      !session.sessionManager.getEntry(target.entryId)
    ) {
      return false
    }
    // Pi can signal idle before prompt() unwinds. Preserve the finishing response
    // and checkpoint before navigation replaces the shared messages and leaf.
    const activeCapture = this.#activePromptCaptures.get(chatId)
    if (activeCapture?.generation === generation) {
      await activeCapture.done
      assertCurrent()
    }
    if (!session.isIdle) await session.waitForIdle()
    assertCurrent()
    const previousLeafId = session.sessionManager.getLeafId()
    if (previousLeafId === target.entryId) return true
    const navigation = (async () => {
      const result = await session.navigateTree(target.entryId, { summarize: false })
      if (result.cancelled) throw new Error("Pi session branch navigation was cancelled")
      try {
        assertCurrent()
      } catch (error) {
        if (
          previousLeafId &&
          this.#sessions.get(chatId) === session &&
          session.sessionManager.getLeafId() !== previousLeafId
        ) {
          const rollback = await session.navigateTree(previousLeafId, { summarize: false })
          if (rollback.cancelled) {
            throw new Error("Pi session branch navigation rollback was cancelled", { cause: error })
          }
        }
        throw error
      }
    })()
    const settledNavigation = navigation.then(
      () => undefined,
      () => undefined,
    )
    this.#branchNavigations.set(chatId, settledNavigation)
    try {
      await navigation
      return true
    } finally {
      if (this.#branchNavigations.get(chatId) === settledNavigation) {
        this.#branchNavigations.delete(chatId)
      }
    }
  }

  async #getOrCreate(chatId: number): Promise<SessionHandle> {
    const existing = this.#sessions.get(chatId)
    if (existing) return existing

    const inflight = this.#creating.get(chatId)
    if (inflight) return inflight

    const generation = this.#generations.get(chatId) ?? 0
    const creation = this.createSession(chatId).then((session) => {
      if ((this.#generations.get(chatId) ?? 0) !== generation) {
        session.dispose()
        throw new Error("Pi session creation was invalidated by reset")
      }
      this.#sessions.set(chatId, session)
      this.logger.debug(`Created Pi AgentSession for chat_id=${chatId}`)
      return session
    })
    this.#creating.set(chatId, creation)
    try {
      return await creation
    } finally {
      if (this.#creating.get(chatId) === creation) this.#creating.delete(chatId)
    }
  }
}

export function asSessionCreator(factory: {
  create(chatId: number): Promise<AgentSession>
}): SessionCreator {
  return (chatId) => factory.create(chatId)
}

function progressListener(
  onProgress: (steps: readonly ProgressStep[]) => void,
  logger: Logger,
): AgentSessionEventListener {
  return (event: AgentSessionEvent) => {
    if (
      event.type !== "tool_execution_end" ||
      event.toolName !== PROGRESS_TOOL_NAME ||
      event.isError
    ) {
      return
    }
    const details = parseProgressDetails(toolResultDetails(event.result))
    if (!details) return
    try {
      onProgress(details.steps)
    } catch (error) {
      logger.warn("Progress listener failed", error)
    }
  }
}

function toolResultDetails(result: unknown): unknown {
  return result && typeof result === "object" && "details" in result
    ? (result as { details: unknown }).details
    : undefined
}

function lastAssistantText(messages: AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== "assistant") continue
    return message.content
      .filter((content) => content.type === "text")
      .map((content) => content.text)
      .join("\n")
      .trim()
  }
  return ""
}
