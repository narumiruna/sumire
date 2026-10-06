import { randomUUID } from "node:crypto"

import type { AttachedReplicatedState } from "@earendil-works/chord"
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import {
  type Api,
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type ImageContent,
  type Message,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai"
import type {
  AgentSessionEvent,
  AgentSessionEventListener,
  ModelRuntime,
  SessionEntry,
} from "@earendil-works/pi-coding-agent"
import {
  type AgentEvent,
  type AgentEventStream,
  type Conversation,
  type ConversationId,
  type ConversationView,
  type EntryId,
  type EntryRecord,
  type Harness,
  type Registry,
  type UserInput,
  watchEvents,
} from "@earendil-works/pi-durable"

import type { Logger } from "../logging.js"
import {
  BotSessionDoc,
  OutboxDoc,
  type PendingResponse,
  type ResponseDelivery,
} from "./durable-state.js"
import { jsonValue, type NativeTool } from "./durable-tools.js"
import type { SessionHandle } from "./session-registry.js"

export type DurableAnswer = { text: string; entryId?: string; requestId?: string }
export const NO_RESPONSE_TEXT = "模型沒有回覆內容，請稍後再試。"

/** Transport adapter only: Harness owns every model turn and tool task. */
export class DurableSession implements SessionHandle {
  readonly handlesAcceptance = true
  readonly #listeners = new Set<AgentSessionEventListener>()
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

  readonly sessionManager = {
    getLeafId: () => {
      const entry = this.entries.at(-1)
      return entry ? checkpointId(entry) : null
    },
    getEntry: (id: string) => this.findEntry(id),
    getBranch: () => this.entries.map(toSessionEntry),
    getCwd: () => this.cwd,
    getSessionId: () => this.sessionId,
    getSessionFile: () => this.sessionFile,
  }

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
  ) {
    this.#conversation = conversation
    this.#model = model
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
      options.logger.warn("Durable pending work cancelled because BOT_WHITELIST changed")
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
      if (pending)
        await this.harness.commit(async (tx) => {
          ;(await tx.doc(OutboxDoc)).pending.push(pending)
        }, context)
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
      if (pending && answer) await this.captureAnswer(requestId, answer.id)
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

  clearQueue() {
    return { steering: [], followUp: [] }
  }

  async sendCustomMessage(message: {
    customType: string
    content: string
    display: boolean
  }): Promise<void> {
    const entry = {
      kind: message.customType,
      data: { content: message.content },
      model: [{ role: "user" as const, content: message.content, timestamp: Date.now() }],
    }
    // Writes are durably queued while busy, without starting or steering a turn.
    // Harness places them at the next boundary before subsequent addressed inputs.
    await this.configureInput()
    await this.#conversation.submit({ type: "write", entry }, context)
    await this.refresh()
  }

  async navigateTree(id: string): Promise<{ cancelled: boolean }> {
    const target = parseCheckpoint(id)
    if (!target) throw new Error("Invalid durable checkpoint")
    await this.#conversation.waitForIdle(context)
    const source = await this.harness.conversation(target.conversationId, context)
    if (!source || !(await this.findEntry(id))) throw new Error("Durable checkpoint is missing")
    const fork = await source.fork(target.entryId, { ownership: { kind: "ownerless" } }, context)
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
    return { cancelled: false }
  }

  async waitForIdle(): Promise<void> {
    await this.#conversation.waitForIdle(context)
    await this.refresh()
  }

  async abort(): Promise<void> {
    if (this.#closing) return
    this.#epoch++
    // Invalidate delivery intents before cancellation can settle any waiting recovery handler.
    await this.harness.commit(async (tx) => {
      ;(await tx.doc(OutboxDoc)).pending = []
    }, context)
    await this.#conversation.abort(context)
    await this.refresh()
  }

  dispose(): Promise<void> {
    this.#closing ??= (async () => {
      await this.#events?.stop()
      this.#view?.dispose()
      await this.harness.close(context)
      this.#listeners.clear()
    })()
    return this.#closing
  }

  async acknowledge(requestId: string): Promise<void> {
    if (this.#closing) return
    await this.harness.commit(async (tx) => {
      const outbox = await tx.doc(OutboxDoc)
      outbox.pending = outbox.pending.filter((pending) => pending.requestId !== requestId)
    }, context)
  }

  async hasPendingResponses(): Promise<boolean> {
    return Boolean((await this.harness.snapshot(OutboxDoc, context))?.pending.length)
  }

  async recoverPending(
    deliver: (answer: DurableAnswer, delivery: ResponseDelivery) => Promise<void>,
  ): Promise<void> {
    this.harness.resume()
    const outbox = await this.harness.snapshot(OutboxDoc, context)
    for (const pending of outbox?.pending ?? []) {
      const conversation = await this.harness.conversation(pending.conversationId, context)
      if (!conversation) throw new Error("Durable outbox conversation is missing")
      let entry: EntryRecord | undefined
      if (pending.answerEntryId !== undefined) {
        entry = await this.harness.commit(
          (tx) => tx.entry(pending.answerEntryId as EntryId),
          context,
        )
      } else {
        const submission = await conversation.submit(
          { type: "input", requestId: pending.requestId, content: pending.content as UserInput },
          context,
        )
        const settled = await submission.wait(context)
        if (this.#closing) return
        await conversation.waitForIdle(context)
        if (settled.status === "done" && settled.type === "input") {
          const view = await conversation.context(context)
          entry = view.entries.findLast((candidate) =>
            candidate.model?.some((message) => message.role === "assistant"),
          )
          if (entry) await this.captureAnswer(pending.requestId, entry.id)
        }
      }
      if (this.#closing) return
      const current = await this.harness.snapshot(OutboxDoc, context)
      if (!current?.pending.some((item) => item.requestId === pending.requestId)) continue

      await this.refresh()
      const text = assistantText(entry)
      await deliver(
        {
          text: text || (entry ? NO_RESPONSE_TEXT : "AI 服務暫時無法使用，請稍後再試。"),
          requestId: pending.requestId,
          ...(entry ? { entryId: checkpointId(entry) } : {}),
        },
        text ? pending.delivery : { ...pending.delivery, mode: "default" },
      )
    }
  }

  private async captureAnswer(requestId: string, entryId: EntryId): Promise<void> {
    await this.harness.commit(async (tx) => {
      const pending = (await tx.doc(OutboxDoc)).pending.find((item) => item.requestId === requestId)
      if (pending) pending.answerEntryId = entryId
    }, context)
  }

  private async queue(text: string, images: ImageContent[], whenBusy: "steer" | "followUp") {
    await this.configureInput()
    await this.#conversation.submit(
      {
        type: "input",
        content: images.length ? [{ type: "text", text }, ...images] : text,
        whenBusy,
      },
      context,
    )
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
      for (const event of events) this.onEvent(event)
    })
    await this.refresh()
  }

  private async refresh(): Promise<void> {
    this.#lastEntries = (await this.#conversation.context(context)).entries
  }

  private onEvent(event: AgentEvent): void {
    if (event.type === "run_start") this.emit({ type: "agent_start" })
    else if (event.type === "tool_execution_start") this.emit(event)
    else if (event.type === "tool_execution_end") {
      const result = event.entry?.model?.find((message) => message.role === "toolResult")
      this.emit({
        type: "tool_execution_end",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result,
        isError: !result || result.isError,
      })
    } else if (event.type === "auto_retry_start") {
      this.logger.info(`Durable retry session_id=${this.sessionId} attempt=${event.attempt}`)
    } else if (event.type === "compaction_start" || event.type === "compaction_end") {
      this.logger.info(
        `Durable ${event.type} session_id=${this.sessionId} task_id=${event.taskId} reason=${event.reason}`,
      )
    } else if (event.type === "message_end") {
      const message = event.entry.model?.[0]
      if (message) this.emit({ type: "message_end", message })
    }
  }
}

function checkpointId(entry: EntryRecord): string {
  return `${entry.conversationId}:${entry.id}`
}

function parseCheckpoint(
  id: string,
): { conversationId: ConversationId; entryId: EntryId } | undefined {
  const [conversation, entry, extra] = id.split(":")
  const conversationId = Number(conversation)
  const entryId = Number(entry)
  return extra === undefined &&
    Number.isSafeInteger(conversationId) &&
    conversationId > 0 &&
    Number.isSafeInteger(entryId) &&
    entryId > 0
    ? { conversationId: conversationId as ConversationId, entryId: entryId as EntryId }
    : undefined
}

function assistantText(entry: EntryRecord | undefined): string {
  const message = entry?.model?.find((message) => message.role === "assistant")
  return message?.role === "assistant"
    ? message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim()
    : ""
}

function toSessionEntry(entry: EntryRecord): SessionEntry {
  const base = { id: checkpointId(entry), parentId: null, timestamp: "" }
  if (entry.kind === "telegram-passive-context")
    return {
      ...base,
      type: "custom_message",
      customType: entry.kind,
      content: String((entry.data as { content: string }).content),
      display: false,
    }
  const message = entry.model?.[0] as Message | undefined
  return message
    ? { ...base, type: "message", message }
    : { ...base, type: "custom", customType: entry.kind, data: entry.data }
}
