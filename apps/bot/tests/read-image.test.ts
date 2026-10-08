import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent"
import type { Api } from "grammy"
import { describe, expect, it, vi } from "vitest"

import { createReadImageExtension } from "../src/agent/read-image.js"
import { loadSettings, type Settings } from "../src/config/settings.js"
import type { Logger } from "../src/logging.js"
import { ChannelImageIndex } from "../src/telegram/channel-images.js"

const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

async function setup(overrides: Partial<Settings> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "read-image-"))
  const settings = {
    ...loadSettings({ BOT_TOKEN: "test-token", BOT_WHITELIST: "7,-100" }, root),
    ...overrides,
  }
  const index = new ChannelImageIndex(root, logger)
  for (const channelChatId of [-100, -101]) {
    await index.record({
      channelChatId,
      messageId: 1,
      date: 1_700_000_001,
      caption: "untrusted caption",
      image: {
        fileId: `image-${channelChatId}`,
        filename: "image.jpg",
        mediaType: "image/jpeg",
        fileSize: 5,
      },
    })
  }
  const getFile = vi.fn(async () => ({
    file_id: "image",
    file_unique_id: "unique",
    file_path: "photo.jpg",
    file_size: 5,
  }))
  const fetchImplementation = vi.fn<typeof fetch>(async () => new Response("hello"))
  let tool: ToolDefinition | undefined
  createReadImageExtension(
    settings,
    index,
    logger,
    { getFile } as unknown as Api,
    fetchImplementation,
  )({
    registerTool: (definition: ToolDefinition) => {
      tool = definition
    },
  } as ExtensionAPI)
  if (!tool) throw new Error("read_image tool was not registered")
  return { tool, index, getFile, fetchImplementation }
}

describe("read_image Pi tool", () => {
  it("lists only allowlisted channel metadata and downloads only a requested indexed image", async () => {
    const { tool, getFile, fetchImplementation } = await setup()
    expect(tool.exposure).toBe("model-only")
    const listing = await tool.execute("list", {}, undefined, undefined, undefined as never)
    expect(listing.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining('"channel_chat_id":-100'),
    })
    expect(JSON.stringify(listing)).not.toContain("-101")
    expect(getFile).not.toHaveBeenCalled()
    expect(fetchImplementation).not.toHaveBeenCalled()

    const result = await tool.execute(
      "read",
      { channel_chat_id: -100, message_id: 1 },
      undefined,
      undefined,
      undefined as never,
    )
    expect(result.content).toEqual([
      {
        type: "text",
        text: 'Telegram channel image, channel_chat_id=-100, message_id=1. Caption (untrusted): "untrusted caption"',
      },
      { type: "image", mimeType: "image/jpeg", data: Buffer.from("hello").toString("base64") },
    ])
    expect(getFile).toHaveBeenCalledOnce()
    expect(fetchImplementation).toHaveBeenCalledOnce()
    expect(result.details).toBeUndefined() // no image bytes duplicated in details
  })

  it("rejects unauthorized channels, missing posts and invalid parameters without Telegram calls", async () => {
    const { tool, getFile, fetchImplementation } = await setup()
    for (const input of [
      { channel_chat_id: -101, message_id: 1 },
      { channel_chat_id: 7, message_id: 1 },
      { channel_chat_id: -100, message_id: 99 },
      { channel_chat_id: -100, message_id: -1 },
      { message_id: 1 },
    ]) {
      await expect(
        tool.execute("bad", input, undefined, undefined, undefined as never),
      ).rejects.toThrow()
    }
    expect(getFile).not.toHaveBeenCalled()
    expect(fetchImplementation).not.toHaveBeenCalled()
  })

  it("rejects oversized post metadata before contacting Telegram", async () => {
    const { tool, index, getFile, fetchImplementation } = await setup({ botImageMaxBytes: 4 })
    await expect(
      tool.execute(
        "large",
        { channel_chat_id: -100, message_id: 1 },
        undefined,
        undefined,
        undefined as never,
      ),
    ).rejects.toThrow("byte limit")
    expect(await index.find(-100, 1)).toBeDefined() // metadata remains indexed but never downloaded
    expect(getFile).not.toHaveBeenCalled()
    expect(fetchImplementation).not.toHaveBeenCalled()
  })

  it("reports oversized, streamed-overflow, transport failures and cancellation without returning image content", async () => {
    const { tool, getFile, fetchImplementation } = await setup({ botImageMaxBytes: 5 })
    getFile.mockResolvedValueOnce({
      file_id: "image",
      file_unique_id: "unique",
      file_path: "photo.jpg",
      file_size: 6,
    })
    await expect(
      tool.execute(
        "large",
        { channel_chat_id: -100, message_id: 1 },
        undefined,
        undefined,
        undefined as never,
      ),
    ).rejects.toThrow("byte limit")
    expect(fetchImplementation).not.toHaveBeenCalled()

    fetchImplementation.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(Buffer.from("123"))
            controller.enqueue(Buffer.from("456"))
            controller.close()
          },
        }),
      ),
    )
    await expect(
      tool.execute(
        "stream",
        { channel_chat_id: -100, message_id: 1 },
        undefined,
        undefined,
        undefined as never,
      ),
    ).rejects.toThrow("byte limit")
    fetchImplementation.mockRejectedValueOnce(new Error("network unavailable"))
    await expect(
      tool.execute(
        "failed",
        { channel_chat_id: -100, message_id: 1 },
        undefined,
        undefined,
        undefined as never,
      ),
    ).rejects.toThrow("Unable to download")
    const controller = new AbortController()
    controller.abort()
    await expect(
      tool.execute(
        "cancelled",
        { channel_chat_id: -100, message_id: 1 },
        controller.signal,
        undefined,
        undefined as never,
      ),
    ).rejects.toThrow("cancelled")
    expect(getFile).toHaveBeenCalledTimes(3)
  })
})
