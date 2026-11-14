import { createUrlTool } from "@narumitw/sumire-pi-url-reader"
import { UrlContentClient } from "@narumitw/sumire-url-reader"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { loadArticleSourceUrls } from "../src/blog-post/source.js"
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
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe("shared bot URL loading", () => {
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

  it("loads the same complete generic article once per entry point despite navigation exceeding the source budget", async () => {
    const target =
      "https://developers.openai.com/blog/securing-persistent-agents-like-openclaw-at-openai"
    const navigation = "Navigation fixture link ".repeat(700)
    const html = `<html><body><nav>${navigation}</nav>
      <main><header><h1>Generic article fixture</h1></header>
      <article><header><h2>Article section fixture</h2></header>
        <p>Opening paragraph of the short article.</p>
        <p>Closing paragraph of the short article.</p>
      </article><nav>Article navigation control</nav><button>Copy article control</button></main>
    </body></html>`
    const get = vi.fn(
      async (_target: string, requestOptions: { contentCallback?: (chunk: Buffer) => void }) => {
        let content: Buffer = Buffer.from(html)
        requestOptions.contentCallback?.(content)
        return {
          status: 200,
          headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
          get text() {
            return content.toString()
          },
          setContent: (value: Buffer) => {
            content = value
          },
          close: async () => undefined,
        }
      },
    )
    vi.spyOn(UrlContentClient.prototype, "impersSession").mockResolvedValue({
      get,
    } as unknown as Awaited<ReturnType<UrlContentClient["impersSession"]>>)
    vi.spyOn(UrlContentClient.prototype, "impersProxy").mockResolvedValue("http://127.0.0.1:8080")
    const metadataFetch = vi
      .spyOn(UrlContentClient.prototype, "fetch")
      .mockImplementation(async (input) => {
        expect(String(input)).toBe("https://wallhop.io/ruleset")
        return new Response("[]", { headers: { "content-type": "text/yaml" } })
      })
    const browser = vi
      .spyOn(UrlContentClient.prototype, "browser")
      .mockRejectedValue(new Error("Unexpected browser fallback"))
    const settings = loadSettings({ BOT_ADMIN_ID: "7" })
    const loader = createBotUrlLoader(settings)
    const load = vi.spyOn(loader, "load")
    const result = await createUrlTool(loader).execute(
      "article-call",
      { url: target },
      undefined,
      undefined,
      undefined as never,
    )

    expect(settings.botUrlMaxExtractedChars).toBe(12_000)
    expect(navigation.length).toBeGreaterThan(12_000)
    expect(result.isError).not.toBe(true)
    expect(result.details).toMatchObject({
      url: target,
      finalUrl: target,
      source: "url-content",
      loaderId: "curl-cffi",
      truncated: false,
    })
    const toolContent = JSON.parse(toolResultText(result))
    expect(toolContent.text).toContain("# Generic article fixture")
    expect(toolContent.text).toContain("## Article section fixture")
    expect(toolContent.text).toContain("Opening paragraph of the short article.")
    expect(toolContent.text).toContain("Closing paragraph of the short article.")
    expect(toolContent.text.length).toBeLessThan(12_000)
    expect(toolContent.text).not.toContain("Navigation fixture link")
    expect(toolContent.text).not.toContain("Article navigation control")
    expect(toolContent.text).not.toContain("Copy article control")
    expect(load).toHaveBeenCalledExactlyOnceWith(target, {})
    expect(get).toHaveBeenCalledExactlyOnceWith(target, expect.any(Object))

    await expect(
      loadArticleSourceUrls(target, loader, { maxChars: 12_000, timeoutMs: 5_000 }),
    ).resolves.toEqual([{ url: target, text: toolContent.text, truncated: false }])
    expect(load).toHaveBeenCalledTimes(2)
    expect(load).toHaveBeenNthCalledWith(2, target, { signal: expect.any(AbortSignal) })
    expect(get).toHaveBeenCalledTimes(2)
    expect(get).toHaveBeenNthCalledWith(2, target, expect.any(Object))
    expect(metadataFetch).toHaveBeenCalledExactlyOnceWith(
      "https://wallhop.io/ruleset",
      expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }),
    )
    expect(browser).not.toHaveBeenCalled()
    expect(mocks.fetchTranscript).not.toHaveBeenCalled()
  })

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
