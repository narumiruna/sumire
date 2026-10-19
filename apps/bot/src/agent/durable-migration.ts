import type { Context, JsonValue } from "@earendil-works/chord"
import type { AgentToolCallOutcome } from "@earendil-works/pi-agent-core"
import {
  type Conversation,
  type ConversationId,
  type Cursor,
  defineDoc,
  defineTask,
  type EntryId,
  type Harness,
} from "@earendil-works/pi-durable"
import { CodemodeStoreDoc as NativeCodemodeStoreDoc } from "@earendil-works/pi-durable/codemode"
import { CodemodeStoreDoc as LegacyCodemodeStoreDoc } from "./durable-state.js"

export const CodemodeMigrationDoc = defineDoc<{ migrated: boolean }>({
  kind: "sumire.codemode-migration",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ migrated: false }),
})

/** Run before resume, submissions, or waits, with no other storage writer. */
export async function migrateCodemodeStores(harness: Harness, context: Context): Promise<void> {
  if ((await harness.inspect(context)).scheduling !== "paused")
    throw new Error("Codemode migration requires a paused Harness")

  const conversations: ConversationId[] = []
  let cursor: Cursor | undefined
  do {
    const page = await harness.commit((tx) => tx.scanConversations({}, 100, cursor), context)
    conversations.push(...page.items.map((conversation) => conversation.id))
    cursor = page.next
  } while (cursor !== undefined)

  for (const id of conversations) {
    if ((await harness.snapshot(CodemodeMigrationDoc, id, context))?.migrated) continue
    const native = await harness.snapshot(NativeCodemodeStoreDoc, id, context)
    const legacy =
      native === undefined ? await harness.snapshot(LegacyCodemodeStoreDoc, id, context) : undefined
    // Tx has no non-creating document read. Read while scheduling is paused, then
    // commit the copy and its marker together. Never change legacy history.
    await harness.commit(async (tx) => {
      if (native === undefined) {
        const store = await tx.doc(NativeCodemodeStoreDoc, id)
        store.values = structuredClone(legacy?.values ?? {})
      }
      const marker = await tx.doc(CodemodeMigrationDoc, id)
      marker.migrated = true
    }, context)
  }
}

/** Restore legacy values only when the native document is absent at the selected entry. */
export async function forkCodemodeConversation(
  harness: Harness,
  source: Conversation,
  at: EntryId,
  context: Context,
): Promise<Conversation> {
  const native = await harness.snapshotAsOf(NativeCodemodeStoreDoc, source.id, at, context)
  if (native !== undefined) return source.fork(at, { ownership: { kind: "ownerless" } }, context)
  const legacy = await harness.snapshotAsOf(LegacyCodemodeStoreDoc, source.id, at, context)
  return source.fork(
    at,
    {
      ownership: { kind: "ownerless" },
      init: async (tx, id) => {
        const store = await tx.doc(NativeCodemodeStoreDoc, id)
        store.values = structuredClone(legacy?.values ?? {})
        const marker = await tx.doc(CodemodeMigrationDoc, id)
        marker.migrated = true
      },
    },
    context,
  )
}

type LegacyCallInput = {
  name: string
  generation?: string
  args: JsonValue
  callId: string
  parentCallId: string
}
type LegacyCallPhase = { phase: "call" } | { phase: "interrupted" }
type LegacyCallResult = {
  content: AgentToolCallOutcome["result"]["content"]
  details?: JsonValue
  structuredContent?: JsonValue
  isError?: boolean
}
const failed = (text: string): LegacyCallResult => ({
  content: [{ type: "text", text }],
  isError: true,
})

/** Keep installed until every persisted v1 nested call has settled. No effects run. */
export const LegacyCodemodeCallTask = defineTask<
  LegacyCallInput,
  LegacyCallPhase,
  LegacyCallResult
>({
  name: "sumire.codemode-call",
  version: 1,
  initial: () => ({ phase: "call" }),
  phases: {
    async call(_task, runtime, context) {
      await runtime.commit(
        () => ({
          status: "terminal",
          outcome: {
            status: "completed",
            result: failed(
              "Legacy nested tool was not executed; inspect side effects before retrying.",
            ),
          },
        }),
        context,
      )
    },
    async interrupted(_task, runtime, context) {
      await runtime.commit(
        () => ({
          status: "terminal",
          outcome: {
            status: "completed",
            result: failed("Nested tool was interrupted; inspect side effects before retrying."),
          },
        }),
        context,
      )
    },
  },
  async abort(_task, runtime, context) {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context)
  },
})
