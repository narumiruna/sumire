import { randomUUID } from "node:crypto"

import type { AttachedReplicatedState } from "@earendil-works/chord"
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
  type AgentEventStream,
  type Conversation,
  type ConversationId,
  type ConversationView,
  type EntryRecord,
  type Harness,
  type Registry,
  watchEvents,
} from "@earendil-works/pi-durable"

import type { DurableInspectionQuery } from "@narumitw/sumire-contracts"
import type { DurableInspectionReader } from "../../admin/durable-inspector.js"
import { AdminError } from "../../admin/store.js"
import type { Logger } from "../../logging.js"
import type { SessionHandle } from "../session-registry.js"
import { assistantText, checkpointId, parseCheckpoint } from "./entries.js"
import { forwardDurableEvent } from "./events.js"
import { forkCodemodeConversation } from "./migration.js"
import { type DurableAnswer, DurableOutbox } from "./outbox.js"
import { BotSessionDoc, OutboxDoc, type PendingResponse, type ResponseDelivery } from "./state.js"
import { jsonValue, type NativeTool } from "./tools.js"

/** Transport adapter only: Harness owns every model turn and tool task. */
export class DurableSession implements SessionHandle {
  readonly #listeners = new Set<AgentSessionEventListener>()
  readonly #outbox: DurableOutbox
  #conversation: Conversation
  #view?: AttachedReplicatedState<ConversationView>
  #events?: AgentEventStream
  #closing?: Promise<void>
  #prompting = 0
  #epoch = 0
  #lastEntries: readonly EntryRecord[] = []
  sessionId = ""
  #model: Model<Api>
  #thinkingLevel: ModelThinkingLevel = "off"

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
  ) {
    this.#conversation = conversation
    this.#model = model
    this.#outbox = new DurableOutbox(harness)
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
  }): Promise<DurableSession> {
    const root = await options.harness.root(context)
    const saved = await root.commit(async (tx) => ({ ...(await tx.doc(BotSessionDoc)) }), context)
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
      options.logger.warn("Durable pending work cancelled because authorization changed")
    }
    await options.harness.commit(async (tx) => {
      ;(await tx.doc(BotSessionDoc)).trustKey = options.trustKey
    }, context)
    const conversation = await options.harness.conversation(
      saved.activeConversation as ConversationId,
      context,
    )
    if (!conversation) throw new Error("Durable active conversation is missing")
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
    await session.attach()
    return session
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

  get isStreaming(): boolean {
    return this.#prompting > 0 || Boolean(this.#view?.value?.docs["pi.live"]?.run)
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
        this.logger.warn("Durable event listener failed", error)
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
  ): Promise<DurableAnswer> {
    const epoch = this.#epoch
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
    this.#prompting++
    try {
      await this.configureInput()
      // Write recovery intent first. submit's request ID closes the crash window between the two commits.
      if (pending) await this.#outbox.record(pending)
      if (epoch !== this.#epoch || this.#closing) {
        await this.acknowledge(requestId)
        return { text: "" }
      }
      const submission = await this.#conversation.submit(
        { type: "input", content, requestId },
        context,
      )
      if (epoch !== this.#epoch) {
        await this.#conversation.abort(context)
        return { text: "" }
      }
      options.onAccepted?.()
      const settled = await submission.wait(context)
      if (this.#closing) return { text: "" }
      await this.#conversation.waitForIdle(context)
      await this.refresh()
      if (settled.status !== "done" || settled.type !== "input") {
        // Terminal failures still need their transport fallback delivered and acknowledged.
        return { text: "", ...(pending ? { requestId } : {}) }
      }
      const answer = this.#lastEntries.findLast((entry) =>
        entry.model?.some((message) => message.role === "assistant"),
      )
      const text = assistantText(answer)
      // An empty answer still needs its Telegram fallback delivered and acknowledged.
      if (pending && answer) await this.#outbox.captureAnswer(requestId, answer.id)
      return {
        text,
        ...(answer ? { entryId: checkpointId(answer) } : {}),
        ...(pending ? { requestId } : {}),
      }
    } finally {
      this.#prompting--
    }
  }

  async steer(text: string, images: ImageContent[] = []): Promise<"queued"> {
    await this.queue(text, images, "steer")
    return "queued"
  }

  async followUp(text: string, images: ImageContent[] = []): Promise<"queued"> {
    await this.queue(text, images, "followUp")
    return "queued"
  }

  async appendPassiveContext(text: string): Promise<void> {
    const entry = {
      kind: "telegram-passive-context",
      data: { content: text },
      model: [{ role: "user" as const, content: text, timestamp: Date.now() }],
    }
    // Writes are durably queued while busy, without starting or steering a turn.
    // Harness places them at the next boundary before subsequent addressed inputs.
    await this.configureInput()
    await this.#conversation.submit({ type: "write", entry }, context)
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
    await this.#events?.stop()
    this.#view?.dispose()
    this.#conversation = fork
    await this.attach()
  }

  async waitForIdle(): Promise<void> {
    await this.#conversation.waitForIdle(context)
    await this.refresh()
  }

  async abort(): Promise<void> {
    if (this.#closing) return
    this.#epoch++
    // Invalidate delivery intents before cancellation can settle any waiting recovery handler.
    await this.#outbox.clear()
    await this.#conversation.abort(context)
    await this.refresh()
  }

  dispose(): Promise<void> {
    this.#closing ??= (async () => {
      try {
        await this.#events?.stop()
        this.#view?.dispose()
      } finally {
        try {
          await this.harness.close(context)
        } finally {
          try {
            await this.cleanup()
          } finally {
            this.#listeners.clear()
          }
        }
      }
    })()
    return this.#closing
  }

  async acknowledge(requestId: string): Promise<void> {
    if (this.#closing) return
    await this.#outbox.acknowledge(requestId)
  }

  async hasPendingResponses(): Promise<boolean> {
    return this.#outbox.hasPendingResponses()
  }

  async recoverPending(
    deliver: (answer: DurableAnswer, delivery: ResponseDelivery) => Promise<void>,
  ): Promise<void> {
    await this.#outbox.recoverPending(
      async (answer, delivery) => {
        await this.refresh()
        await deliver(answer, delivery)
      },
      () => Boolean(this.#closing),
    )
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
    await this.#conversation.submit(
      {
        type: "input",
        content: images.length ? [{ type: "text", text }, ...images] : text,
        whenBusy,
      },
      context,
    )
    if (epoch !== this.#epoch && !this.#closing) await this.#conversation.abort(context)
  }

  private async findEntry(id: string): Promise<EntryRecord | undefined> {
    const target = parseCheckpoint(id)
    if (!target) return undefined
    const entry = await this.harness.commit((tx) => tx.entry(target.entryId), context)
    return entry?.conversationId === target.conversationId ? entry : undefined
  }

  private async attach(): Promise<void> {
    this.#view = await this.#conversation.viewState(context)
    this.#view.subscribe((value) => {
      this.#lastEntries = value.entries
    })
    this.#events = await watchEvents(this.harness, this.#conversation.id, context)
    this.#events.start(async (events) => {
      for (const event of events) forwardDurableEvent(event, this.emit, this.logger, this.sessionId)
    })
    await this.refresh()
  }

  private async refresh(): Promise<void> {
    this.#lastEntries = (await this.#conversation.context(context)).entries
  }
}
