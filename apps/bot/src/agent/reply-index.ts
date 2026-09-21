import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"

import type { Logger } from "../logging.js"

interface ReplyRecord {
  telegramMessageIds: number[]
  piSessionId: string
  piEntryId: string
  createdAt: number
}

interface ReplyIndexSnapshot {
  version: 1
  records: ReplyRecord[]
}

export interface PiReplyCheckpoint {
  sessionId: string
  entryId: string
}

export class TelegramReplyIndex {
  readonly #cache = new Map<number, ReplyRecord[]>()
  readonly #writeTails = new Map<number, Promise<void>>()

  constructor(
    private readonly sessionRoot: string,
    private readonly maxRecords: number,
    private readonly maxBytes: number,
    private readonly logger: Logger,
  ) {}

  async resolve(chatId: number, telegramMessageId: number): Promise<PiReplyCheckpoint | undefined> {
    await this.#writeTails.get(chatId)?.catch(() => undefined)
    const records = await this.#load(chatId)
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index]
      if (record?.telegramMessageIds.includes(telegramMessageId)) {
        return { sessionId: record.piSessionId, entryId: record.piEntryId }
      }
    }
    return undefined
  }

  async record(
    chatId: number,
    telegramMessageIds: readonly number[],
    checkpoint: PiReplyCheckpoint,
    createdAt = Date.now(),
  ): Promise<void> {
    const previous = this.#writeTails.get(chatId) ?? Promise.resolve()
    const write = previous
      .catch(() => undefined)
      .then(() => this.#record(chatId, telegramMessageIds, checkpoint, createdAt))
    this.#writeTails.set(chatId, write)
    try {
      await write
    } finally {
      if (this.#writeTails.get(chatId) === write) this.#writeTails.delete(chatId)
    }
  }

  async #record(
    chatId: number,
    telegramMessageIds: readonly number[],
    checkpoint: PiReplyCheckpoint,
    createdAt: number,
  ): Promise<void> {
    const ids = [...new Set(telegramMessageIds)].filter(
      (messageId) => Number.isSafeInteger(messageId) && messageId > 0,
    )
    if (ids.length === 0) return
    const existing = await this.#load(chatId)
    const idSet = new Set(ids)
    const records = existing.filter(
      (record) => !record.telegramMessageIds.some((messageId) => idSet.has(messageId)),
    )
    records.push({
      telegramMessageIds: ids,
      piSessionId: checkpoint.sessionId,
      piEntryId: checkpoint.entryId,
      createdAt,
    })
    while (records.length > this.maxRecords) records.shift()

    let serialized = serialize(records)
    while (Buffer.byteLength(serialized) > this.maxBytes && records.length > 1) {
      records.shift()
      serialized = serialize(records)
    }
    if (Buffer.byteLength(serialized) > this.maxBytes) {
      throw new Error("Telegram reply index record exceeds the configured byte limit")
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
    this.#cache.set(chatId, records)
  }

  async clear(chatId: number): Promise<void> {
    await this.#writeTails.get(chatId)?.catch(() => undefined)
    this.#cache.delete(chatId)
    this.#writeTails.delete(chatId)
    await rm(this.#file(chatId), { force: true })
  }

  async #load(chatId: number): Promise<ReplyRecord[]> {
    const cached = this.#cache.get(chatId)
    if (cached) return [...cached]
    const file = this.#file(chatId)
    try {
      const fileStat = await stat(file)
      if (fileStat.size > this.maxBytes)
        throw new Error("reply index exceeds configured byte limit")
      const parsed: unknown = JSON.parse(await readFile(file, "utf8"))
      const records = parseSnapshot(parsed).slice(-this.maxRecords)
      this.#cache.set(chatId, records)
      return [...records]
    } catch (error) {
      if (isMissingFile(error)) {
        this.#cache.set(chatId, [])
        return []
      }
      this.logger.warn(`Ignoring invalid Telegram reply index for chat_id=${chatId}`, error)
      this.#cache.set(chatId, [])
      return []
    }
  }

  #file(chatId: number): string {
    return path.join(this.sessionRoot, String(chatId), "telegram-reply-index.json")
  }
}

function serialize(records: ReplyRecord[]): string {
  return `${JSON.stringify({ version: 1, records } satisfies ReplyIndexSnapshot)}\n`
}

function parseSnapshot(value: unknown): ReplyRecord[] {
  if (!value || typeof value !== "object") throw new Error("reply index must be an object")
  const snapshot = value as { version?: unknown; records?: unknown }
  if (snapshot.version !== 1) throw new Error("reply index version is unsupported")
  if (!Array.isArray(snapshot.records)) throw new Error("reply index records must be an array")
  return snapshot.records.map(parseRecord)
}

function parseRecord(value: unknown): ReplyRecord {
  if (!value || typeof value !== "object") throw new Error("reply index record must be an object")
  const record = value as Partial<ReplyRecord>
  const createdAt = record.createdAt
  if (
    !Array.isArray(record.telegramMessageIds) ||
    record.telegramMessageIds.length === 0 ||
    record.telegramMessageIds.some(
      (messageId) => !Number.isSafeInteger(messageId) || messageId <= 0,
    ) ||
    typeof record.piSessionId !== "string" ||
    record.piSessionId.length === 0 ||
    record.piSessionId.length > 200 ||
    typeof record.piEntryId !== "string" ||
    record.piEntryId.length === 0 ||
    record.piEntryId.length > 200 ||
    typeof createdAt !== "number" ||
    !Number.isSafeInteger(createdAt) ||
    createdAt < 0
  ) {
    throw new Error("reply index record is invalid")
  }
  return {
    telegramMessageIds: [...record.telegramMessageIds],
    piSessionId: record.piSessionId,
    piEntryId: record.piEntryId,
    createdAt,
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
