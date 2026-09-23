import { describe, expect, it, vi } from "vitest"

import type { Logger, SpanAttributes } from "../src/logging.js"
import { MorselPublishError, MorselPublisher, publishMorselWithTrace } from "../src/morsel.js"

const capability = "a".repeat(43)

describe("MorselPublisher", () => {
  it("traces successful and failed publication without recording the content or share link", async () => {
    const records: SpanAttributes[] = []
    const logger: Logger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      span: async (_name, attributes, callback) => {
        const record = { ...attributes }
        records.push(record)
        return callback({
          setAttribute: (key, value) => {
            record[key] = value
          },
        })
      },
    }
    const share = "https://morsel.example/s/private-share"
    const publisher = { isConfigured: true, publish: vi.fn(async () => share) }
    await expect(
      publishMorselWithTrace(publisher, "private content", "rich_tool", logger, "call-1"),
    ).resolves.toBe(share)
    expect(records[0]).toEqual({
      "morsel.content_chars": 15,
      "morsel.delivery_mode": "rich_tool",
      "pi.tool_call_id": "call-1",
      "morsel.outcome": "published",
    })

    publisher.publish.mockRejectedValueOnce(new Error("private failure"))
    await expect(
      publishMorselWithTrace(publisher, "private content", "default", logger),
    ).rejects.toThrow("private failure")
    expect(records[1]).toMatchObject({ "morsel.outcome": "error", "morsel.error_type": "Error" })
    expect(JSON.stringify(records)).not.toContain("private content")
    expect(JSON.stringify(records)).not.toContain("private-share")
  })

  it("publishes bounded metadata and validates the returned capability URL", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (_input, init) => {
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>
      expect(payload.content).toBe("# 標題\n\n內容")
      expect(payload.telegram_instant_view).toBe(true)
      expect(payload).not.toHaveProperty("expires_in")
      return Response.json(
        { id: "share", share_url: `https://morsel.example/s/${capability}` },
        { status: 201 },
      )
    })
    const publisher = new MorselPublisher("https://morsel.example/", "secret", {
      timeoutMs: 1_000,
      expiresInSeconds: 60,
      telegramInstantView: true,
      fetchImplementation,
    })

    await expect(publisher.publish("# 標題\n\n內容")).resolves.toBe(
      `https://morsel.example/s/${capability}`,
    )
  })

  it.each([
    `https://evil.example/s/${capability}`,
    `https://morsel.example/\ts/${capability}`,
    `https://morsel.example/s/${capability}\n`,
  ])("rejects cross-origin, malformed, and control-containing share URLs", async (shareUrl) => {
    const publisher = new MorselPublisher("https://morsel.example/", "secret", {
      timeoutMs: 1_000,
      expiresInSeconds: 60,
      telegramInstantView: false,
      fetchImplementation: async () =>
        Response.json({ id: "share", share_url: shareUrl }, { status: 201 }),
    })

    await expect(publisher.publish("content")).rejects.toBeInstanceOf(MorselPublishError)
  })

  it("fails honestly when no API key is configured", async () => {
    const publisher = new MorselPublisher("https://morsel.example/", undefined, {
      timeoutMs: 1_000,
      expiresInSeconds: 60,
      telegramInstantView: false,
    })

    expect(publisher.isConfigured).toBe(false)
    await expect(publisher.publish("content")).rejects.toThrow("MORSEL_API_KEY")
  })
})
