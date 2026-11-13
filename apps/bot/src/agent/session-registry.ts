import { rm } from "node:fs/promises"
import path from "node:path"
import type { ImageContent } from "@earendil-works/pi-ai"
import type { AgentSessionEvent, AgentSessionEventListener } from "@earendil-works/pi-coding-agent"
import type { DurableInspectionQuery, DurableInspectionResponse } from "@narumitw/sumire-contracts"
import {
  PROGRESS_TOOL_NAME,
  type ProgressStep,
  parseProgressDetails,
} from "@narumitw/sumire-progress"
import { AdminError, type AdminStore } from "../admin/store.js"
import { isCancellation, type Logger, setSpanError, withLogSpan } from "../logging.js"
import type { durableReason } from "./durable/events.js"
import type { GeneratedMedia } from "./durable/media.js"
import { type DurableAnswer, NO_RESPONSE_TEXT } from "./durable/outbox.js"
import type { ResponseDelivery } from "./durable/state.js"
import { type PiReplyCheckpoint, TelegramReplyIndex } from "./reply-index.js"

export interface SubmissionCheckpoint extends PiReplyCheckpoint {
  generation: number
  requestId?: string
}

export interface SessionSettlement {
  status: "done" | "unanswered"
  reason?: ReturnType<typeof durableReason>
}

export type SessionAnswer = DurableAnswer & { settlement?: SessionSettlement }

export interface SubmissionOptions {
  images?: ImageContent[]
  delivery?: ResponseDelivery
  intent?: SubmissionIntent
  routing?: "main" | "reply" | "article"
  replyToMessageId?: number
  replyToBotMessageId?: number
  unresolvedReplyPrompt?: string
  onAccepted?: () => void
  onProgress?: (steps: readonly ProgressStep[]) => void
  onActivity?: (activity: SubmissionActivity, toolName?: string) => void
  isCurrent?: () => boolean
}

interface PendingInput {
  sourceMessageId: number
  refs: number
  settled: boolean
  done: Promise<{ input?: SubmissionCheckpoint; answer?: SubmissionCheckpoint } | undefined>
  resolve(value: { input?: SubmissionCheckpoint; answer?: SubmissionCheckpoint } | undefined): void
}

export type SubmissionResult =
  | {
      kind: "completed"
      text: string
      checkpoint?: SubmissionCheckpoint
      media?: GeneratedMedia[]
      textMessageIds?: number[]
      settlement?: SessionSettlement
    }
  | {
      kind: "no_response"
      text: string
      checkpoint?: SubmissionCheckpoint
      settlement?: SessionSettlement
    }
  | { kind: "steered"; text: string }
  | { kind: "followed_up"; text: string }

export type SubmissionIntent = "steer" | "followUp" | "newTurn"
export type SubmissionActivity = "model" | "tool" | "tool_finished"

export interface SessionHandle {
  readonly isStreaming: boolean
  readonly isIdle: boolean
  readonly sessionId: string
  readonly isMainStreaming?: boolean
  readonly conversationId?: number
  createConversation?(checkpoint?: string, purpose?: "article" | "reply"): Promise<SessionHandle>
  resolvePendingReply?(messageId: number): Promise<string | undefined>
  hasPendingStatus?(messageId: number): Promise<boolean>
  getCheckpoint(): string | null
  hasCheckpoint(id: string): Promise<boolean>
  recentPassiveContext(): string[]
  subscribe(listener: AgentSessionEventListener): () => void
  prompt(
    text: string,
    options?: { images?: ImageContent[]; onAccepted?: () => void; delivery?: ResponseDelivery },
  ): Promise<SessionAnswer>
  steer(text: string, images?: ImageContent[]): Promise<"queued">
  followUp(text: string, images?: ImageContent[]): Promise<"queued">
  appendPassiveContext(
    text: string,
    onEntry?: (checkpoint: string) => void | Promise<void>,
    messageId?: number,
    onSettled?: () => void,
  ): Promise<void>
  restoreBranch(targetId: string): Promise<void>
  waitForIdle(): Promise<void>
  abort(): Promise<void>
  inspectDurable?(
    query: DurableInspectionQuery,
    signal: AbortSignal,
  ): Promise<DurableInspectionResponse>
  dispose(): void | Promise<void>
  acknowledge(requestId: string): Promise<void>
  hasPendingResponses(): Promise<boolean>
  assertResponseMediaAccess?(): void | Promise<void>
  readResponseImage?(requestId: string, id: string): Promise<Buffer>
  recordResponseComponent?(requestId: string, component: string, messageId: number): Promise<void>
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
  #inspectionBlocked = 0
  readonly #inspectionReads = new Map<
    number,
    { controller: AbortController; done: Promise<void> }
  >()

  readonly #creating = new Map<number, Promise<SessionHandle>>()
  readonly #generations = new Map<number, number>()
  readonly #activePromptCaptures = new Map<number, { generation: number; done: Promise<void> }>()
  readonly #branchNavigations = new Map<number, Promise<void>>()
  readonly #resets = new Map<number, Promise<void>>()
  readonly #pendingReplyCheckpoints = new Map<number, Map<number, SubmissionCheckpoint>>()
  readonly #replyTreeEnabled: boolean
  readonly #replyIndex: TelegramReplyIndex
  readonly #mainTails = new Map<number, Promise<void>>()
  readonly #pendingInputs = new Map<number, Map<number, PendingInput>>()

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

  /** Inspect loaded owners only. Cancellation never releases a still-running native read. */
  async inspectDurable(
    chatId: number,
    query: DurableInspectionQuery,
    signal: AbortSignal,
  ): Promise<DurableInspectionResponse> {
    if (
      this.#closed ||
      this.#inspectionBlocked ||
      this.#resets.has(chatId) ||
      this.#evicting.has(chatId)
    )
      throw new AdminError(409, "Durable inspection is unavailable during session changes")
    signal.throwIfAborted()
    if (this.#inspectionReads.has(chatId))
      throw new AdminError(409, "A durable inspection is already running")
    const session = this.#sessions.get(chatId)
    if (!session?.inspectDurable)
      return {
        version: 1,
        state: "not-loaded",
        readAt: new Date().toISOString(),
        view: query.view,
        items: [],
        truncated: false,
      }
    const generation = this.#generations.get(chatId) ?? 0
    const controller = new AbortController()
    const combined = AbortSignal.any([signal, controller.signal])
    let finish = () => {}
    const lease = {
      controller,
      done: new Promise<void>((resolve) => {
        finish = resolve
      }),
    }
    this.#inspectionReads.set(chatId, lease)
    try {
      const result = await session.inspectDurable(query, combined)
      combined.throwIfAborted()
      if (
        this.#closed ||
        this.#inspectionBlocked ||
        this.#sessions.get(chatId) !== session ||
        (this.#generations.get(chatId) ?? 0) !== generation
      )
        throw new AdminError(409, "Durable inspection was invalidated")
      return result
    } catch (error) {
      if (combined.aborted) throw new AdminError(409, "Durable inspection was cancelled")
      throw error
    } finally {
      if (this.#inspectionReads.get(chatId) === lease) this.#inspectionReads.delete(chatId)
      finish()
    }
  }

  async #cancelInspection(chatId: number): Promise<void> {
    const lease = this.#inspectionReads.get(chatId)
    lease?.controller.abort()
    await lease?.done
  }

  async isPendingStatus(chatId: number, messageId: number): Promise<boolean> {
    const aliases = this.#pendingInputs.get(chatId)?.get(messageId)
    if (aliases && aliases.sourceMessageId !== messageId) return true
    const owner = await this.#getOrCreate(chatId)
    return (await owner.hasPendingStatus?.(messageId)) ?? false
  }

  trackPendingInput(chatId: number, sourceMessageId: number, statusMessageId?: number): () => void {
    const aliases = this.#pendingInputs.get(chatId) ?? new Map<number, PendingInput>()
    this.#pendingInputs.set(chatId, aliases)
    let pending = aliases.get(sourceMessageId)
    if (!pending) {
      let resolve!: PendingInput["resolve"]
      const done = new Promise<Awaited<PendingInput["done"]>>((finish) => {
        resolve = finish
      })
      pending = {
        sourceMessageId,
        refs: 0,
        settled: false,
        done,
        resolve(value) {
          if (this.settled) return
          this.settled = true
          resolve(value)
        },
      }
      aliases.set(sourceMessageId, pending)
    }
    pending.refs++
    if (statusMessageId !== undefined) aliases.set(statusMessageId, pending)
    const held = pending
    let released = false
    return () => {
      if (released) return
      released = true
      if (--held.refs > 0) return
      held.resolve(undefined)
      for (const [id, value] of aliases) if (value === held) aliases.delete(id)
      if (aliases.size === 0 && this.#pendingInputs.get(chatId) === aliases)
        this.#pendingInputs.delete(chatId)
    }
  }

  async submit(
    chatId: number,
    prompt: string,
    options: SubmissionOptions = {},
  ): Promise<SubmissionResult> {
    const generation = this.#generations.get(chatId) ?? 0
    const source = options.delivery?.sourceMessageId
    const releaseInput =
      source === undefined
        ? () => {}
        : this.trackPendingInput(chatId, source, options.delivery?.statusMessageId)
    const pending = source === undefined ? undefined : this.#pendingInputs.get(chatId)?.get(source)
    const previous = options.routing === "main" ? this.#mainTails.get(chatId) : undefined
    let finish = () => {}
    let tail: Promise<void> | undefined
    if (options.routing === "main") {
      const gate = new Promise<void>((resolve) => {
        finish = resolve
      })
      tail = (previous ?? Promise.resolve()).then(() => gate)
      this.#mainTails.set(chatId, tail)
    }
    try {
      await previous
      this.#assertCurrentGeneration(chatId, generation)
      return await this.#submit(chatId, prompt, options)
    } finally {
      pending?.resolve(undefined)
      releaseInput()
      finish()
      if (tail && this.#mainTails.get(chatId) === tail) this.#mainTails.delete(chatId)
    }
  }

  async #submit(
    chatId: number,
    prompt: string,
    options: SubmissionOptions,
  ): Promise<SubmissionResult> {
    const generation = this.#generations.get(chatId) ?? 0
    const assertCurrent = () => {
      this.#assertCurrentGeneration(chatId, generation)
      if (options.isCurrent?.() === false) {
        throw new DOMException(
          "Pi session submission was cancelled before acceptance",
          "AbortError",
        )
      }
    }
    const owner = await this.#getOrCreate(chatId)
    assertCurrent()
    let session = owner
    let restoredBranch = false
    if (options.routing === "article" || options.routing === "reply") {
      if (!owner.createConversation) throw new Error("Independent conversations are unavailable")
      const target =
        options.routing === "reply"
          ? await this.#resolveReplyTarget(chatId, owner, options.replyToMessageId, assertCurrent)
          : undefined
      assertCurrent()
      session = await owner.createConversation(target?.entryId, options.routing)
      restoredBranch = target !== undefined
    } else if (!options.routing) {
      restoredBranch = await this.#restoreReplyBranch(
        chatId,
        session,
        options.replyToBotMessageId,
        generation,
        assertCurrent,
      )
    }
    assertCurrent()
    this.logger.info("Pi submission", {
      "event.name": "pi.submission",
      "telegram.chat_id": chatId,
      "pi.session_id": session.sessionId,
      "pi.conversation_id": session.conversationId,
      "pi.reply_branch_restored": restoredBranch,
      "pi.intent": options.intent ?? "automatic",
      "pi.routing": options.routing,
    })
    const images = options.images ?? []
    const submissionPrompt =
      !restoredBranch && options.unresolvedReplyPrompt ? options.unresolvedReplyPrompt : prompt
    if (!options.routing && !restoredBranch && options.intent === "newTurn") {
      const activeCapture = this.#activePromptCaptures.get(chatId)
      if (activeCapture?.generation === generation) await activeCapture.done
      if (!session.isIdle) await session.waitForIdle()
      assertCurrent()
    } else if (
      !options.routing &&
      !restoredBranch &&
      (session.isMainStreaming ?? session.isStreaming)
    ) {
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
            this.logger.warn("Activity listener failed", {
              "event.name": "pi.activity.listener_failed",
              "telegram.chat_id": chatId,
              "pi.session_id": session.sessionId,
              error,
            })
          }
        }
      }
    })
    let finishCapture = () => {}
    const capture = {
      generation,
      done: new Promise<void>((resolve) => {
        finishCapture = resolve
      }),
    }
    const independent = options.routing === "article" || options.routing === "reply"
    if (!independent) this.#activePromptCaptures.set(chatId, capture)
    try {
      const answer = await session.prompt(submissionPrompt, {
        ...(images.length > 0 ? { images } : {}),
        ...(options.delivery ? { delivery: options.delivery } : {}),
        onAccepted: options.onAccepted,
      })
      const text = answer.text
      const entryId = answer.entryId ?? answer.inputEntryId
      const checkpoint = (id: string): SubmissionCheckpoint => ({
        sessionId: session.sessionId,
        entryId: id,
        generation,
        ...(answer.requestId ? { requestId: answer.requestId } : {}),
      })
      const source = options.delivery?.sourceMessageId
      if (source !== undefined) {
        if (
          answer.inputEntryId &&
          this.#replyTreeEnabled &&
          (this.#generations.get(chatId) ?? 0) === generation &&
          this.#sessions.get(chatId) === owner &&
          options.isCurrent?.() !== false
        ) {
          try {
            await this.#replyIndex.record(chatId, [source], checkpoint(answer.inputEntryId))
          } catch (error) {
            this.logger.warn("Could not persist Telegram input mapping", {
              "event.name": "pi.reply_mapping.failed",
              "telegram.chat_id": chatId,
              error,
            })
          }
        }
        if (
          answer.entryId &&
          options.delivery?.statusMessageId !== undefined &&
          this.#replyTreeEnabled &&
          (this.#generations.get(chatId) ?? 0) === generation
        ) {
          try {
            await this.#replyIndex.record(
              chatId,
              [options.delivery.statusMessageId],
              checkpoint(answer.entryId),
            )
          } catch (error) {
            this.logger.warn("Could not persist Telegram status mapping", {
              "event.name": "pi.reply_mapping.failed",
              "telegram.chat_id": chatId,
              error,
            })
          }
        }
        this.#pendingInputs
          .get(chatId)
          ?.get(source)
          ?.resolve({
            ...(answer.inputEntryId ? { input: checkpoint(answer.inputEntryId) } : {}),
            ...(answer.entryId ? { answer: checkpoint(answer.entryId) } : {}),
          })
      }
      return {
        kind: text || answer.media?.length ? "completed" : "no_response",
        text: text || (answer.media?.length ? "" : NO_RESPONSE_TEXT),
        ...(answer.settlement ? { settlement: answer.settlement } : {}),
        ...(answer.media?.length
          ? { media: answer.media, textMessageIds: answer.textMessageIds ?? [] }
          : {}),
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
    acknowledge = true,
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
        if (await session.hasCheckpoint(checkpoint.entryId))
          await this.#replyIndex.record(chatId, telegramMessageIds, checkpoint)
      } catch (error) {
        this.logger.warn("Could not persist Telegram reply mapping", {
          "event.name": "pi.reply_mapping.failed",
          "telegram.chat_id": chatId,
          "pi.session_id": session.sessionId,
          error,
        })
      }
    }
    if (acknowledge && checkpoint.requestId) {
      try {
        await this.#acknowledgeDelivery(
          chatId,
          session,
          checkpoint.requestId,
          checkpoint.generation,
        )
      } catch (error) {
        this.logger.warn("Could not acknowledge durable delivery", {
          "event.name": "pi.delivery.acknowledge_failed",
          "telegram.chat_id": chatId,
          "pi.session_id": session.sessionId,
          "pi.request_id": checkpoint.requestId,
          error,
        })
      }
    }
  }

  async #acknowledgeDelivery(
    chatId: number,
    session: SessionHandle,
    requestId: string,
    generation: number,
    sourceMessageId?: number,
  ): Promise<void> {
    const isCurrent = () =>
      !this.#closed &&
      (this.#generations.get(chatId) ?? 0) === generation &&
      this.#sessions.get(chatId) === session
    await withLogSpan(
      this.logger,
      "telegram.acknowledge",
      {
        "telegram.chat_id": chatId,
        "pi.session_id": session.sessionId,
        "pi.request_id": requestId,
        "delivery.stage": "ack",
        ...(sourceMessageId === undefined ? {} : { "telegram.message_id": sourceMessageId }),
      },
      async (span) => {
        try {
          await session.acknowledge(requestId)
          // A closing session can resolve acknowledge without changing its outbox.
          const current = isCurrent()
          span.setAttribute("delivery.outcome", current ? "acknowledged" : "cancelled")
          span.setAttribute("operation.outcome", current ? "success" : "cancelled")
        } catch (error) {
          const cancelled = !isCurrent() || isCancellation(error)
          if (cancelled) {
            span.setAttribute("delivery.outcome", "cancelled")
            span.setAttribute("operation.outcome", "cancelled")
          } else {
            setSpanError(span, error)
            span.setAttribute("delivery.outcome", "pending")
          }
          throw error
        }
      },
    )
  }

  #deliverySession(chatId: number, checkpoint: SubmissionCheckpoint) {
    this.#assertCurrentGeneration(chatId, checkpoint.generation)
    this.options.control.assertChat(chatId)
    const session = this.#sessions.get(chatId)
    if (!checkpoint.requestId || !session || session.sessionId !== checkpoint.sessionId)
      throw new Error("Image delivery is stale")
    return session
  }

  async assertResponseMediaAccess(chatId: number, checkpoint: SubmissionCheckpoint): Promise<void> {
    const session = this.#deliverySession(chatId, checkpoint)
    if (!session.assertResponseMediaAccess) throw new Error("Image delivery is unavailable")
    await session.assertResponseMediaAccess()
    if (this.#deliverySession(chatId, checkpoint) !== session)
      throw new Error("Image delivery is stale")
  }

  async readResponseImage(
    chatId: number,
    checkpoint: SubmissionCheckpoint,
    id: string,
  ): Promise<Buffer> {
    const session = this.#deliverySession(chatId, checkpoint)
    if (!session.readResponseImage) throw new Error("Image delivery is unavailable")
    const bytes = await session.readResponseImage(checkpoint.requestId as string, id)
    if (this.#deliverySession(chatId, checkpoint) !== session)
      throw new Error("Image delivery is stale")
    return bytes
  }

  async recordResponseComponent(
    chatId: number,
    checkpoint: SubmissionCheckpoint,
    component: string,
    messageId: number,
  ): Promise<void> {
    const session = this.#deliverySession(chatId, checkpoint)
    if (!session.recordResponseComponent) throw new Error("Image delivery is unavailable")
    await session.recordResponseComponent(checkpoint.requestId as string, component, messageId)
    this.#deliverySession(chatId, checkpoint)
    await this.recordDelivery(chatId, checkpoint, [messageId], false)
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
        this.logger.warn("Durable recovery could not open chat", {
          "event.name": "pi.recovery.open_failed",
          "telegram.chat_id": chatId,
          error,
        })
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
          if (answer.inputEntryId && this.#replyTreeEnabled) {
            try {
              await this.#replyIndex.record(chatId, [delivery.sourceMessageId], {
                sessionId: session.sessionId,
                entryId: answer.inputEntryId,
              })
            } catch (error) {
              this.logger.warn("Could not persist recovered input mapping", {
                "event.name": "pi.reply_mapping.failed",
                "telegram.chat_id": chatId,
                error,
              })
            }
          }
          if (answer.entryId && delivery.statusMessageId !== undefined && this.#replyTreeEnabled) {
            try {
              await this.#replyIndex.record(chatId, [delivery.statusMessageId], {
                sessionId: session.sessionId,
                entryId: answer.entryId,
              })
            } catch (error) {
              this.logger.warn("Could not persist recovered status mapping", {
                "event.name": "pi.reply_mapping.failed",
                "telegram.chat_id": chatId,
                error,
              })
            }
          }
          const entryId = answer.entryId ?? (answer.media?.length ? answer.inputEntryId : undefined)
          const checkpoint = entryId
            ? {
                sessionId: session.sessionId,
                entryId,
                generation,
                requestId: answer.requestId,
              }
            : undefined
          if (await deliver(chatId, answer, delivery, checkpoint, isCurrent)) {
            if (answer.requestId && isCurrent())
              await this.#acknowledgeDelivery(
                chatId,
                session,
                answer.requestId,
                generation,
                delivery.sourceMessageId,
              )
          }
        })
        .finally(() => this.#releaseRecoverySession(chatId, session))
        .catch((error) => {
          if (isCurrent())
            this.logger.warn("Durable recovery failed", {
              "event.name": "pi.recovery.failed",
              "telegram.chat_id": chatId,
              "pi.session_id": session.sessionId,
              error,
            })
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
    const closing = this.#cancelInspection(chatId).then(() => session.dispose())
    this.#evicting.set(chatId, closing)
    try {
      await closing
    } finally {
      if (this.#evicting.get(chatId) === closing) this.#evicting.delete(chatId)
    }
    return true
  }

  async appendPassiveContext(chatId: number, text: string, messageId?: number): Promise<void> {
    if (!text) return
    const generation = this.#generations.get(chatId) ?? 0
    const session = await this.#getOrCreate(chatId)
    this.#assertCurrentGeneration(chatId, generation)
    if (messageId === undefined || !this.#replyTreeEnabled) {
      await session.appendPassiveContext(text)
      return
    }
    const release = this.trackPendingInput(chatId, messageId)
    try {
      await session.appendPassiveContext(
        text,
        async (entryId) => {
          try {
            if ((this.#generations.get(chatId) ?? 0) !== generation) return
            const checkpoint = { sessionId: session.sessionId, entryId, generation }
            await this.#replyIndex.record(chatId, [messageId], checkpoint)
            this.#pendingInputs.get(chatId)?.get(messageId)?.resolve({ input: checkpoint })
          } finally {
            release()
          }
        },
        messageId,
        release,
      )
    } catch (error) {
      release()
      throw error
    }
  }

  async cancel(chatId: number): Promise<boolean> {
    this.#clearPendingInputs(chatId)
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
    this.#clearPendingInputs(chatId)
    await this.#cancelInspection(chatId)
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
    this.#inspectionBlocked++
    for (const chatId of this.#pendingInputs.keys()) this.#clearPendingInputs(chatId)
    try {
      const ids = new Set([...this.#sessions.keys(), ...this.#creating.keys()])
      for (const chatId of ids)
        this.#generations.set(chatId, (this.#generations.get(chatId) ?? 0) + 1)
      await Promise.all([...this.#inspectionReads.keys()].map((id) => this.#cancelInspection(id)))
      await this.#invalidatePolicies()
    } finally {
      this.#inspectionBlocked--
    }
  }

  async #invalidatePolicies(): Promise<void> {
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
    await Promise.all([...this.#inspectionReads.keys()].map((id) => this.#cancelInspection(id)))
    this.#pendingReplyCheckpoints.clear()
    for (const chatId of this.#pendingInputs.keys()) this.#clearPendingInputs(chatId)
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
      throw new DOMException("Pi session access was invalidated by reset", "AbortError")
    }
  }

  #clearPendingInputs(chatId: number): void {
    const entries = this.#pendingInputs.get(chatId)
    this.#pendingInputs.delete(chatId)
    for (const entry of entries?.values() ?? []) entry.resolve(undefined)
  }

  async #resolveReplyTarget(
    chatId: number,
    owner: SessionHandle,
    messageId: number | undefined,
    assertCurrent: () => void,
  ): Promise<PiReplyCheckpoint | undefined> {
    if (!this.#replyTreeEnabled || messageId === undefined) return undefined
    const pending = this.#pendingInputs.get(chatId)?.get(messageId)
    let target: PiReplyCheckpoint | undefined
    if (pending) {
      const result = await pending.done
      target = pending.sourceMessageId === messageId ? result?.input : result?.answer
    } else {
      target =
        this.#pendingReplyCheckpoints.get(chatId)?.get(messageId) ??
        (await this.#replyIndex.resolve(chatId, messageId))
      if (!target) {
        const entryId = await owner.resolvePendingReply?.(messageId)
        if (entryId) target = { sessionId: owner.sessionId, entryId }
      }
    }
    assertCurrent()
    return target?.sessionId === owner.sessionId && (await owner.hasCheckpoint(target.entryId))
      ? target
      : undefined
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
      !(await session.hasCheckpoint(target.entryId))
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
    const previousLeafId = session.getCheckpoint()
    if (previousLeafId === target.entryId) return true
    // Carry only recent passive context, not older prompts from the branch we leave.
    const recentPassiveContexts = session.recentPassiveContext()
    const navigation = (async () => {
      await session.restoreBranch(target.entryId)
      try {
        assertCurrent()
        for (const content of recentPassiveContexts) {
          await session.appendPassiveContext(content)
          assertCurrent()
        }
      } catch (error) {
        if (
          previousLeafId &&
          this.#sessions.get(chatId) === session &&
          session.getCheckpoint() !== previousLeafId
        ) {
          await session.restoreBranch(previousLeafId)
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
          throw new DOMException("Pi session creation was invalidated by reset", "AbortError")
        this.options.control.assertChat(chatId)
      } catch (error) {
        await session.dispose()
        throw error
      }
      this.#sessions.set(chatId, session)
      if (forRecovery) this.#recoveryOnly.add(session)
      this.logger.debug("Created Pi session", {
        "event.name": "pi.session.created",
        "telegram.chat_id": chatId,
        "pi.session_id": session.sessionId,
      })
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
      logger.warn("Progress listener failed", {
        "event.name": "pi.progress.listener_failed",
        error,
      })
    }
  }
}

function toolResultDetails(result: unknown): unknown {
  return result && typeof result === "object" && "details" in result
    ? (result as { details: unknown }).details
    : undefined
}
