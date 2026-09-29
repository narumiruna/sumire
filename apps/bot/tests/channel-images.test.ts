import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import type { Logger } from "../src/logging.js"
import { ChannelImageIndex, type ChannelImageRecord } from "../src/telegram/channel-images.js"

const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

function post(messageId: number, channelChatId = -100): ChannelImageRecord {
  return {
    channelChatId,
    messageId,
    date: 1_700_000_000 + messageId,
    caption: `post ${messageId}`,
    image: {
      fileId: `image-${messageId}`,
      filename: "telegram-photo.jpg",
      mediaType: "image/jpeg",
    },
  }
}

describe("channel image index", () => {
  it("persists bounded image metadata, serializes concurrent posts, and survives restart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "channel-index-"))
    const index = new ChannelImageIndex(root, logger)
    await Promise.all(Array.from({ length: 120 }, (_, n) => index.record(post(n + 1))))
    await index.record({ ...post(120), caption: "updated" })
    const reloaded = new ChannelImageIndex(root, logger)
    expect(await reloaded.find(-100, 1)).toBeUndefined()
    expect(await reloaded.find(-100, 21)).toEqual(post(21))
    expect(await reloaded.find(-100, 120)).toMatchObject({ caption: "updated" })
    expect((await reloaded.recent(new Set([-100]))).map((entry) => entry.messageId)).toEqual(
      Array.from({ length: 10 }, (_, n) => 120 - n),
    )
    expect(await reloaded.recent(new Set([7, -101]))).toEqual([])
    const file = path.join(root, "channel-images/-100.json")
    expect(JSON.parse(await readFile(file, "utf8")).records).toHaveLength(100)
  })

  it("truncates long image-document filenames instead of discarding the post", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "channel-long-filename-"))
    const index = new ChannelImageIndex(root, logger)
    const original = post(3)
    await index.record({
      ...original,
      image: { ...original.image, filename: `${"a".repeat(240)}.png` },
    })
    expect(await new ChannelImageIndex(root, logger).find(-100, 3)).toMatchObject({
      image: { fileId: "image-3", filename: "a".repeat(200) },
    })
  })

  it("refuses invalid or foreign records, and fails closed for corrupt stored data", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "channel-invalid-"))
    const index = new ChannelImageIndex(root, logger)
    await index.record(post(1, 7))
    await index.record(post(-1))
    expect(await index.recent(new Set([-100, 7]))).toEqual([])
    await mkdir(path.join(root, "channel-images"))
    await writeFile(
      path.join(root, "channel-images/-100.json"),
      JSON.stringify({ version: 1, records: [{ ...post(2), channelChatId: -101 }] }),
    )
    expect(await index.find(-100, 2)).toBeUndefined()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Ignoring invalid channel image index"),
      expect.anything(),
    )
  })
})
