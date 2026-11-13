import { randomUUID } from "node:crypto"
import path from "node:path"

import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import {
  type Api,
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type ImageContent,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai"
import type {
  AgentSessionEvent,
  AgentSessionEventListener,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent"
import {
  AssistantEntry,
  type CommitObservation,
  type Conversation,
  type ConversationId,
  type ConversationView,
  type EntryId,
  type EntryRecord,
  type Harness,
  type LiveState,
  type NestedToolExecutionResult,
  type Observation,
  type Registry,
  type TaskId,
} from "@earendil-works/pi-durable"

import type { DurableInspectionQuery } from "@narumitw/sumire-contracts"
import type { DurableInspectionReader } from "../../admin/durable-inspector.js"
import { AdminError } from "../../admin/store.js"
import type { Logger } from "../../logging.js"
import { Semaphore } from "../../semaphore.js"
import type { SessionAnswer, SessionHandle, SessionSettlement } from "../session-registry.js"
import { assistantText, checkpointId, parseCheckpoint } from "./entries.js"
import {
  durableCommitEvents,
  durableReason,
  forwardDurableView,
  recordMessageEntries,
  recordNestedResults,
} from "./events.js"
import { GeneratedMediaFiles } from "./media.js"
import { forkCodemodeConversation } from "./migration.js"
import { type DurableAnswer, DurableOutbox } from "./outbox.js"
import {
  BotSessionDoc,
  ConversationPurposeDoc,
  OutboxDoc,
  type PendingResponse,
  type ResponseDelivery,
  validateBotSessionState,
} from "./state.js"
import { jsonValue, type NativeTool } from "./tools.js"

/** Transport adapter only: Harness owns every model turn and tool task. */
export class DurableSession implements SessionHandle {
  readonly #listeners = new Set<AgentSessionEventListener>()
  readonly #outbox: DurableOutbox
  #conversation: Conversation
  #observation?: Observation<ConversationView>
  #commits?: CommitObservation
  readonly #nestedResults = new Map<TaskId, NestedToolExecutionResult>()
  readonly #messageEntries = new Map<EntryId, EntryRecord>()
  #live?: LiveState
  #updates: Promise<void> = Promise.resolve()
  #closing?: Promise<void>
  #prompting = 0
  readonly #promptWaiters = new Set<() => void>()
  #epoch = 0
  #lastEntries: readonly EntryRecord[] = []
  sessionId = ""
  #model: Model<Api>
  #thinkingLevel: ModelThinkingLevel = "off"
  readonly #children = new Set<DurableSession>()
  readonly #admission = new Semaphore(4)
  readonly #resumedAdmissions = new Map<number, () => void>()
  readonly #unsentAdmissions = new Map<string, Promise<() => void>>()
  #recovering = 0

  private constructor(
    readonly harness: Harness,
    conversation: Conversation,
    readonly sessionFile: string,
    readonly cwd: string,
    model: Model<Api>,
    readonly modelRuntime: ModelRuntime,
    readonly registry: Registry,
    readonly systemPrompt: string,
    readonly nativeTools: NativeTool[],
    private readonly logger: Logger,
    private readonly cleanup: () => Promise<void>,
    private readonly inspection?: DurableInspectionReader,
    private readonly chatId?: number,
    private readonly authorizeMedia: () => void | Promise<void> = () => {
      throw new Error("Image delivery is unavailable")
    },
    private readonly owner?: DurableSession,
  ) {
    this.#conversation = conversation
    this.#model = model
    this.#outbox = new DurableOutbox(
      harness,
      new GeneratedMediaFiles(path.dirname(sessionFile)),
      async (pending) => {
        const root = this.rootOwner
        const reserved = root.#unsentAdmissions.get(pending.requestId)
        root.#unsentAdmissions.delete(pending.requestId)
        return reserved ?? root.#admission.acquire()
      },
    )
  }

  static async open(options: {
    harness: Harness
    sessionFile: string
    cwd: string
    model: Model<Api>
    modelRuntime: ModelRuntime
    registry: Registry
    systemPrompt: string
    nativeTools: NativeTool[]
    trustKey: string
    logger: Logger
    cleanup?: () => Promise<void>
    inspection?: DurableInspectionReader
    authorizeMedia?: () => void | Promise<void>
    chatId?: number
  }): Promise<DurableSession> {
    const root = await options.harness.root(context)
    const saved = validateBotSessionState(
      await root.commit(async (tx) => ({ ...(await tx.doc(BotSessionDoc)) }), context),
    )
    if (saved.trustKey && saved.trustKey !== options.trustKey) {
      // Fail closed after an authorization-policy change, before any pending task resumes.
      let cursor: import("@earendil-works/pi-durable").Cursor | undefined
      do {
        const page = await options.harness.commit(
          (tx) => tx.scanConversations({}, 100, cursor),
          context,
        )
        for (const record of page.items)
          await (await options.harness.conversation(record.id, context))?.abort(context)
        cursor = page.next
      } while (cursor)
      await options.harness.commit(async (tx) => {
        ;(await tx.doc(OutboxDoc)).pending = []
      }, context)
      options.logger.warn("Durable pending work cancelled because authorization changed", {
        "event.name": "pi.authorization.pending_cancelled",
        ...(options.chatId === undefined ? {} : { "telegram.chat_id": options.chatId }),
      })
    }
    await options.harness.commit(async (tx) => {
      ;(await tx.doc(BotSessionDoc)).trustKey = options.trustKey
    }, context)
    const conversation = await options.harness.conversation(
      saved.activeConversation as ConversationId,
      context,
    )
    if (
      !conversation ||
      !(await options.harness.conversation(saved.mainConversation as ConversationId, context))
    )
      throw new Error("Durable main or active conversation is missing")
    const agent = await conversation.agent(context)
    const restored = agent.model
      ? options.modelRuntime.getModel(agent.model.provider, agent.model.modelId)
      : undefined
    const selected =
      restored && (await options.modelRuntime.checkAuth(restored.provider))
        ? restored
        : options.model
    const session = new DurableSession(
      options.harness,
      conversation,
      options.sessionFile,
      options.cwd,
      selected,
      options.modelRuntime,
      options.registry,
      options.systemPrompt,
      options.nativeTools,
      options.logger,
      options.cleanup ?? (() => Promise.resolve()),
      options.inspection,
      options.chatId,
      options.authorizeMedia,
    )
    session.sessionId = saved.sessionId
    session.#thinkingLevel = clampThinkingLevel(selected, agent.thinkingLevel ?? "off")
    await conversation.configure(
      {
        model: { provider: selected.provider, modelId: selected.id },
        thinkingLevel: session.thinkingLevel,
        cwd: options.cwd,
      },
      context,
    )
    await session.#outbox.prepareFiles()
    await session.attach()
    const pending = await options.harness.snapshot(OutboxDoc, context)
    for (const id of new Set(pending?.pending.map((item) => item.conversationId))) {
      if (id === conversation.id) continue
      const retained = await options.harness.conversation(id, context)
      if (!retained) throw new Error("Durable pending conversation is missing")
      await session.attachChild(retained)
    }
    // Count live runs first. Queue unsent crash-window intents before admitting
    // new foreground input, without starting scheduling during initialization.
    for (const retained of [session, ...session.#children]) {
      if (retained.isMainStreaming)
        session.#resumedAdmissions.set(retained.#conversation.id, session.#admission.reserve())
    }
    for (const item of pending?.pending ?? []) {
      const native = await options.harness.commit(
        (tx) => tx.submissionByRequest(item.conversationId, item.requestId),
        context,
      )
      if (!native && item.answerEntryId === undefined)
        session.#unsentAdmissions.set(item.requestId, session.#admission.acquire())
    }
    return session
  }

  get conversationId(): number {
    return this.#conversation.id
  }

  async inspectDurable(query: DurableInspectionQuery, signal: AbortSignal) {
    if (this.#closing || !this.inspection)
      throw new AdminError(409, "Durable inspection is unavailable")
    const result = await this.inspection(query, signal)
    signal.throwIfAborted()
    if (this.#closing) throw new AdminError(409, "Durable inspection was invalidated")
    return result
  }

  get model(): Model<Api> {
    return this.#model
  }
  get thinkingLevel(): ModelThinkingLevel {
    return this.#thinkingLevel
  }
  getAvailableThinkingLevels(): ModelThinkingLevel[] {
    return getSupportedThinkingLevels(this.model)
  }

  async setModel(model: Model<Api>): Promise<void> {
    if (!(await this.modelRuntime.checkAuth(model.provider)))
      throw new Error("Model credentials are unavailable")
    const thinkingLevel = clampThinkingLevel(model, this.thinkingLevel)
    if (this.messages.length)
      await this.#conversation.configure(
        {
          model: { provider: model.provider, modelId: model.id },
          thinkingLevel,
        },
        context,
      )
    this.#model = model
    this.#thinkingLevel = thinkingLevel
  }

  async setThinkingLevel(level: ModelThinkingLevel): Promise<void> {
    const thinkingLevel = clampThinkingLevel(this.model, level)
    if (this.messages.length) await this.#conversation.configure({ thinkingLevel }, context)
    this.#thinkingLevel = thinkingLevel
  }

  get entries(): readonly EntryRecord[] {
    return this.#lastEntries
  }

  get messages(): AgentMessage[] {
    return this.entries.flatMap((entry) => entry.model ?? [])
  }

  private get rootOwner(): DurableSession {
    return this.owner ?? this
  }

  private get closing(): boolean {
    if (this.#closing) return true
    return this.owner ? Boolean(this.owner.#closing) : false
  }

  get isMainStreaming(): boolean {
    return this.#prompting > 0 || this.#live?.run !== undefined
  }

  get isStreaming(): boolean {
    return (
      this.isMainStreaming ||
      this.#recovering > 0 ||
      [...this.#children].some((child) => child.isStreaming)
    )
  }

  get isIdle(): boolean {
    return !this.isStreaming
  }

  getActiveToolNames(): string[] {
    return this.registry
      .snapshot()
      .tools()
      .filter(({ tool }) => tool.callers?.includes("model") !== false && !tool.deferred)
      .map(({ tool }) => tool.name)
  }

  subscribe(listener: AgentSessionEventListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  emit = (event: AgentSessionEvent): void => {
    for (const listener of this.#listeners) {
      try {
        listener(event)
      } catch (error) {
        this.logger.warn("Durable event listener failed", {
          "event.name": "pi.event.listener_failed",
          "pi.session_id": this.sessionId,
          error,
        })
      }
    }
  }

  async prompt(
    text: string,
    options: {
      images?: ImageContent[]
      onAccepted?: () => void
      delivery?: ResponseDelivery
    } = {},
  ): Promise<SessionAnswer> {
    if (this.closing) return { text: "", settlement: { status: "unanswered", reason: "aborted" } }
    const epoch = this.rootOwner.#epoch
    const requestId = randomUUID()
    const content = options.images?.length
      ? [{ type: "text" as const, text }, ...options.images]
      : text
    const pending: PendingResponse | undefined = options.delivery
      ? {
          requestId,
          conversationId: this.#conversation.id,
          content: jsonValue(content),
          delivery: jsonValue(options.delivery),
        }
      : undefined
    const owner = this.rootOwner
    this.resumePendingAdmissions()
    this.#prompting++
    let release: (() => void) | undefined
    try {
      if (epoch !== this.rootOwner.#epoch || this.closing)
        return { text: "", settlement: { status: "unanswered", reason: "aborted" } }
      const hasOlderInput = await owner.#outbox.admitPendingConversation(
        this.#conversation.id,
        () => epoch !== owner.#epoch || this.closing,
      )
      if (hasOlderInput && epoch === owner.#epoch && !this.closing)
        await this.#conversation.waitForIdle(context)
      if (epoch !== owner.#epoch || this.closing)
        return { text: "", settlement: { status: "unanswered", reason: "aborted" } }
      release = await owner.#admission.acquire()
      if (epoch !== owner.#epoch || this.closing)
        return { text: "", settlement: { status: "unanswered", reason: "aborted" } }
      await this.configureInput()
      // Write recovery intent first. submit's request ID closes the crash window between the two commits.
      if (pending) await this.#outbox.record(pending)
      if (epoch !== this.rootOwner.#epoch || this.closing) {
        await this.acknowledge(requestId)
        return { text: "", settlement: { status: "unanswered", reason: "aborted" } }
      }
      const submission = await this.#conversation.submit(
        { type: "input", content, requestId },
        context,
      )
      if (epoch !== this.rootOwner.#epoch) {
        await this.#conversation.abort(context)
        return { text: "", settlement: { status: "unanswered", reason: "aborted" } }
      }
      options.onAccepted?.()
      const settled = await submission.wait(context)
      const settlement: SessionSettlement = {
        status: settled.status,
        ...(settled.status === "unanswered" ? { reason: durableReason(settled.reason) } : {}),
      }
      if (pending) await this.#outbox.waitForRelated(requestId)
      if (this.closing) return { text: "", settlement }
      await this.refresh()
      await this.#updates
      const done = settled.status === "done" && settled.type === "input"
      const answer = done
        ? await this.harness.commit((tx) => tx.entry(AssistantEntry, settled.answer), context)
        : undefined
      if (answer && answer.conversationId !== this.#conversation.id)
        throw new Error("Durable answer belongs to another conversation")
      const inputEntryId =
        settled.entry === undefined ? undefined : `${this.#conversation.id}:${settled.entry}`
      const text = assistantText(answer)
      if (pending) {
        const result = await this.#outbox.answer(requestId, text, answer)
        if (answer && (done || result.media?.length))
          await this.#outbox.captureAnswer(requestId, answer.id)
        return {
          ...(done || result.media?.length ? result : { text: "", requestId }),
          settlement,
          inputEntryId,
        }
      }
      return {
        text,
        settlement,
        inputEntryId,
        ...(done && answer ? { entryId: checkpointId(answer) } : {}),
      }
    } finally {
      if (release) {
        if (this.closing) release()
        else void this.#conversation.waitForIdle(context).then(release, release)
      }
      this.#prompting--
      if (this.#prompting === 0) {
        for (const finish of this.#promptWaiters) finish()
        this.#promptWaiters.clear()
      }
    }
  }

  private async waitForPrompts(): Promise<void> {
    if (this.#prompting > 0) await new Promise<void>((resolve) => this.#promptWaiters.add(resolve))
  }

  async steer(text: string, images: ImageContent[] = []): Promise<"queued"> {
    await this.queue(text, images, "steer")
    return "queued"
  }

  async followUp(text: string, images: ImageContent[] = []): Promise<"queued"> {
    await this.queue(text, images, "followUp")
    return "queued"
  }

  async appendPassiveContext(
    text: string,
    onEntry?: (checkpoint: string) => void | Promise<void>,
    messageId?: number,
    onSettled?: () => void,
  ): Promise<void> {
    const entry = {
      kind: "telegram-passive-context",
      data: { content: text, ...(messageId === undefined ? {} : { telegramMessageId: messageId }) },
      model: [{ role: "user" as const, content: text, timestamp: Date.now() }],
    }
    // Writes are durably queued while busy, without starting or steering a turn.
    // Harness places them at the next boundary before subsequent addressed inputs.
    await this.configureInput()
    const submission = await this.#conversation.submit({ type: "write", entry }, context)
    if (onEntry || onSettled) {
      void submission
        .wait(context)
        .then(async (settled) => {
          if (settled.status === "done" && settled.type === "write" && !this.closing)
            await onEntry?.(`${this.#conversation.id}:${settled.entry}`)
        })
        .catch((error) => {
          if (!this.closing)
            this.logger.warn("Passive checkpoint capture failed", {
              "event.name": "pi.reply_mapping.failed",
              error,
            })
        })
        .finally(onSettled)
    }
    await this.refresh()
  }

  getCheckpoint(): string | null {
    const entry = this.entries.at(-1)
    return entry ? checkpointId(entry) : null
  }

  async hasCheckpoint(id: string): Promise<boolean> {
    return Boolean(await this.findEntry(id))
  }

  recentPassiveContext(): string[] {
    const contexts: string[] = []
    for (const entry of this.entries.toReversed()) {
      if (entry.kind === "telegram-passive-context") {
        contexts.unshift(String((entry.data as { content: string }).content))
      } else if (entry.model?.[0]) break
    }
    return contexts
  }

  async restoreBranch(id: string): Promise<void> {
    const target = parseCheckpoint(id)
    if (!target) throw new Error("Invalid durable checkpoint")
    await this.#conversation.waitForIdle(context)
    const source = await this.harness.conversation(target.conversationId, context)
    if (!source || !(await this.findEntry(id))) throw new Error("Durable checkpoint is missing")
    const fork = await forkCodemodeConversation(this.harness, source, target.entryId, context)
    await fork.configure(
      {
        model: { provider: this.model.provider, modelId: this.model.id },
        thinkingLevel: this.thinkingLevel,
        cwd: this.cwd,
      },
      context,
    )
    await this.harness.commit(async (tx) => {
      ;(await tx.doc(BotSessionDoc)).activeConversation = fork.id
    }, context)
    await this.detach()
    this.#conversation = fork
    await this.attach()
  }

  async waitForIdle(): Promise<void> {
    await this.#conversation.waitForIdle(context)
    await this.refresh()
  }

  async abort(): Promise<void> {
    const owner = this.rootOwner
    if (owner.closing) return
    owner.#epoch++
    const children = [...owner.#children]
    // Invalidate all delivery intents before any abort can settle a recovery waiter.
    await owner.#outbox.clear()
    owner.releaseUnsentAdmissions()
    let cursor: import("@earendil-works/pi-durable").Cursor | undefined
    do {
      const page = await this.harness.commit((tx) => tx.scanConversations({}, 100, cursor), context)
      await Promise.all(
        page.items.map(async (record) => {
          await (await this.harness.conversation(record.id, context))?.abort(context, {
            background: true,
          })
        }),
      )
      cursor = page.next
    } while (cursor)
    await Promise.all(children.map((child) => child.waitForPrompts()))
    await Promise.all(children.map((child) => child.dispose()))
    await owner.refresh()
  }

  dispose(): Promise<void> {
    this.#closing ??= (async () => {
      const children = [...this.#children]
      if (!this.owner) {
        for (const release of this.#resumedAdmissions.values()) release()
        this.#resumedAdmissions.clear()
        this.releaseUnsentAdmissions()
      }
      try {
        await this.detach()
        await Promise.all(children.map((child) => child.dispose()))
      } finally {
        if (this.owner) {
          this.owner.#children.delete(this)
          this.#listeners.clear()
        } else {
          try {
            await this.harness.close(context)
          } finally {
            try {
              await Promise.all([
                this.waitForPrompts(),
                ...children.map((child) => child.waitForPrompts()),
              ])
              await this.cleanup()
            } finally {
              this.#listeners.clear()
            }
          }
        }
      }
    })()
    return this.#closing
  }

  async acknowledge(requestId: string): Promise<void> {
    if (this.closing) return
    const response = (await this.harness.snapshot(OutboxDoc, context))?.pending.find(
      (item) => item.requestId === requestId,
    )
    await this.#outbox.acknowledge(requestId)
    const owner = this.rootOwner
    const child = [...owner.#children].find(
      (item) => item.conversationId === response?.conversationId,
    )
    if (!child) return
    // Only this response may release its handle; unrelated acknowledgements must
    // not dispose a child that is being created or is waiting for admission.
    void child.#conversation
      .waitForIdle(context)
      .then(async () => {
        const pending = await this.harness.snapshot(OutboxDoc, context)
        if (
          !owner.closing &&
          !child.isStreaming &&
          !pending?.pending.some((item) => item.conversationId === child.conversationId)
        )
          await child.dispose()
      })
      .catch(() => {})
  }

  async hasPendingResponses(): Promise<boolean> {
    return this.#outbox.hasPendingResponses()
  }

  async assertResponseMediaAccess(): Promise<void> {
    if (this.#closing) throw new Error("Image delivery is unavailable")
    await this.authorizeMedia()
    if (this.#closing) throw new Error("Image delivery is unavailable")
  }

  async readResponseImage(requestId: string, id: string): Promise<Buffer> {
    await this.assertResponseMediaAccess()
    const bytes = await this.#outbox.readImage(requestId, id)
    await this.assertResponseMediaAccess()
    return bytes
  }

  async recordResponseComponent(
    requestId: string,
    component: string,
    messageId: number,
  ): Promise<void> {
    if (this.#closing) throw new Error("Image delivery is unavailable")
    await this.#outbox.recordComponent(requestId, component, messageId)
  }

  async recoverPending(
    deliver: (answer: DurableAnswer, delivery: ResponseDelivery) => Promise<void>,
  ): Promise<void> {
    this.#recovering++
    try {
      await this.#outbox.recoverPending(
        async (answer, delivery) => {
          await this.refresh()
          await deliver(answer, delivery)
        },
        () => this.closing,
      )
    } finally {
      this.#recovering--
    }
  }

  async createConversation(
    checkpoint?: string,
    purpose: "article" | "reply" = checkpoint ? "reply" : "article",
  ): Promise<SessionHandle> {
    const owner = this.rootOwner
    if (owner.closing) throw new Error("Durable owner is closing")
    let conversation: Conversation
    if (checkpoint) {
      const target = parseCheckpoint(checkpoint)
      const source = target && (await this.harness.conversation(target.conversationId, context))
      if (!target || !source || !(await this.findEntry(checkpoint)))
        throw new Error("Durable checkpoint is missing")
      conversation = await forkCodemodeConversation(this.harness, source, target.entryId, context)
    } else {
      conversation = await this.harness.createConversation(
        {
          ownership: { kind: "ownerless" },
          agent: {
            model: { provider: owner.model.provider, modelId: owner.model.id },
            thinkingLevel: owner.thinkingLevel,
            cwd: owner.cwd,
          },
        },
        context,
      )
    }
    await conversation.configure(
      {
        model: { provider: owner.model.provider, modelId: owner.model.id },
        thinkingLevel: owner.thinkingLevel,
        cwd: owner.cwd,
      },
      context,
    )
    await conversation.commit(async (tx) => {
      ;(await tx.doc(ConversationPurposeDoc, conversation.id)).purpose = purpose
    }, context)
    return owner.attachChild(conversation)
  }

  private async attachChild(conversation: Conversation): Promise<DurableSession> {
    const owner = this.rootOwner
    const existing = [...owner.#children].find(
      (child) => child.#conversation.id === conversation.id,
    )
    if (existing) return existing
    const child = new DurableSession(
      this.harness,
      conversation,
      this.sessionFile,
      this.cwd,
      this.model,
      this.modelRuntime,
      this.registry,
      this.systemPrompt,
      this.nativeTools,
      this.logger,
      async () => {},
      undefined,
      this.chatId,
      this.authorizeMedia,
      owner,
    )
    child.sessionId = owner.sessionId
    child.#thinkingLevel = owner.thinkingLevel
    owner.#children.add(child)
    try {
      await child.attach()
      if (owner.closing) throw new Error("Durable owner is closing")
      return child
    } catch (error) {
      await child.dispose()
      throw error
    }
  }

  async hasPendingStatus(messageId: number): Promise<boolean> {
    return Boolean(
      (await this.harness.snapshot(OutboxDoc, context))?.pending.some(
        (item) => item.delivery.statusMessageId === messageId,
      ),
    )
  }

  async resolvePendingReply(messageId: number): Promise<string | undefined> {
    const owner = this.rootOwner
    const epoch = owner.#epoch
    const isStale = () => this.closing || epoch !== owner.#epoch
    const pending = (await this.harness.snapshot(OutboxDoc, context))?.pending.find(
      (item) =>
        item.delivery.sourceMessageId === messageId || item.delivery.statusMessageId === messageId,
    )
    if (isStale()) return undefined
    if (!pending) {
      const history = await this.#conversation.entries(
        { order: "descending" },
        1_000,
        undefined,
        context,
      )
      const passive = history.items.find(
        (entry) =>
          entry.kind === "telegram-passive-context" &&
          (entry.data as { telegramMessageId?: number } | undefined)?.telegramMessageId ===
            messageId,
      )
      return passive ? checkpointId(passive) : undefined
    }
    const readSubmission = () =>
      this.harness.commit(
        (tx) => tx.submissionByRequest(pending.conversationId, pending.requestId),
        context,
      )
    let record = await readSubmission()
    if (isStale()) return undefined
    if (!record && pending.answerEntryId === undefined) {
      this.resumePendingAdmissions()
      await owner.#outbox.admitPendingConversation(pending.conversationId, isStale)
      if (isStale()) return undefined
      record = await readSubmission()
    }
    if (!record) return undefined
    const submission = await this.harness.submission(record.id, context)
    const settled = await submission?.wait(context)
    if (isStale()) return undefined
    const entryId =
      pending.delivery.sourceMessageId === messageId
        ? settled?.entry
        : settled?.status === "done" && settled.type === "input"
          ? settled.answer
          : undefined
    if (entryId === undefined) return undefined
    const entry = await this.harness.commit((tx) => tx.entry(entryId), context)
    return entry?.conversationId === pending.conversationId ? checkpointId(entry) : undefined
  }

  private resumePendingAdmissions(): void {
    const owner = this.rootOwner
    if (owner.#unsentAdmissions.size > 0 && owner.#recovering === 0) {
      // Start saved intents; leave delivery and acknowledgement to the transport.
      void owner
        .recoverPending(async () => {})
        .catch((error: unknown) => {
          if (!owner.closing)
            owner.logger.warn("Durable admission recovery failed", {
              "event.name": "pi.recovery.failed",
              "telegram.chat_id": owner.chatId,
              "pi.session_id": owner.sessionId,
              error,
            })
        })
    }
    // Retained runs must free their reserved slots before new admission can proceed.
    this.harness.resume()
  }

  private releaseUnsentAdmissions(): void {
    for (const permit of this.#unsentAdmissions.values()) void permit.then((release) => release())
    this.#unsentAdmissions.clear()
  }

  private async configureInput(): Promise<void> {
    if (!this.messages.length)
      await this.#conversation.configure(
        {
          model: { provider: this.model.provider, modelId: this.model.id },
          thinkingLevel: this.thinkingLevel,
        },
        context,
      )
  }

  private async queue(text: string, images: ImageContent[], whenBusy: "steer" | "followUp") {
    if (this.#closing) return
    const epoch = this.#epoch
    await this.configureInput()
    if (epoch !== this.#epoch || this.#closing) return
    const requestId = randomUUID()
    await this.#outbox.relateInput(this.#conversation.id, requestId)
    if (epoch !== this.#epoch || this.#closing) return
    const submission = await this.#conversation.submit(
      {
        type: "input",
        requestId,
        content: images.length ? [{ type: "text", text }, ...images] : text,
        whenBusy,
      },
      context,
    )
    this.logger.info("Durable input queued", {
      "event.name": "pi.input.queued",
      "pi.session_id": this.sessionId,
      "pi.conversation_id": this.#conversation.id,
      "pi.request_id": requestId,
      "pi.submission_id": submission.id,
      "pi.intent": whenBusy,
      ...(this.chatId === undefined ? {} : { "telegram.chat_id": this.chatId }),
    })
    if (epoch !== this.#epoch && !this.#closing) await this.#conversation.abort(context)
  }

  private async findEntry(id: string): Promise<EntryRecord | undefined> {
    const target = parseCheckpoint(id)
    if (!target) return undefined
    const entry = await this.harness.commit((tx) => tx.entry(target.entryId), context)
    return entry?.conversationId === target.conversationId ? entry : undefined
  }

  private async detach(): Promise<void> {
    this.#observation?.detach()
    this.#commits?.detach()
    await this.#updates
    this.#nestedResults.clear()
    this.#messageEntries.clear()
  }

  private async attach(): Promise<void> {
    const conversationId = this.#conversation.id
    this.#commits = this.harness.observeCommits({
      advance: (publication) => {
        recordNestedResults(publication, conversationId, this.#nestedResults)
        recordMessageEntries(publication, conversationId, this.#messageEntries)
        const events = durableCommitEvents(publication, conversationId, this.sessionId, this.chatId)
        if (events.length) {
          this.#updates = this.#updates.then(() => {
            for (const event of events) this.logger.info(event.message, event.attributes)
          })
        }
      },
      end: () => {},
    })
    let previous: ConversationView | undefined
    const pending: ConversationView[] = []
    const receive = (value: ConversationView): void => {
      this.#live = value.docs["pi.live"] as LiveState | undefined
      if (!this.#live?.run) {
        this.rootOwner.#resumedAdmissions.get(conversationId)?.()
        this.rootOwner.#resumedAdmissions.delete(conversationId)
      }
      if (!previous) {
        // An observation can advance before its attachment promise resolves.
        pending.push(value)
        return
      }
      const prior = previous
      previous = value
      // Observers only record changes on the commit line. Notify listeners off that line,
      // in order, so even a tool that starts and ends between microtasks stays visible.
      this.#updates = this.#updates
        .then(async () => {
          if (prior.entries.at(-1)?.id !== value.entries.at(-1)?.id) await this.refresh()
          forwardDurableView(
            prior,
            value,
            this.emit,
            this.logger,
            this.sessionId,
            this.#nestedResults,
            this.#messageEntries,
            this.chatId,
          )
        })
        .catch((error) =>
          this.logger.warn("Durable conversation update failed", {
            "event.name": "pi.conversation.update_failed",
            "pi.session_id": this.sessionId,
            "pi.conversation_id": conversationId,
            error,
          }),
        )
    }
    this.#observation = await this.harness.observeConversation(
      this.#conversation.id,
      {
        advance: (call) => {
          if (call.kind === "value") receive(call.value)
        },
        end: () => {},
      },
      context,
    )
    previous = this.#observation.value
    this.#live = (pending.at(-1) ?? previous).docs["pi.live"] as LiveState | undefined
    for (const value of pending) receive(value)
    await this.refresh()
  }

  private async refresh(): Promise<void> {
    this.#lastEntries = (await this.#conversation.context(context)).entries
  }
}
