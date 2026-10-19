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
