import type { Context } from "grammy"
import { describe, expect, it, vi } from "vitest"

import { createTelegramDelivery } from "../src/telegram/delivery.js"

const shareUrl = "https://morsel.example/s/share"

function setup(configured = true, threshold = 1000) {
  const publisher = { isConfigured: configured, publish: vi.fn(async () => shareUrl) }
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const reply = vi.fn<
    (text: string, options?: Parameters<Context["reply"]>[1]) => Promise<unknown>
  >(async () => ({ message_id: 1 }))
  const editMessageText = vi.fn<
    (chatId: number, messageId: number, text: string, options?: unknown) => Promise<unknown>
  >(async () => true)
  const context = { reply, api: { editMessageText } } as unknown as Context
  return {
    publisher,
    logger,
    reply,
    editMessageText,
    context,
    delivery: createTelegramDelivery(publisher, logger, threshold),
  }
}

describe("mandatory Morsel delivery", () => {
  it.each(["字", "a", "🌸"])(
    "counts %s as Unicode code points and sends exactly 1000 characters directly",
    async (character) => {
      const { delivery, context, publisher, reply } = setup()
      const text = character.repeat(1000)
      await delivery.reply(context, text)
      expect(publisher.publish).not.toHaveBeenCalled()
      expect(reply).toHaveBeenCalledWith(text, undefined)
    },
  )

  it.each(["字", "a", "🌸"])(
    "publishes all 1001 %s characters once, then sends only the link",
    async (character) => {
      const { delivery, context, publisher, reply } = setup()
      const text = character.repeat(1001)
      await delivery.reply(context, text)
      expect(publisher.publish).toHaveBeenCalledExactlyOnceWith(text)
      expect(reply).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(shareUrl), undefined)
      expect(reply.mock.calls[0]?.[0]).not.toContain(text)
    },
  )

  it("normalizes newlines and removes invalid controls before counting or publishing", async () => {
    const { delivery, context, publisher, reply } = setup()
    await delivery.reply(context, `${"字".repeat(999)}\r\n\u0000`)
    expect(publisher.publish).not.toHaveBeenCalled()
    expect(reply).toHaveBeenCalledWith(`${"字".repeat(999)}\n`, undefined)
    await delivery.reply(context, `${"字".repeat(1000)}\r\n\u0000`)
    expect(publisher.publish).toHaveBeenCalledExactlyOnceWith(`${"字".repeat(1000)}\n`)
  })

  it("counts before HTML escaping rather than treating entity markup as extra characters", async () => {
    const { delivery, context, publisher, editMessageText } = setup()
    await expect(delivery.edit(context, 7, 100, "<".repeat(1000))).resolves.toBe("delivered")
    expect(publisher.publish).not.toHaveBeenCalled()
    expect(editMessageText).toHaveBeenCalledWith(7, 100, "&lt;".repeat(1000), {
      parse_mode: "HTML",
    })
  })

  it("cannot raise the hard limit through legacy threshold settings", async () => {
    const { delivery, context, publisher } = setup(true, 5000)
    await delivery.reply(context, "x".repeat(1001))
    expect(publisher.publish).toHaveBeenCalledOnce()
  })

  it.each(["unconfigured", "failed", "oversized-link"])(
    "withholds long content when Morsel is %s",
    async (failure) => {
      const { delivery, context, publisher, reply, editMessageText, logger } = setup(
        failure !== "unconfigured",
      )
      if (failure === "failed") publisher.publish.mockRejectedValue(new Error("Morsel unavailable"))
      if (failure === "oversized-link")
        publisher.publish.mockResolvedValue(`https://example.com/${"x".repeat(1001)}`)
      const text = "secret-long-answer".repeat(1000)
      await delivery.reply(context, text)
      await expect(delivery.edit(context, 7, 100, text)).resolves.toBe("unavailable")
      const sent = String(reply.mock.calls[0]?.[0])
      const edited = String(editMessageText.mock.calls[0]?.[2])
      for (const value of [sent, edited]) {
        expect(value).toContain("Morsel 暫時無法使用")
        expect(Array.from(value).length).toBeLessThanOrEqual(1000)
        expect(value).not.toContain("secret-long-answer")
      }
      expect(reply).toHaveBeenCalledOnce()
      expect(editMessageText).toHaveBeenCalledOnce()
      expect(logger.warn).toHaveBeenCalledTimes(2)
      expect(publisher.publish).toHaveBeenCalledTimes(failure === "unconfigured" ? 0 : 2)
    },
  )

  it("does not publish or deliver already invalidated work", async () => {
    const { delivery, context, publisher, reply, editMessageText } = setup()
    await expect(
      delivery.guardedReply(context, "x".repeat(1001), undefined, () => false),
    ).resolves.toEqual({ result: "stale" })
    await expect(delivery.edit(context, 7, 100, "x".repeat(1001), () => false)).resolves.toBe(
      "stale",
    )
    expect(publisher.publish).not.toHaveBeenCalled()
    expect(reply).not.toHaveBeenCalled()
    expect(editMessageText).not.toHaveBeenCalled()
  })

  it("rechecks reply validity after Morsel publication", async () => {
    const { delivery, context, publisher, reply } = setup()
    let current = true
    publisher.publish.mockImplementation(async () => {
      current = false
      return shareUrl
    })
    await expect(
      delivery.guardedReply(context, "x".repeat(1001), undefined, () => current),
    ).resolves.toEqual({ result: "stale" })
    expect(publisher.publish).toHaveBeenCalledOnce()
    expect(reply).not.toHaveBeenCalled()
  })

  it("rechecks edit validity after Morsel publication", async () => {
    const { delivery, context, publisher, editMessageText } = setup()
    let current = true
    publisher.publish.mockImplementation(async () => {
      current = false
      return shareUrl
    })
    await expect(delivery.edit(context, 7, 100, "x".repeat(1001), () => current)).resolves.toBe(
      "stale",
    )
    expect(publisher.publish).toHaveBeenCalledOnce()
    expect(editMessageText).not.toHaveBeenCalled()
  })
})
