import { createUrlTool } from "@narumitw/sumire-pi-url-reader"
import { UrlContentClient } from "@narumitw/sumire-url-reader"
import type { Session } from "impers"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ArticleSourceUrlError, loadArticleSourceUrls } from "../src/blog-post/source.js"
import { loadSettings } from "../src/config/settings.js"
import { createBotUrlLoader } from "../src/url-loader.js"
import { createPiFixture, toolResultText } from "./helpers/pi-fixture.js"

const mocks = vi.hoisted(() => ({ fetchTranscript: vi.fn(), lookup: vi.fn() }))
vi.mock("youtube-transcript", async (importOriginal) => ({
  ...(await importOriginal<typeof import("youtube-transcript")>()),
  fetchTranscript: mocks.fetchTranscript,
}))
vi.mock("node:dns/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:dns/promises")>()
  return { ...original, lookup: mocks.lookup }
})

const url = "https://youtu.be/TDkH3EbWTYc"
const transcript = "測試字幕第一行\n測試字幕第二行"
const fixtures: Awaited<ReturnType<typeof createPiFixture>>[] = []

beforeEach(() => {
  mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }])
  mocks.fetchTranscript
    .mockReset()
    .mockResolvedValue([{ text: "測試字幕第一行" }, { text: "測試字幕第二行" }])
})

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe("shared bot URL loading", () => {
  it("loads generic curl-cffi content through both article preloading and the URL tool", async () => {
    let body: Buffer = Buffer.from("<article><p>Shared generic article fixture.</p></article>")
    const get = vi.fn(
      async (_url: string, options: { contentCallback?: (chunk: Buffer) => void }) => {
        options.contentCallback?.(body)
        return {
          status: 200,
          headers: new Headers({ "content-type": "text/html" }),
          get text() {
            return body.toString()
          },
          setContent(value: Buffer) {
            body = value
          },
          close: async () => undefined,
        }
      },
    )
    const close = vi.fn(async () => undefined)
    vi.spyOn(UrlContentClient.prototype, "impersSession").mockResolvedValue({
      get,
      close,
    } as unknown as Session)
    const target = "https://example.com/generic-article"
    const loader = createBotUrlLoader(loadSettings({ BOT_ADMIN_ID: "7" }))
    const result = await createUrlTool(loader).execute(
      "generic-call",
      { url: target },
      undefined,
      undefined,
      undefined as never,
    )
    expect(result.isError).not.toBe(true)
    expect(result.details).toMatchObject({
      loaderId: "curl-cffi",
      text: "Shared generic article fixture.",
      truncated: false,
    })
    await expect(
      loadArticleSourceUrls(target, loader, { maxChars: 12_000, timeoutMs: 5_000 }),
    ).resolves.toEqual([{ url: target, text: "Shared generic article fixture.", truncated: false }])
    expect(get).toHaveBeenCalledTimes(2)
  })

  it("retains safe transport diagnostics in both generic entry points", async () => {
    vi.spyOn(UrlContentClient.prototype, "impersSession").mockRejectedValue(
      Object.assign(new Error("transport failed"), { code: "ECONNRESET" }),
    )
    vi.spyOn(UrlContentClient.prototype, "browser").mockRejectedValue(
      new Error("browser disabled in fixture"),
    )
    vi.spyOn(UrlContentClient.prototype, "fetch").mockRejectedValue(
      new Error("HTTP disabled in fixture"),
    )
    const target = "https://example.com/failed-article"
    const loader = createBotUrlLoader(loadSettings({ BOT_ADMIN_ID: "7" }))
    const result = await createUrlTool(loader).execute(
      "generic-failure",
      { url: target },
      undefined,
      undefined,
      undefined as never,
    )
    expect(result.isError).toBe(true)
    expect(result.details).toMatchObject({
      attempts: [
        expect.objectContaining({
          loaderId: "curl-cffi",
          diagnostic: { code: "transport_failure", phase: "loading" },
        }),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      ],
    })
    const error = await loadArticleSourceUrls(target, loader, {
      maxChars: 12_000,
      timeoutMs: 5_000,
    }).catch((error) => error)
    expect(error).toBeInstanceOf(ArticleSourceUrlError)
    expect(error.failure.attempts[0]).toMatchObject({
      loaderId: "curl-cffi",
      diagnostic: { code: "transport_failure", phase: "loading" },
    })
    expect(JSON.stringify(result)).not.toContain(target)
    expect(JSON.stringify(error.failure)).not.toContain(target)
  })

  it.each([
    url,
    "https://www.youtube.com/watch?v=TDkH3EbWTYc",
    "https://www.youtube.com/shorts/TDkH3EbWTYc",
  ])(
    "extracts the same captions through the tool and article source loader: %s",
    async (target) => {
      const settings = loadSettings({ BOT_ADMIN_ID: "7" })
      const loader = createBotUrlLoader(settings)
      const tool = createUrlTool(loader)
      const result = await tool.execute(
        "caption-call",
        { url: target },
        undefined,
        undefined,
        undefined as never,
      )
      expect(result.details).toMatchObject({
        loaderId: "youtube",
        text: transcript,
        truncated: false,
      })
      expect(JSON.parse(toolResultText(result))).toMatchObject({ text: transcript })
      await expect(
        loadArticleSourceUrls(target, loader, { maxChars: 12_000, timeoutMs: 5_000 }),
      ).resolves.toEqual([{ url: target, text: transcript, truncated: false }])
      expect(mocks.fetchTranscript).toHaveBeenCalledTimes(2)
      expect(mocks.fetchTranscript).toHaveBeenCalledWith("TDkH3EbWTYc", { lang: "zh-TW" })
    },
  )

  it("preserves cancellation in both entry points without attempting captions", async () => {
    const loader = createBotUrlLoader(loadSettings({ BOT_ADMIN_ID: "7" }))
    const signal = AbortSignal.abort(new Error("cancelled"))
    await expect(
      createUrlTool(loader).execute("cancel-call", { url }, signal, undefined, undefined as never),
    ).rejects.toThrow("cancelled")
    await expect(
      loadArticleSourceUrls(url, loader, { maxChars: 12_000, timeoutMs: 5_000, signal }),
    ).rejects.toThrow("cancelled")
    expect(mocks.fetchTranscript).not.toHaveBeenCalled()
  })

  it("preserves a structured tool failure through durable storage and the next model turn", async () => {
    const fixture = await createPiFixture()
    fixtures.push(fixture)
    const session = await fixture.createSession()
    const result = await fixture.call(session, "read_url_content", {
      url: "http://127.0.0.1/?token=secret",
    })
    expect(result.isError).toBe(true)
    expect(result.details).toMatchObject({ code: "unsafe_url" })
    const text = toolResultText(result)
    expect(text).toContain("unsafe_url")
    expect(text).not.toMatch(/127\.0\.0\.1|token=secret/u)
    const nextToolMessage = fixture.requests[1]?.messages
      .filter((message) => message.role === "tool")
      .at(-1)
    expect(JSON.stringify(nextToolMessage)).toContain("unsafe_url")
    expect(JSON.stringify(nextToolMessage)).not.toContain("token=secret")
    expect(mocks.fetchTranscript).not.toHaveBeenCalled()
  })

  it("exposes caption support to Pi and returns the transcript to its next model turn", async () => {
    const fixture = await createPiFixture()
    fixtures.push(fixture)
    const session = await fixture.createSession()
    fixture.enqueue("read_url_content", { url })
    await session.prompt(url)
    const request = fixture.requests[0]
    const tool = request?.tools.find((entry) => entry.function.name === "read_url_content")
    expect(JSON.stringify(tool)).toContain("YouTube")
    expect(JSON.stringify(tool)).toContain("caption extraction first")
    const instructions = JSON.stringify(request?.messages)
    expect(instructions).toContain("沒有本次工具失敗的結果")
    expect(instructions).toContain("即使先前宣稱讀不到，仍先呼叫工具")
    expect(instructions).toContain("本次明確提供的 loaded_url_content")
    expect(instructions).toContain("讀取失敗不等於影片沒有字幕")
    expect(instructions).toContain("若 truncated 為 true，說明只取得部分內容")
    expect(JSON.stringify(fixture.requests[1]?.messages)).toContain("測試字幕第一行")
    expect(session.messages).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolName: "read_url_content",
        isError: false,
      }),
    )
    expect(mocks.fetchTranscript).toHaveBeenCalledExactlyOnceWith("TDkH3EbWTYc", { lang: "zh-TW" })
  })
})
