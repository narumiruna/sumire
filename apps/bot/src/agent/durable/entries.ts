import type { ConversationId, EntryId, EntryRecord } from "@earendil-works/pi-durable"

export function checkpointId(entry: EntryRecord): string {
  return `${entry.conversationId}:${entry.id}`
}

export function parseCheckpoint(
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

export function checkpointAttributes(checkpoint: {
  sessionId: string
  entryId: string
  requestId?: string
}) {
  const target = parseCheckpoint(checkpoint.entryId)
  return {
    "pi.session_id": checkpoint.sessionId,
    "pi.entry_id": checkpoint.entryId,
    ...(target ? { "pi.conversation_id": target.conversationId } : {}),
    ...(checkpoint.requestId ? { "pi.request_id": checkpoint.requestId } : {}),
  }
}

export function assistantText(entry: EntryRecord | undefined): string {
  const message = entry?.model?.find((message) => message.role === "assistant")
  return message?.role === "assistant"
    ? message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim()
    : ""
}
