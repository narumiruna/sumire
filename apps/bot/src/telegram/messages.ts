export interface TelegramActor {
  id?: number
  username?: string
  first_name?: string
  last_name?: string
  title?: string
  is_bot?: boolean
}

export interface TelegramMessageLike {
  message_id: number
  date?: number
  text?: string
  caption?: string
  caption_entities?: Array<{ type: string; offset: number; length: number }>
  from?: TelegramActor
  sender_chat?: TelegramActor
  photo?: Array<{ file_id: string; file_size?: number; width: number; height: number }>
  document?: { file_id: string; file_name?: string; file_size?: number; mime_type?: string }
  video?: unknown
  sticker?: unknown
  voice?: unknown
  audio?: unknown
  animation?: unknown
  video_note?: unknown
  reply_to_message?: TelegramMessageLike
}

export const defaultImagePrompt = "請閱讀這張圖片，描述重點並回答使用者可能想知道的內容。"

export function messageText(message: TelegramMessageLike): string {
  return message.text || message.caption || ""
}

export function isBotAddressed(
  message: TelegramMessageLike,
  botId: number,
  botUsername: string,
): boolean {
  const repliedToBot = message.reply_to_message?.from?.id === botId
  const mention = new RegExp(`@${escapeRegExp(botUsername)}\\b`, "iu").test(messageText(message))
  return repliedToBot || mention
}

export function stripBotMention(text: string, botUsername: string): string {
  return text.replace(new RegExp(`@${escapeRegExp(botUsername)}\\b`, "giu"), "").trim()
}

export function captionCommandArguments(
  message: TelegramMessageLike,
  command: string,
  botUsername: string,
): string | undefined {
  const caption = message.caption
  const entity = message.caption_entities?.find(
    (candidate) => candidate.type === "bot_command" && candidate.offset === 0,
  )
  if (!caption || !entity) return undefined

  const commandText = caption.slice(1, entity.length)
  const separator = commandText.indexOf("@")
  const name = separator === -1 ? commandText : commandText.slice(0, separator)
  const target = separator === -1 ? undefined : commandText.slice(separator + 1)
  if (
    name !== command ||
    (target !== undefined && target.toLowerCase() !== botUsername.toLowerCase())
  ) {
    return undefined
  }
  return caption.slice(entity.length).trim()
}

export function passiveGroupContext(message: TelegramMessageLike): string {
  const text = messageText(message).trim()
  const image = selectImageReference(message)
  const parts = [text, image ? `[圖片: ${image.filename}; 未讀取圖片內容]` : ""].filter(Boolean)
  return parts.length > 0
    ? `[群組旁聽訊息 from ${actorName(message.sender_chat ?? message.from)}] ${parts.join("\n")}`
    : ""
}

export function promptWithReplyContext(
  message: TelegramMessageLike,
  currentText: string,
  includeBotReply = false,
): string {
  const replied = message.reply_to_message
  if (!replied || (replied.from?.is_bot && !includeBotReply)) return currentText
  const type = messageContentType(replied)
  const lines = [
    "Replied message context:",
    `Sender: ${actorName(replied.from ?? replied.sender_chat)}`,
    `Type: ${type}`,
    `Message ID: ${replied.message_id}`,
  ]
  if (replied.date !== undefined)
    lines.push(`Date: ${new Date(replied.date * 1_000).toISOString()}`)
  lines.push(
    `Content: ${messageContent(replied, type)}`,
    "",
    "Current user message:",
    currentText.trim() || "（使用者只提及 bot，未提供額外文字。）",
    "",
    "Important instruction for the assistant:",
    "Treat the replied message as the primary object the user wants you to address. If no explicit instruction was provided, respond directly with a useful interpretation or summary instead of asking what to do.",
  )
  return lines.join("\n")
}

export interface ImageReference {
  fileId: string
  filename: string
  mediaType: string
  fileSize?: number
}

export interface DocumentReference {
  fileId: string
  filename: string
  mediaType: string
  source: "current" | "replied"
  fileSize?: number
}

export function repliedBotMessageId(
  message: TelegramMessageLike,
  botId: number,
): number | undefined {
  const replied = message.reply_to_message
  return replied?.from?.id === botId ? replied.message_id : undefined
}

export function documentReferences(message: TelegramMessageLike): DocumentReference[] {
  const references: DocumentReference[] = []
  const seen = new Set<string>()
  add(message, "current")
  if (message.reply_to_message) add(message.reply_to_message, "replied")
  return references

  function add(candidate: TelegramMessageLike, source: DocumentReference["source"]): void {
    const document = candidate.document
    if (
      !document ||
      document.mime_type?.toLowerCase().startsWith("image/") ||
      seen.has(document.file_id)
    ) {
      return
    }
    seen.add(document.file_id)
    references.push({
      fileId: document.file_id,
      filename: sanitizeDocumentFilename(document.file_name),
      mediaType: sanitizeMediaType(document.mime_type),
      source,
      ...(document.file_size !== undefined ? { fileSize: document.file_size } : {}),
    })
  }
}

export function imageReferences(message: TelegramMessageLike): ImageReference[] {
  const references: ImageReference[] = []
  const current = selectImageReference(message)
  if (current) references.push(current)
  const replied = message.reply_to_message
    ? selectImageReference(message.reply_to_message)
    : undefined
  if (replied) references.push({ ...replied, filename: `replied-${replied.filename}` })
  return references
}

function selectImageReference(message: TelegramMessageLike): ImageReference | undefined {
  if (message.photo && message.photo.length > 0) {
    const largest = [...message.photo].sort((left, right) => {
      const areaDifference = right.width * right.height - left.width * left.height
      return areaDifference || (right.file_size ?? 0) - (left.file_size ?? 0)
    })[0]
    if (largest) {
      return {
        fileId: largest.file_id,
        filename: "telegram-photo.jpg",
        mediaType: "image/jpeg",
        ...(largest.file_size !== undefined ? { fileSize: largest.file_size } : {}),
      }
    }
  }

  const document = message.document
  if (document?.mime_type?.startsWith("image/")) {
    return {
      fileId: document.file_id,
      filename: document.file_name || "telegram-image",
      mediaType: document.mime_type,
      ...(document.file_size !== undefined ? { fileSize: document.file_size } : {}),
    }
  }
  return undefined
}

function actorName(actor: TelegramActor | undefined): string {
  if (!actor) return "unknown"
  if (actor.username) return `@${actor.username}`
  const fullName = [actor.first_name, actor.last_name].filter(Boolean).join(" ")
  if (fullName) return fullName
  if (actor.title) return actor.title
  return actor.id === undefined ? "unknown" : `user_id=${actor.id}`
}

function messageContentType(message: TelegramMessageLike): string {
  if (message.text) return "text"
  for (const type of [
    "photo",
    "video",
    "document",
    "sticker",
    "voice",
    "audio",
    "animation",
    "video_note",
  ] as const) {
    if (message[type] !== undefined) return type
  }
  return message.caption ? "caption" : "unknown"
}

function messageContent(message: TelegramMessageLike, type: string): string {
  if (message.text) return message.text
  if (message.caption)
    return type === "caption"
      ? message.caption
      : `使用者回覆的是一則 ${type} 訊息，caption: ${message.caption}`
  return type === "unknown"
    ? "無法取得被回覆訊息內容"
    : `使用者回覆的是一則 ${type} 訊息，無文字內容`
}

function sanitizeDocumentFilename(value: string | undefined): string {
  const sanitized = (value || "telegram-document")
    .replace(/[\p{Cc}/\\<>]+/gu, "_")
    .replace(/\s+/g, " ")
    .trim()
  return (sanitized || "telegram-document").slice(0, 200)
}

function sanitizeMediaType(value: string | undefined): string {
  const normalized = (value || "application/octet-stream").trim().toLowerCase()
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(normalized)
    ? normalized.slice(0, 100)
    : "application/octet-stream"
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
