import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"

import type { Logger } from "../logging.js"
import type { ImageReference } from "./messages.js"

const maxRecords = 100
const maxIndexBytes = 256_000

export interface ChannelImageRecord {
  channelChatId: number
  messageId: number
  date: number
  caption: string
  image: ImageReference
}

export class ChannelImageIndex {
  readonly #writes = new Map<number, Promise<void>>()

  constructor(
    private readonly sessionRoot: string,
    private readonly logger: Logger,
  ) {}

  async record(record: ChannelImageRecord): Promise<void> {
    if (!validChannelId(record.channelChatId) || !validMessageId(record.messageId)) return
    const chatId = record.channelChatId
    const safeRecord = parseRecord({ ...record, caption: record.caption.slice(0, 500) }, chatId)
    const previous = this.#writes.get(chatId) ?? Promise.resolve()
    const write = previous
      .catch(() => undefined)
      .then(async () => {
        const records = (await this.#load(chatId)).filter(
          (existing) => existing.messageId !== record.messageId,
        )
        records.push(safeRecord)
        records.sort((a, b) => a.messageId - b.messageId)
        while (records.length > maxRecords) records.shift()
        const serialized = `${JSON.stringify({ version: 1, records })}\n`
        if (Buffer.byteLength(serialized) > maxIndexBytes) {
          throw new Error("Channel image index exceeds its byte limit")
        }
        const file = this.#file(chatId)
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
        const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`
        try {
          await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 })
          await rename(temporary, file)
        } finally {
          await rm(temporary, { force: true })
        }
      })
    this.#writes.set(chatId, write)
    try {
      await write
    } finally {
      if (this.#writes.get(chatId) === write) this.#writes.delete(chatId)
    }
  }

  async find(channelChatId: number, messageId: number): Promise<ChannelImageRecord | undefined> {
    if (!validChannelId(channelChatId) || !validMessageId(messageId)) return undefined
    await this.#writes.get(channelChatId)?.catch(() => undefined)
    return (await this.#load(channelChatId)).find((record) => record.messageId === messageId)
  }

  async recent(allowedChatIds: ReadonlySet<number>): Promise<ChannelImageRecord[]> {
    const records = await Promise.all(
      [...allowedChatIds].filter(validChannelId).map(async (chatId) => {
        await this.#writes.get(chatId)?.catch(() => undefined)
        return this.#load(chatId)
      }),
    )
    return records
      .flat()
      .sort((a, b) => b.date - a.date || b.messageId - a.messageId)
      .slice(0, 10)
  }

  async #load(chatId: number): Promise<ChannelImageRecord[]> {
    try {
      const file = this.#file(chatId)
      if ((await stat(file)).size > maxIndexBytes) throw new Error("Channel image index too large")
      const value: unknown = JSON.parse(await readFile(file, "utf8"))
      if (!value || typeof value !== "object") throw new Error("Invalid channel image index")
      const snapshot = value as { version?: unknown; records?: unknown }
      if (snapshot.version !== 1 || !Array.isArray(snapshot.records)) {
        throw new Error("Invalid channel image index")
      }
      return snapshot.records.slice(-maxRecords).map((item: unknown) => parseRecord(item, chatId))
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return []
      this.logger.warn(`Ignoring invalid channel image index for chat_id=${chatId}`, error)
      return []
    }
  }

  #file(chatId: number): string {
    return path.join(this.sessionRoot, "channel-images", `${chatId}.json`)
  }
}

function validChannelId(id: number): boolean {
  return Number.isSafeInteger(id) && id < 0
}

function validMessageId(id: number): boolean {
  return Number.isSafeInteger(id) && id > 0
}

function parseRecord(value: unknown, chatId: number): ChannelImageRecord {
  if (!value || typeof value !== "object") throw new Error("Invalid channel image record")
  const record = value as Partial<ChannelImageRecord>
  const image = record.image
  if (
    record.channelChatId !== chatId ||
    !validMessageId(record.messageId ?? 0) ||
    !Number.isSafeInteger(record.date) ||
    (record.date ?? -1) < 0 ||
    typeof record.caption !== "string" ||
    record.caption.length > 500 ||
    !image ||
    typeof image.fileId !== "string" ||
    image.fileId.length === 0 ||
    image.fileId.length > 512 ||
    typeof image.filename !== "string" ||
    image.filename.length > 200 ||
    typeof image.mediaType !== "string" ||
    !/^image\/[a-z0-9.+-]{1,80}$/u.test(image.mediaType) ||
    (image.fileSize !== undefined && (!Number.isSafeInteger(image.fileSize) || image.fileSize < 0))
  ) {
    throw new Error("Invalid channel image record")
  }
  return record as ChannelImageRecord
}
