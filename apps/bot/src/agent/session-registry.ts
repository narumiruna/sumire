import { rm } from "node:fs/promises"
import path from "node:path"

import type { ImageContent } from "@earendil-works/pi-ai"
import type {
  AgentSessionEvent,
  AgentSessionEventListener,
  SessionEntry,
} from "@earendil-works/pi-coding-agent"
import {
  PROGRESS_TOOL_NAME,
  type ProgressStep,
  parseProgressDetails,
} from "@narumitw/sumire-progress"
import type { AdminStore } from "../admin/store.js"
import type { Logger } from "../logging.js"
import { type DurableAnswer, NO_RESPONSE_TEXT } from "./durable-session.js"
import type { ResponseDelivery } from "./durable-state.js"
import { type PiReplyCheckpoint, TelegramReplyIndex } from "./reply-index.js"

export interface SubmissionCheckpoint extends PiReplyCheckpoint {
  generation: number
  requestId?: string
}

export type SubmissionResult =
  | { kind: "completed"; text: string; checkpoint?: SubmissionCheckpoint }
  | { kind: "no_response"; text: string; checkpoint?: SubmissionCheckpoint }
  | { kind: "steered"; text: string }
  | { kind: "followed_up"; text: string }

export type SubmissionIntent = "steer" | "followUp" | "newTurn"
export type SubmissionActivity = "model" | "tool" | "tool_finished"

export interface SessionHandle {
  readonly isStreaming: boolean
  readonly isIdle: boolean
  readonly sessionId: string
  readonly sessionManager: {
    getLeafId(): string | null
    getEntry(id: string): unknown
    getBranch(): SessionEntry[]
  }
  subscribe(listener: AgentSessionEventListener): () => void
  prompt(
    text: string,
    options?: { images?: ImageContent[]; onAccepted?: () => void; delivery?: ResponseDelivery },
  ): Promise<DurableAnswer>
  steer(text: string, images?: ImageContent[]): Promise<"queued">
  followUp(text: string, images?: ImageContent[]): Promise<"queued">
  sendCustomMessage(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): Promise<void>
  navigateTree(targetId: string, options?: { summarize?: boolean }): Promise<{ cancelled: boolean }>
  waitForIdle(): Promise<void>
  abort(): Promise<void>
  dispose(): void | Promise<void>
  acknowledge(requestId: string): Promise<void>
  hasPendingResponses(): Promise<boolean>
  recoverPending(
    deliver: (answer: DurableAnswer, delivery: ResponseDelivery) => Promise<void>,
  ): Promise<void>
}

export type SessionCreator = (chatId: number) => Promise<SessionHandle>

interface ChatSessionRegistryOptions {
  control: AdminStore
  replyTreeEnabled?: boolean
  replyTreeMaxRecordsPerChat?: number
  replyTreeMaxIndexBytes?: number
}

export class ChatSessionRegistry {
  readonly #sessions = new Map<number, SessionHandle>()
  readonly #recoveries = new Set<Promise<void>>()
  readonly #recoveryOnly = new Set<SessionHandle>()
  readonly #evicting = new Map<number, Promise<void>>()
  #closed = false
  #disposing?: Promise<void>

  readonly #creating = new Map<number, Promise<SessionHandle>>()
  readonly #generations = new Map<number, number>()
  readonly #activePromptCaptures = new Map<number, { generation: number; done: Promise<void> }>()
  readonly #branchNavigations = new Map<number, Promise<void>>()
  readonly #resets = new Map<number, Promise<void>>()
  readonly #pendingReplyCheckpoints = new Map<number, Map<number, SubmissionCheckpoint>>()
  readonly #replyTreeEnabled: boolean
  readonly #replyIndex: TelegramReplyIndex

  constructor(
    private readonly createSession: SessionCreator,
    private readonly sessionRoot: string,
    private readonly logger: Logger,
    private readonly options: ChatSessionRegistryOptions,
  ) {
    if (!options?.control) throw new Error("Database authorization is required")
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
      delivery?: ResponseDelivery
      intent?: SubmissionIntent
      replyToBotMessageId?: number
      unresolvedReplyPrompt?: string
      onAccepted?: () => void
      onProgress?: (steps: readonly ProgressStep[]) => void
      onActivity?: (activity: SubmissionActivity, toolName?: string) => void
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
    this.logger.info(
      `Pi submission chat_id=${chatId} session_id=${session.sessionId} reply_branch_restored=${restoredBranch} intent=${options.intent ?? "automatic"}`,
    )
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
        await session.followUp(submissionPrompt, images)
        options.onAccepted?.()
        return { kind: "followed_up", text: "已將新訊息排在目前任務完成後處理。" }
      }
      await session.steer(submissionPrompt, images)
      options.onAccepted?.()
      return { kind: "steered", text: "已將新訊息加入目前任務。" }
    }

    assertCurrent()
    const notifyProgress = options.onProgress
      ? progressListener(options.onProgress, this.logger)
      : undefined
    const unsubscribe = session.subscribe((event) => {
      notifyProgress?.(event)
      if (options.onActivity) {
        const activity = submissionActivity(event)
        if (activity) {
          try {
            options.onActivity(activity, "toolName" in event ? event.toolName : undefined)
          } catch (error) {
            this.logger.warn("Activity listener failed", error)
          }
        }
      }
      logPiEvent(event, chatId, session.sessionId, this.logger)
    })
    let finishCapture = () => {}
    const capture = {
      generation,
      done: new Promise<void>((resolve) => {
        finishCapture = resolve
      }),
    }
    this.#activePromptCaptures.set(chatId, capture)
    try {
      const answer = await session.prompt(submissionPrompt, {
        ...(images.length > 0 ? { images } : {}),
        ...(options.delivery ? { delivery: options.delivery } : {}),
        onAccepted: options.onAccepted,
      })
      const text = answer.text
      const entryId = answer.entryId ?? session.sessionManager.getLeafId()
      return {
        kind: text ? "completed" : "no_response",
        text: text || NO_RESPONSE_TEXT,
        ...(entryId && (text || answer.requestId)
          ? {
              checkpoint: {
                sessionId: session.sessionId,
                entryId,
                generation,
                ...(answer.requestId ? { requestId: answer.requestId } : {}),
              },
            }
          : {}),
      }
    } finally {
      unsubscribe()
      if (this.#activePromptCaptures.get(chatId) === capture) {
        this.#activePromptCaptures.delete(chatId)
      }
      finishCapture()
    }
  }

  holdReplyCheckpoint(
    chatId: number,
    checkpoint: SubmissionCheckpoint | undefined,
    telegramMessageId: number,
  ): () => void {
    const session = this.#sessions.get(chatId)
    if (
      !this.#replyTreeEnabled ||
      !checkpoint ||
      !session ||
      !Number.isSafeInteger(telegramMessageId) ||
      telegramMessageId <= 0 ||
      (this.#generations.get(chatId) ?? 0) !== checkpoint.generation ||
      session.sessionId !== checkpoint.sessionId
    ) {
      return () => undefined
    }
    const aliases = this.#pendingReplyCheckpoints.get(chatId) ?? new Map()
    aliases.set(telegramMessageId, checkpoint)
    this.#pendingReplyCheckpoints.set(chatId, aliases)
    return () => {
      if (aliases.get(telegramMessageId) !== checkpoint) return
      aliases.delete(telegramMessageId)
      if (aliases.size === 0 && this.#pendingReplyCheckpoints.get(chatId) === aliases) {
        this.#pendingReplyCheckpoints.delete(chatId)
      }
    }
  }

  async recordDelivery(
    chatId: number,
    checkpoint: SubmissionCheckpoint | undefined,
    telegramMessageIds: readonly number[],
  ): Promise<void> {
    if (!checkpoint) return
    const session = this.#sessions.get(chatId)
    if (
      !session ||
      (this.#generations.get(chatId) ?? 0) !== checkpoint.generation ||
      session.sessionId !== checkpoint.sessionId
    ) {
      return
    }
    if (this.#replyTreeEnabled) {
      try {
        if (await session.sessionManager.getEntry(checkpoint.entryId))
          await this.#replyIndex.record(chatId, telegramMessageIds, checkpoint)
      } catch (error) {
        this.logger.warn(
          `Could not persist Telegram reply mapping for chat_id=${chatId}; branch restoration is unavailable for this reply`,
          error,
        )
      }
    }
    if (checkpoint.requestId) {
      try {
        await session.acknowledge(checkpoint.requestId)
      } catch (error) {
        this.logger.warn(`Could not acknowledge durable delivery for chat_id=${chatId}`, error)
      }
    }
  }

  async recover(
    chatIds: readonly number[],
    deliver: (
      chatId: number,
      answer: DurableAnswer,
      delivery: ResponseDelivery,
      checkpoint: SubmissionCheckpoint | undefined,
      isCurrent: () => boolean,
    ) => Promise<boolean>,
  ): Promise<void> {
    for (const chatId of chatIds) {
      if (this.#closed) break
      const generation = this.#generations.get(chatId) ?? 0
      let session: SessionHandle
      try {
        session = await this.#getOrCreate(chatId, true)
        // Close idle historical databases before opening the next one.
        if (await this.#releaseRecoverySession(chatId, session)) continue
      } catch (error) {
        this.logger.warn(`Durable recovery could not open chat_id=${chatId}`, error)
        continue
      }
      if (this.#closed) break
      const isCurrent = () =>
        !this.#closed &&
        (this.#generations.get(chatId) ?? 0) === generation &&
        this.#sessions.get(chatId) === session
      const recovery = session
        .recoverPending(async (answer, delivery) => {
          if (!isCurrent()) return
          const checkpoint = answer.entryId
            ? {
                sessionId: session.sessionId,
                entryId: answer.entryId,
                generation,
                requestId: answer.requestId,
              }
            : undefined
          if (await deliver(chatId, answer, delivery, checkpoint, isCurrent)) {
            if (answer.requestId && isCurrent()) await session.acknowledge(answer.requestId)
          }
        })
        .finally(() => this.#releaseRecoverySession(chatId, session))
        .catch((error) => {
          if (isCurrent()) this.logger.warn(`Durable recovery failed for chat_id=${chatId}`, error)
        })
      this.#recoveries.add(recovery)
      void recovery.finally(() => this.#recoveries.delete(recovery))
    }
  }

  async #releaseRecoverySession(chatId: number, session: SessionHandle): Promise<boolean> {
    if (this.#closed || !this.#recoveryOnly.has(session)) return false
    const pending = await session.hasPendingResponses()
    if (
      pending !== false ||
      !session.isIdle ||
      this.#closed ||
      this.#resets.has(chatId) ||
      !this.#recoveryOnly.has(session) ||
      this.#sessions.get(chatId) !== session
    )
      return false

    this.#sessions.delete(chatId)
    this.#recoveryOnly.delete(session)
    // A live caller must wait for storage close before becoming its new owner.
    const closing = Promise.resolve().then(() => session.dispose())
    this.#evicting.set(chatId, closing)
    try {
      await closing
    } finally {
      if (this.#evicting.get(chatId) === closing) this.#evicting.delete(chatId)
    }
    return true
  }

  async appendPassiveContext(chatId: number, text: string): Promise<void> {
    if (!text) return
    const generation = this.#generations.get(chatId) ?? 0
    const session = await this.#getOrCreate(chatId)
    this.#assertCurrentGeneration(chatId, generation)
    await session.sendCustomMessage(
      { customType: "telegram-passive-context", content: text, display: false },
      // Context-only writes do not trigger a turn. Harness queues them while busy
      // and places them at a boundary before later addressed inputs.
      { triggerTurn: false },
    )
  }

  async cancel(chatId: number): Promise<boolean> {
    const branchNavigation = this.#branchNavigations.get(chatId)
    if (branchNavigation) await branchNavigation
    const session = this.#sessions.get(chatId)
    if (!session?.isStreaming) {
      if (session) {
        this.#generations.set(chatId, (this.#generations.get(chatId) ?? 0) + 1)
        await session.abort()
      }
      return branchNavigation !== undefined
    }
    this.#generations.set(chatId, (this.#generations.get(chatId) ?? 0) + 1)
    await session.abort()
    return true
  }

  async reset(chatId: number): Promise<void> {
    const previous = this.#resets.get(chatId)
    if (previous) return previous
    const resetting = this.#resetChat(chatId)
    this.#resets.set(chatId, resetting)
    try {
      await resetting
    } finally {
      if (this.#resets.get(chatId) === resetting) this.#resets.delete(chatId)
    }
  }

  async #resetChat(chatId: number): Promise<void> {
    this.#generations.set(chatId, (this.#generations.get(chatId) ?? 0) + 1)
    this.#pendingReplyCheckpoints.delete(chatId)
    await this.#evicting.get(chatId)
    await this.#creating.get(chatId)?.catch(() => undefined)
    const session = this.#sessions.get(chatId)
    if (session) {
      if (session.isStreaming) await session.abort()
      await this.#activePromptCaptures.get(chatId)?.done
      await session.dispose()
      this.#sessions.delete(chatId)
      this.#recoveryOnly.delete(session)
    }
    this.#creating.delete(chatId)
    const cleanup = await Promise.allSettled([
      rm(path.join(this.sessionRoot, String(chatId), "pi"), { force: true, recursive: true }),
      rm(path.join(this.sessionRoot, String(chatId), "durable"), { force: true, recursive: true }),
      this.#replyIndex.clear(chatId),
    ])
    for (const result of cleanup) if (result.status === "rejected") throw result.reason
  }

  /** Invalidate policy snapshots without removing transcripts or reply indexes. */
  async invalidatePolicies(): Promise<void> {
    const ids = new Set([...this.#sessions.keys(), ...this.#creating.keys()])
    for (const chatId of ids)
      this.#generations.set(chatId, (this.#generations.get(chatId) ?? 0) + 1)
    await Promise.allSettled([
      ...this.#creating.values(),
      ...this.#resets.values(),
      ...this.#evicting.values(),
    ])
    const results = await Promise.allSettled(
      [...this.#sessions.entries()].map(async ([chatId, session]) => {
        await session.abort()
        await this.#activePromptCaptures.get(chatId)?.done
        await this.#branchNavigations.get(chatId)
        await session.dispose()
        this.#sessions.delete(chatId)
        this.#recoveryOnly.delete(session)
        this.#pendingReplyCheckpoints.delete(chatId)
      }),
    )
    for (const result of results)
      if (result.status === "rejected")
        throw new Error("A session could not apply the policy change")
  }

  dispose(): Promise<void> {
    this.#disposing ??= this.#dispose()
    return this.#disposing
  }

  async #dispose(): Promise<void> {
    this.#closed = true
    this.#pendingReplyCheckpoints.clear()
    for (const chatId of new Set([...this.#creating.keys(), ...this.#sessions.keys()])) {
      this.#generations.set(chatId, (this.#generations.get(chatId) ?? 0) + 1)
    }

    await Promise.all([
      ...[...this.#sessions.values()].map(async (session) => {
        // Closing durable storage leaves admitted work pending; only explicit cancellation aborts it.
        await session.dispose()
      }),
      ...[...this.#creating.values()].map((creation) => creation.catch(() => undefined)),
      ...this.#recoveries,
      ...this.#evicting.values(),
      ...[...this.#resets.values()].map((resetting) => resetting.catch(() => undefined)),
    ])
    this.#sessions.clear()
    this.#creating.clear()
    this.#recoveryOnly.clear()
    this.#evicting.clear()
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
    const target =
      this.#pendingReplyCheckpoints.get(chatId)?.get(telegramMessageId) ??
      (await this.#replyIndex.resolve(chatId, telegramMessageId))
    assertCurrent()
    if (
      !target ||
      target.sessionId !== session.sessionId ||
      !(await session.sessionManager.getEntry(target.entryId))
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
    // A reply to an older bot message switches to a sibling Pi branch. Carry
    // only the passive messages since the most recent model/user message, not
    // older background or prompts from the branch we are leaving.
    const recentPassiveContexts: string[] = []
    for (const entry of session.sessionManager.getBranch().reverse()) {
      if (entry.type === "message") break
      if (
        entry.type === "custom_message" &&
        entry.customType === "telegram-passive-context" &&
        typeof entry.content === "string"
      ) {
        recentPassiveContexts.unshift(entry.content)
      }
    }
    const navigation = (async () => {
      const result = await session.navigateTree(target.entryId, { summarize: false })
      if (result.cancelled) throw new Error("Pi session branch navigation was cancelled")
      try {
        assertCurrent()
        for (const content of recentPassiveContexts) {
          await session.sendCustomMessage(
            { customType: "telegram-passive-context", content, display: false },
            { triggerTurn: false },
          )
          assertCurrent()
        }
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

  async #getOrCreate(chatId: number, forRecovery = false): Promise<SessionHandle> {
    this.options.control.assertChat(chatId)
    const evicting = this.#evicting.get(chatId)
    if (evicting) await evicting
    const resetting = this.#resets.get(chatId)
    if (resetting) await resetting
    this.options.control.assertChat(chatId)
    if (this.#closed) throw new Error("Pi session registry is closed")
    const existing = this.#sessions.get(chatId)
    if (existing) {
      if (!forRecovery) this.#recoveryOnly.delete(existing)
      return existing
    }

    const inflight = this.#creating.get(chatId)
    if (inflight) {
      const session = await inflight
      this.options.control.assertChat(chatId)
      if (!forRecovery) this.#recoveryOnly.delete(session)
      return session
    }

    const generation = this.#generations.get(chatId) ?? 0
    const creation = this.createSession(chatId).then(async (session) => {
      try {
        if (this.#closed || (this.#generations.get(chatId) ?? 0) !== generation)
          throw new Error("Pi session creation was invalidated by reset")
        this.options.control.assertChat(chatId)
      } catch (error) {
        await session.dispose()
        throw error
      }
      this.#sessions.set(chatId, session)
      if (forRecovery) this.#recoveryOnly.add(session)
      this.logger.debug(`Created Pi session for chat_id=${chatId}`)
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

function logPiEvent(
  event: AgentSessionEvent,
  chatId: number,
  sessionId: string,
  logger: Logger,
): void {
  const prefix = `chat_id=${chatId} session_id=${sessionId}`
  if (event.type === "tool_execution_start") {
    logger.info(`Pi tool started ${prefix} tool=${event.toolName} call_id=${event.toolCallId}`)
  } else if (event.type === "tool_execution_end") {
    logger.info(
      `Pi tool finished ${prefix} tool=${event.toolName} call_id=${event.toolCallId} success=${!event.isError}`,
    )
  } else if (event.type === "message_end" && event.message.role === "assistant") {
    const message = event.message
    logger.info(
      `Pi model response ${prefix} model=${message.model} stop_reason=${message.stopReason} input_tokens=${message.usage.input} output_tokens=${message.usage.output} total_tokens=${message.usage.totalTokens}`,
    )
  } else if (event.type === "auto_retry_start") {
    logger.info(`Pi retry ${prefix} attempt=${event.attempt} max_attempts=${event.maxAttempts}`)
  } else if (event.type === "compaction_end") {
    logger.info(
      `Pi compaction ${prefix} reason=${event.reason} aborted=${event.aborted} will_retry=${event.willRetry}`,
    )
  }
}

export function asSessionCreator(factory: {
  create(chatId: number): Promise<SessionHandle>
}): SessionCreator {
  return (chatId) => factory.create(chatId)
}

function submissionActivity(event: AgentSessionEvent): SubmissionActivity | undefined {
  if (event.type === "agent_start" || event.type === "turn_start") return "model"
  if (event.type === "tool_execution_start" && event.toolName !== PROGRESS_TOOL_NAME) return "tool"
  if (event.type === "tool_execution_end" && event.toolName !== PROGRESS_TOOL_NAME)
    return "tool_finished"
  return undefined
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
