import type { EntryRecord } from "@earendil-works/pi-durable"
import type {
  DurableEntryContentBlock,
  DurableEntryItem,
  DurableEntryMessage,
} from "@narumitw/sumire-contracts"

const maxContentBytes = 128 * 1024
const maxTextBytes = 16 * 1024
const maxBlocks = 256

/** Project model-facing content only. Never expose entry data, details, signatures, or image bytes. */
export function entryContent(
  model: EntryRecord["model"],
): NonNullable<DurableEntryItem["content"]> {
  const result: NonNullable<DurableEntryItem["content"]> = { messages: [], truncated: false }
  let bytes = Buffer.byteLength(JSON.stringify(result))
  let blocks = 0
  const text = (value: unknown, limit = maxTextBytes): string => {
    if (typeof value !== "string") throw new Error("Invalid entry content")
    if (Buffer.byteLength(value) <= limit) return value
    result.truncated = true
    // Stream decoding drops an incomplete UTF-8 suffix instead of returning a broken character.
    return new TextDecoder().decode(Buffer.from(value).subarray(0, limit), { stream: true })
  }
  for (const message of model ?? []) {
    if (blocks >= maxBlocks || result.messages.length >= maxBlocks) {
      result.truncated = true
      break
    }
    if (
      message.role !== "system" &&
      message.role !== "user" &&
      message.role !== "assistant" &&
      message.role !== "toolResult"
    )
      throw new Error("Invalid entry role")
    const projected: DurableEntryMessage = { role: message.role, content: [] }
    if (message.role === "toolResult") {
      projected.toolName = text(message.toolName, 1024)
      projected.toolCallId = text(message.toolCallId, 1024)
      if (typeof message.isError !== "boolean") throw new Error("Invalid entry result status")
      projected.isError = message.isError
    }
    const headerBytes = Buffer.byteLength(JSON.stringify(projected)) + 1
    if (bytes + headerBytes > maxContentBytes) {
      result.truncated = true
      break
    }
    bytes += headerBytes
    result.messages.push(projected)
    const content =
      typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : message.content
    for (const block of content) {
      if (blocks >= maxBlocks) {
        result.truncated = true
        break
      }
      let item: DurableEntryContentBlock
      switch (block.type) {
        case "text":
          item = { type: "text", text: text(block.text) }
          break
        case "thinking":
          item = { type: "thinking", thinking: text(block.thinking) }
          break
        case "image":
          item = { type: "image", mimeType: text(block.mimeType, 1024) }
          break
        case "toolCall":
          item = {
            type: "toolCall",
            id: text(block.id, 1024),
            name: text(block.name, 1024),
            arguments: text(JSON.stringify(block.arguments)),
          }
          break
        default:
          result.truncated = true
          continue
      }
      const itemBytes = Buffer.byteLength(JSON.stringify(item)) + 1
      if (bytes + itemBytes > maxContentBytes) {
        result.truncated = true
        // Stop at the first omitted block. The response remains an ordered prefix.
        return result
      }
      bytes += itemBytes
      blocks++
      projected.content.push(item)
    }
  }
  return result
}
