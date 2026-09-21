import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { beforeEach, describe, expect, it, vi } from "vitest"

import { TelegramReplyIndex } from "../src/agent/reply-index.js"
import type { Logger } from "../src/logging.js"

let root: string
const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "sumire-reply-index-"))
  vi.clearAllMocks()
})

describe("TelegramReplyIndex", () => {
  it("persists aliases, survives reload, replaces duplicates, and isolates chats", async () => {
    const index = new TelegramReplyIndex(root, 10, 10_000, logger)
    await index.record(1, [100, 101], { sessionId: "session-1", entryId: "entry-1" }, 1)
    await index.record(2, [100], { sessionId: "session-2", entryId: "entry-2" }, 2)
    await index.record(1, [101], { sessionId: "session-1", entryId: "entry-new" }, 3)

    const reloaded = new TelegramReplyIndex(root, 10, 10_000, logger)
    await expect(reloaded.resolve(1, 100)).resolves.toBeUndefined()
    await expect(reloaded.resolve(1, 101)).resolves.toEqual({
      sessionId: "session-1",
      entryId: "entry-new",
    })
    await expect(reloaded.resolve(2, 100)).resolves.toEqual({
      sessionId: "session-2",
      entryId: "entry-2",
    })
    expect(await readFile(path.join(root, "1", "telegram-reply-index.json"), "utf8")).not.toContain(
      "message text",
    )
  })

  it("evicts the oldest records deterministically by count and bytes", async () => {
    const byCount = new TelegramReplyIndex(root, 2, 10_000, logger)
    await byCount.record(1, [1], { sessionId: "s", entryId: "one" }, 1)
    await byCount.record(1, [2], { sessionId: "s", entryId: "two" }, 2)
    await byCount.record(1, [3], { sessionId: "s", entryId: "three" }, 3)
    await expect(byCount.resolve(1, 1)).resolves.toBeUndefined()
    await expect(byCount.resolve(1, 2)).resolves.toMatchObject({ entryId: "two" })

    const byBytes = new TelegramReplyIndex(root, 10, 170, logger)
    await byBytes.clear(2)
    await byBytes.record(2, [1], { sessionId: "s", entryId: "a".repeat(30) }, 1)
    await byBytes.record(2, [2], { sessionId: "s", entryId: "b".repeat(30) }, 2)
    await expect(byBytes.resolve(2, 1)).resolves.toBeUndefined()
    await expect(byBytes.resolve(2, 2)).resolves.toMatchObject({ entryId: "b".repeat(30) })
  })

  it("rejects one record larger than the configured snapshot limit", async () => {
    const index = new TelegramReplyIndex(root, 10, 100, logger)
    await expect(
      index.record(1, [1], { sessionId: "s".repeat(100), entryId: "entry" }),
    ).rejects.toThrow("byte limit")
  })

  it("ignores malformed, oversized, unknown-version, and interrupted temporary snapshots", async () => {
    const directory = path.join(root, "1")
    await mkdir(directory, { recursive: true })
    const file = path.join(directory, "telegram-reply-index.json")
    for (const content of ["not json", '{"version":2,"records":[]}', "x".repeat(501)]) {
      await writeFile(file, content)
      const index = new TelegramReplyIndex(root, 10, 500, logger)
      await expect(index.resolve(1, 1)).resolves.toBeUndefined()
    }

    const valid = new TelegramReplyIndex(root, 10, 10_000, logger)
    await valid.record(1, [10], { sessionId: "session", entryId: "entry" })
    await writeFile(`${file}.tmp-interrupted`, "partial")
    const reloaded = new TelegramReplyIndex(root, 10, 10_000, logger)
    await expect(reloaded.resolve(1, 10)).resolves.toEqual({
      sessionId: "session",
      entryId: "entry",
    })
    expect(logger.warn).toHaveBeenCalled()
  })

  it.each([false, true])(
    "resolves behind all pending writes with a warm cache=%s",
    async (warmCache) => {
      const index = new TelegramReplyIndex(root, 10, 10_000, logger)
      if (warmCache) await index.resolve(1, 1)
      const writes = Promise.all([
        index.record(1, [1], { sessionId: "s", entryId: "one" }, 1),
        index.record(1, [2], { sessionId: "s", entryId: "two" }, 2),
      ])
      const lookup = expect(index.resolve(1, 2)).resolves.toEqual({
        sessionId: "s",
        entryId: "two",
      })
      await Promise.all([writes, lookup])
      await expect(index.resolve(1, 1)).resolves.toMatchObject({ entryId: "one" })
    },
  )

  it("keeps lookups usable after a pending write fails", async () => {
    const index = new TelegramReplyIndex(root, 10, 200, logger)
    await index.record(1, [1], { sessionId: "s", entryId: "one" })
    const failedWrite = expect(
      index.record(1, [2], { sessionId: "s".repeat(500), entryId: "oversized" }),
    ).rejects.toThrow("byte limit")
    await expect(index.resolve(1, 1)).resolves.toEqual({ sessionId: "s", entryId: "one" })
    await failedWrite
    await expect(index.resolve(1, 2)).resolves.toBeUndefined()
    await index.record(1, [3], { sessionId: "s", entryId: "three" })
    await expect(index.resolve(1, 3)).resolves.toMatchObject({ entryId: "three" })
  })

  it("serializes concurrent writes without losing records and clears state", async () => {
    const index = new TelegramReplyIndex(root, 10, 10_000, logger)
    await Promise.all([
      index.record(1, [1], { sessionId: "s", entryId: "one" }, 1),
      index.record(1, [2], { sessionId: "s", entryId: "two" }, 2),
    ])
    await expect(index.resolve(1, 1)).resolves.toMatchObject({ entryId: "one" })
    await expect(index.resolve(1, 2)).resolves.toMatchObject({ entryId: "two" })
    await index.clear(1)
    await expect(index.resolve(1, 1)).resolves.toBeUndefined()
  })
})
