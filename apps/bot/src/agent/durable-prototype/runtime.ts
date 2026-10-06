import { mkdir, rm } from "node:fs/promises"
import path from "node:path"

import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import type { Models } from "pi-durable-ai"
import {
  AssistantEntry,
  defineDoc,
  Harness,
  type Conversation,
  type ConversationId,
  type EntryId,
  type Registry,
  type SettledSubmissionRecord,
  type Submission,
  type UserInput,
} from "@earendil-works/pi-durable"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"

type Reply = { ids: number[]; conversationId: ConversationId; entryId: EntryId }
export const Routing = defineDoc<{ active: ConversationId | null; replies: Reply[] }>({
  kind: "sumire.routing",
  version: 1,
  scope: "session",
  initial: () => ({ active: null, replies: [] }),
})

export const Progress = defineDoc<{ steps: string[] }>({
  kind: "sumire.progress",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ steps: [] }),
})

/** Isolated experiment. Never imported by production startup. */
export class DurablePrototype {
  private constructor(
    readonly harness: Harness,
    readonly directory: string,
    private readonly maxRecords: number,
    private readonly maxBytes: number,
  ) {}

  static async open(
    directory: string,
    models: Models,
    registry: Registry,
    limits = { records: 10, bytes: 4096 },
  ) {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const storage = await openNodeSqliteStorage(path.join(directory, "session.sqlite"))
    try {
      const harness = await Harness.open(
        storage,
        {
          models,
          registry,
          settings: { compaction: { enabled: false } },
          conversationCreated: async (tx, conversation) => {
            await tx.doc(Progress, conversation.id)
          },
        },
        context,
      )
      const runtime = new DurablePrototype(harness, directory, limits.records, limits.bytes)
      const root = await harness.root(context, {
        agent: { model: { provider: "faux", modelId: "faux-1" } },
      })
      await harness.commit(async (tx) => {
        const routing = await tx.doc(Routing)
        if (routing.active === null) routing.active = root.id
      }, context)
      return runtime
    } catch (error) {
      await storage.close(context)
      throw error
    }
  }

  async conversation(): Promise<Conversation> {
    const route = await this.harness.snapshot(Routing, context)
    const conversation =
      route?.active === undefined || route.active === null
        ? undefined
        : await this.harness.conversation(route.active, context)
    if (!conversation) throw new Error("Missing active conversation")
    return conversation
  }

  async submit(
    requestId: string,
    content: UserInput,
    whenBusy: "steer" | "followUp" | "reject" = "followUp",
  ): Promise<Submission> {
    return (await this.conversation()).submit(
      { type: "input", content, requestId, whenBusy },
      context,
    )
  }

  async passive(text: string): Promise<Submission> {
    return (await this.conversation()).submit(
      {
        type: "write",
        entry: {
          kind: "sumire.passive",
          model: [
            { role: "user", content: `[Untrusted group context]\n${text}`, timestamp: Date.now() },
          ],
        },
      },
      context,
    )
  }

  async answer(record: SettledSubmissionRecord): Promise<string | undefined> {
    if (record.status !== "done" || record.type !== "input") return undefined
    return this.harness.commit(async (tx) => {
      const entry = await tx.entry(AssistantEntry, record.answer)
      const message = entry?.model?.[0]
      return message?.role === "assistant"
        ? message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n")
        : undefined
    }, context)
  }

  async recordReply(record: SettledSubmissionRecord, ids: number[]): Promise<void> {
    if (record.status !== "done" || record.type !== "input") throw new Error("No answer checkpoint")
    const valid = [...new Set(ids)].filter((id) => Number.isSafeInteger(id) && id > 0)
    if (!valid.length) return
    await this.harness.commit(async (tx) => {
      const route = await tx.doc(Routing)
      route.replies = route.replies.filter((reply) => !reply.ids.some((id) => valid.includes(id)))
      route.replies.push({
        ids: valid,
        conversationId: record.conversationId,
        entryId: record.answer,
      })
      while (route.replies.length > this.maxRecords) route.replies.shift()
      while (
        Buffer.byteLength(JSON.stringify(route.replies)) > this.maxBytes &&
        route.replies.length > 1
      )
        route.replies.shift()
      if (Buffer.byteLength(JSON.stringify(route.replies)) > this.maxBytes)
        throw new Error("Reply limit exceeded")
    }, context)
  }

  async forkReply(id: number): Promise<boolean> {
    const route = await this.harness.snapshot(Routing, context)
    const reply = route?.replies.find((item) => item.ids.includes(id))
    if (!reply) return false
    const active = await this.conversation()
    await active.waitForIdle(context)
    const recent = []
    for (const entry of [...(await active.context(context)).entries].reverse()) {
      if (entry.kind === "pi.user" || entry.kind === "pi.assistant") break
      if (entry.kind === "sumire.passive") recent.unshift(entry)
    }
    const source = await this.harness.conversation(reply.conversationId, context)
    if (!source) return false
    const fork = await source.fork(reply.entryId, { ownership: { kind: "ownerless" } }, context)
    for (const entry of recent) {
      await (
        await fork.submit(
          { type: "write", entry: { kind: entry.kind, model: entry.model } },
          context,
        )
      ).wait(context)
    }
    await this.harness.commit(async (tx) => {
      ;(await tx.doc(Routing)).active = fork.id
    }, context)
    return true
  }

  async cancel(): Promise<void> {
    await (await this.conversation()).abort(context)
  }

  async close(): Promise<void> {
    await this.harness.close(context)
  }

  async reset(): Promise<void> {
    await this.cancel()
    await this.close()
    await rm(this.directory, { recursive: true, force: true })
  }
}
