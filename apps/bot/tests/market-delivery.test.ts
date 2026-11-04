import type { Context } from "grammy"
import { describe, expect, it, vi } from "vitest"
import {
  MarketDataOutputError,
  maxMarketMessageChars,
  maxMarketReplies,
} from "../src/market-data/format.js"
import { replyMarketData } from "../src/telegram/market-delivery.js"

function setup() {
  const reply = vi.fn(async (_text: { markdown: string }, _options?: unknown) => undefined)
  return { reply, context: { replyWithRichMessage: reply } as unknown as Context }
}

describe("native-only market delivery", () => {
  it("sends content beyond the general 1000-character threshold directly", async () => {
    const { context, reply } = setup()
    const text = "股".repeat(5000)
    const options = { reply_parameters: { message_id: 81 } }
    await replyMarketData(context, [text], options)
    expect(reply).toHaveBeenCalledExactlyOnceWith({ markdown: text }, options)
  })

  it("validates all source parts before sending any", async () => {
    const { context, reply } = setup()
    await expect(
      replyMarketData(context, ["first", "字".repeat(maxMarketMessageChars + 1)]),
    ).rejects.toThrow(MarketDataOutputError)
    expect(reply).not.toHaveBeenCalled()
  })

  it("cleans controls and line endings without damaging Unicode", async () => {
    const { context, reply } = setup()
    await replyMarketData(context, ["\u0000\r\n", "🌸\ud800\r\n台積電\u0000"])
    expect(reply).toHaveBeenCalledExactlyOnceWith({ markdown: "🌸\n台積電" }, undefined)
  })

  it("uses a bounded no-match message for empty results", async () => {
    const { context, reply } = setup()
    await replyMarketData(context, ["\u0000", "  "])
    expect(reply).toHaveBeenCalledExactlyOnceWith(
      { markdown: "查不到市場資料，請確認代碼或稍後再試。" },
      undefined,
    )
  })

  it("sends parts sequentially with the same reply parameters", async () => {
    let release: (() => void) | undefined
    const reply = vi.fn(async (_text: { markdown: string }, _options?: unknown) => {
      if (reply.mock.calls.length === 1)
        await new Promise<void>((resolve) => {
          release = resolve
        })
    })
    const context = { replyWithRichMessage: reply } as unknown as Context
    const options = { reply_parameters: { message_id: 81 } }
    const sending = replyMarketData(context, ["one", "two"], options)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(reply).toHaveBeenCalledOnce()
    release?.()
    await sending
    expect(reply).toHaveBeenNthCalledWith(1, { markdown: "one" }, options)
    expect(reply).toHaveBeenNthCalledWith(2, { markdown: "two" }, options)
  })

  it("stops on transport failure instead of duplicating or publishing data", async () => {
    const { context, reply } = setup()
    const error = new Error("Telegram transport failure")
    reply.mockRejectedValueOnce(error)
    await expect(replyMarketData(context, ["one", "two"])).rejects.toBe(error)
    expect(reply).toHaveBeenCalledOnce()
  })
  it("refuses excessive reply arrays before sending the first part", async () => {
    const { context, reply } = setup()
    await expect(
      replyMarketData(
        context,
        Array.from({ length: maxMarketReplies + 1 }, () => "quote"),
      ),
    ).rejects.toThrow(MarketDataOutputError)
    expect(reply).not.toHaveBeenCalled()
  })
})
