import type { Context } from "grammy"
import { describe, expect, it, vi } from "vitest"

import { createTelegramDelivery } from "../src/telegram/delivery.js"

const shareUrl = "https://morsel.example/s/share"

function setup(configured = true, threshold = 1000) {
  const publisher = { isConfigured: configured, publish: vi.fn(async () => shareUrl) }
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const reply = vi.fn<
    (
      text: { markdown: string },
      options?: Parameters<Context["replyWithRichMessage"]>[1],
    ) => Promise<unknown>
  >(async () => ({ message_id: 1 }))
  const editMessageText = vi.fn<
    (
      chatId: number,
      messageId: number,
      text: { markdown: string },
      options?: unknown,
    ) => Promise<unknown>
  >(async () => true)
  const context = { replyWithRichMessage: reply, api: { editMessageText } } as unknown as Context
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
      expect(reply).toHaveBeenCalledWith({ markdown: text }, undefined)
    },
  )

  it.each(["字", "a", "🌸"])(
    "publishes all 1001 %s characters once, then sends only the link",
    async (character) => {
      const { delivery, context, publisher, reply } = setup()
      const text = character.repeat(1001)
      await delivery.reply(context, text)
      expect(publisher.publish).toHaveBeenCalledExactlyOnceWith(text)
      expect(reply).toHaveBeenCalledExactlyOnceWith(
        { markdown: expect.stringContaining(shareUrl) },
        undefined,
      )
      expect(reply.mock.calls[0]?.[0].markdown).not.toContain(text)
    },
  )

  it("normalizes newlines and removes invalid controls before counting or publishing", async () => {
    const { delivery, context, publisher, reply } = setup()
    await delivery.reply(context, `${"字".repeat(999)}\r\n\u0000`)
    expect(publisher.publish).not.toHaveBeenCalled()
    expect(reply).toHaveBeenCalledWith({ markdown: `${"字".repeat(999)}\n` }, undefined)
    await delivery.reply(context, `${"字".repeat(1000)}\r\n\u0000`)
    expect(publisher.publish).toHaveBeenCalledExactlyOnceWith(`${"字".repeat(1000)}\n`)
  })

  it("counts sanitized Markdown source rather than treating entity markup as extra characters", async () => {
    const { delivery, context, publisher, editMessageText } = setup()
    await expect(delivery.edit(context, 7, 100, "<".repeat(1000))).resolves.toBe("delivered")
    expect(publisher.publish).not.toHaveBeenCalled()
    expect(editMessageText).toHaveBeenCalledWith(7, 100, { markdown: "<".repeat(1000) })
  })

  it("sends the prepared content as a new reply when editing fails", async () => {
    const { delivery, context, editMessageText, reply, publisher } = setup()
    editMessageText.mockRejectedValue(new Error("message to edit not found"))
    const options = undefined

    await expect(
      delivery.editOrReply(context, 7, 100, "<回答>", options, () => true),
    ).resolves.toMatchObject({
      message: { message_id: 1 },
      previousMessageUpdated: false,
      result: "delivered",
    })
    expect(editMessageText).toHaveBeenCalledWith(7, 100, { markdown: "<回答>" })
    expect(reply).toHaveBeenCalledExactlyOnceWith({ markdown: "<回答>" }, options)
    expect(publisher.publish).not.toHaveBeenCalled()
  })

  it("clears the old pending status after a transient edit failure", async () => {
    const { delivery, context, editMessageText, reply } = setup()
    editMessageText.mockRejectedValueOnce(new Error("temporary transport failure"))

    await expect(
      delivery.editOrReply(context, 7, 100, "回答", undefined, () => true),
    ).resolves.toMatchObject({
      message: { message_id: 1 },
      previousMessageUpdated: true,
      result: "delivered",
    })
    expect(editMessageText).toHaveBeenCalledTimes(2)
    expect(editMessageText).toHaveBeenNthCalledWith(2, 7, 100, { markdown: "已改以新訊息回覆。" })
    expect(reply).toHaveBeenCalledExactlyOnceWith({ markdown: "回答" }, undefined)
  })

  it("sends an unchanged answer first, then clears the previous status", async () => {
    const { delivery, context, editMessageText, reply } = setup()
    const options = undefined

    await expect(
      delivery.replyAndClearPrevious(context, 7, 100, "處理中…", options, () => true),
    ).resolves.toMatchObject({
      message: { message_id: 1 },
      previousMessageUpdated: true,
      result: "delivered",
    })
    expect(reply).toHaveBeenCalledExactlyOnceWith({ markdown: "處理中…" }, options)
    expect(editMessageText).toHaveBeenCalledExactlyOnceWith(7, 100, {
      markdown: "已改以新訊息回覆。",
    })
  })

  it("does not retry a failed edit after the request is invalidated", async () => {
    const { delivery, context, editMessageText, reply } = setup()
    let current = true
    editMessageText.mockImplementation(async () => {
      current = false
      throw new Error("message to edit not found")
    })

    await expect(
      delivery.editOrReply(context, 7, 100, "回答", undefined, () => current),
    ).resolves.toEqual({ result: "stale" })
    expect(reply).not.toHaveBeenCalled()
  })

  it("cannot raise the hard limit through legacy threshold settings", async () => {
    const { delivery, context, publisher } = setup(true, 5000)
    await delivery.reply(context, "x".repeat(1001))
    expect(publisher.publish).toHaveBeenCalledOnce()
  })

  it("can always publish short generated content and deliver only its URL", async () => {
    const { delivery, context, publisher, reply } = setup()
    await expect(
      delivery.guardedReply(context, "short article", undefined, () => true, "publish"),
    ).resolves.toMatchObject({ result: "delivered" })
    expect(publisher.publish).toHaveBeenCalledExactlyOnceWith("short article")
    expect(reply).toHaveBeenCalledExactlyOnceWith({ markdown: shareUrl }, undefined)
  })

  it("withholds generated articles when required publication is unavailable", async () => {
    const { delivery, context, publisher, reply } = setup(false)
    await expect(
      delivery.guardedReply(context, "private article", undefined, () => true, "publish"),
    ).resolves.toMatchObject({ result: "unavailable" })
    expect(publisher.publish).not.toHaveBeenCalled()
    expect(reply).toHaveBeenCalledExactlyOnceWith(
      { markdown: "文章無法發布至 Morsel（原因：MORSEL_API_KEY is not configured），請稍後再試。" },
      undefined,
    )
    expect(reply.mock.calls[0]?.[0].markdown).not.toContain("private article")
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
      const sent = String(reply.mock.calls[0]?.[0].markdown)
      const edited = String(editMessageText.mock.calls[0]?.[2].markdown)
      const expectedReason =
        failure === "unconfigured"
          ? "MORSEL_API_KEY is not configured"
          : failure === "failed"
            ? "Morsel unavailable"
            : "Morsel share link exceeds the Telegram message limit"
      for (const value of [sent, edited]) {
        expect(value).toContain(`Morsel 暫時無法使用（原因：${expectedReason}）`)
        expect(Array.from(value).length).toBeLessThanOrEqual(1000)
        expect(value).not.toContain("secret-long-answer")
      }
      expect(reply).toHaveBeenCalledOnce()
      expect(editMessageText).toHaveBeenCalledOnce()
      expect(logger.warn).toHaveBeenCalledTimes(2)
      expect(publisher.publish).toHaveBeenCalledTimes(failure === "unconfigured" ? 0 : 2)
    },
  )

  it("sanitizes and bounds the failure reason shown to users", async () => {
    const { delivery, context, publisher, reply } = setup()
    publisher.publish.mockRejectedValue(new Error(`service\nfailed\u0000${"x".repeat(1000)}`))
    await delivery.reply(context, "長".repeat(1001))
    const sent = String(reply.mock.calls[0]?.[0].markdown)
    expect(sent).toContain("原因：service failed")
    expect(sent).not.toContain("\n")
    expect(sent).not.toContain("\u0000")
    expect(Array.from(sent).length).toBeLessThan(300)
  })

  it("reports an unknown reason for non-Error failures", async () => {
    const { delivery, context, publisher, reply } = setup()
    publisher.publish.mockRejectedValue(undefined)
    await delivery.reply(context, "長".repeat(1001))
    expect(reply.mock.calls[0]?.[0].markdown).toContain("原因：未知錯誤")
  })

  it("does not publish or deliver already invalidated work", async () => {
    const { delivery, context, publisher, reply, editMessageText } = setup()
    await expect(
      delivery.guardedReply(context, "short article", undefined, () => false, "publish"),
    ).resolves.toEqual({ result: "stale" })
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
      delivery.guardedReply(context, "short article", undefined, () => current, "publish"),
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
    await expect(
      delivery.edit(context, 7, 100, "short article", () => current, "publish"),
    ).resolves.toBe("stale")
    expect(publisher.publish).toHaveBeenCalledOnce()
    expect(editMessageText).not.toHaveBeenCalled()
  })
})

describe("rich reply delivery", () => {
  const source = "**重點** [文件](https://example.test/path)\n> 引用"
  const markdown = source

  it("sends ordinary replies as native Markdown and preserves reply parameters and keyboards", async () => {
    const { delivery, context, reply } = setup()
    const options = {
      reply_parameters: { message_id: 42, allow_sending_without_reply: true },
      reply_markup: { inline_keyboard: [[{ text: "停止", callback_data: "stop" }]] },
    }
    await delivery.reply(context, source, options)
    expect(reply).toHaveBeenCalledExactlyOnceWith({ markdown }, options)
  })

  it("formats guarded replies without parse_mode", async () => {
    const { delivery, context, reply } = setup()
    await expect(
      delivery.guardedReply(context, source, undefined, () => true),
    ).resolves.toMatchObject({
      result: "delivered",
    })
    expect(reply).toHaveBeenCalledExactlyOnceWith({ markdown }, undefined)
  })

  it("uses identical native Markdown for edits and fallback sends, without local HTML conversion", async () => {
    const { delivery, context, reply, editMessageText } = setup()
    editMessageText.mockRejectedValueOnce(new Error("message to edit not found"))
    await delivery.editOrReply(context, 7, 100, source, undefined, () => true)
    expect(editMessageText).toHaveBeenNthCalledWith(1, 7, 100, { markdown })
    expect(reply).toHaveBeenCalledExactlyOnceWith({ markdown }, undefined)
  })

  it("formats a separate final reply even without caller-supplied options", async () => {
    const { delivery, context, reply } = setup()
    await delivery.replyAndClearPrevious(context, 7, 100, source, undefined, () => true)
    expect(reply).toHaveBeenCalledExactlyOnceWith({ markdown }, undefined)
  })

  it("uses returned native blocks for delivered text and source identity for direct payload", async () => {
    const { delivery, context, editMessageText } = setup()
    const onDelivered = vi.fn()
    editMessageText.mockResolvedValue({
      message_id: 100,
      rich_message: {
        blocks: [
          {
            type: "paragraph",
            text: [
              { type: "bold", text: "重點" },
              " ",
              { type: "url", text: "文件", url: "https://example.test/path" },
            ],
          },
          { type: "blockquote", blocks: [{ type: "paragraph", text: "引用" }] },
        ],
      },
    })
    expect(delivery.directPayload(source)).toBe(markdown)
    await delivery.edit(context, 7, 100, source, () => true, "default", onDelivered)
    expect(editMessageText).toHaveBeenCalledExactlyOnceWith(7, 100, { markdown })
    expect(onDelivered).toHaveBeenCalledExactlyOnceWith(
      "重點 文件 (https://example.test/path)\n引用",
    )
  })

  it("counts source Markdown before formatting and publishes the unmodified full text", async () => {
    const { delivery, context, publisher, reply } = setup()
    const text = `[短標籤](https://example.test/${"x".repeat(1000)})`
    await delivery.reply(context, text)
    expect(publisher.publish).toHaveBeenCalledExactlyOnceWith(text)
    expect(reply.mock.calls[0]?.[0].markdown).toContain(shareUrl)
    expect(reply.mock.calls[0]?.[0].markdown).not.toContain("短標籤")
    expect(reply.mock.calls[0]?.[1]).toBeUndefined()
  })

  it("passes raw source as Markdown, not legacy HTML in short replies and publication failure notices", async () => {
    const { delivery, context, publisher, reply } = setup()
    await delivery.reply(context, '<a href="https://example.test">raw</a>')
    expect(reply.mock.calls[0]?.[0].markdown).toBe('<a href="https://example.test">raw</a>')
    publisher.publish.mockRejectedValue(new Error("<script>failure</script>"))
    await delivery.reply(context, "字".repeat(1001))
    expect(reply.mock.calls[1]?.[0].markdown).toContain("<script>failure</script>")
  })
})
