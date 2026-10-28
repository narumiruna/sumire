import { describe, expect, it, vi } from "vitest"
import { openApi } from "../src/api.js"
import { json, setup, source, tokenValue } from "./fixtures.js"

const responseLimit = 2 * 1024 * 1024

describe("bounded GitHub API transport", () => {
  it.each([
    undefined,
    "",
    "token\nsecret",
    "token\n",
    "token\r\n",
    "token secret",
    "token\u007f",
    "トークン",
  ])("rejects an absent or invalid credential without a request", async (value) => {
    const { state, client, fetcher } = setup()
    state.credential = value
    await expect(client.scan()).rejects.toThrow("An applied GH_TOKEN secret is required")
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([301, 302, 401, 403, 429, 500])(
    "sanitizes HTTP %s without retries or upstream data",
    async (status) => {
      const { state, client, fetcher } = setup()
      state.hook = () => new Response(`${tokenValue} confidential upstream data`, { status })
      await expect(client.scan()).rejects.toThrow(
        new Error(`GitHub mention request failed (HTTP ${status})`),
      )
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("error")
    },
  )

  it.each([
    new Error(`${tokenValue} https://private.invalid/secret`),
    new DOMException("private timeout details", "TimeoutError"),
  ])("sanitizes network, redirect, and timeout errors", async (error) => {
    const { state, client, fetcher } = setup()
    state.hook = () => {
      throw error
    }
    await expect(client.scan()).rejects.toThrow(
      new Error("GitHub mention request failed or timed out"),
    )
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each([
    "not-json confidential",
    "{broken",
    "null",
    "[]",
    '{"id":0,"login":"sumire-bot"}',
    '{"id":101,"login":"../secret"}',
  ])("rejects malformed account responses without echoing them", async (body) => {
    const { state, client } = setup()
    state.hook = () => new Response(body)
    await expect(client.scan()).rejects.toThrow(new Error("GitHub returned invalid mention data"))
  })

  it("rejects an absent response stream", async () => {
    const { state, client } = setup()
    state.hook = () => new Response(null)
    await expect(client.scan()).rejects.toThrow("invalid mention data")
  })

  it("rejects an oversized Content-Length before reading and cancels its stream", async () => {
    const { state, client } = setup()
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel })
    state.hook = () =>
      new Response(body, { headers: { "content-length": String(responseLimit + 1) } })
    await expect(client.scan()).rejects.toThrow("response exceeds the size limit")
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it.each([undefined, "1", String(responseLimit)])(
    "counts streamed bytes independently of Content-Length=%s",
    async (length) => {
      const { state, client } = setup()
      const cancel = vi.fn()
      let chunks = 0
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            chunks++
            controller.enqueue(new Uint8Array(256 * 1024))
          },
          cancel,
        },
        { highWaterMark: 0 },
      )
      state.hook = () =>
        new Response(body, { headers: length === undefined ? {} : { "content-length": length } })
      await expect(client.scan()).rejects.toThrow("response exceeds the size limit")
      expect(chunks).toBe(9)
      expect(cancel).toHaveBeenCalledTimes(1)
    },
  )

  it("accepts the exact per-response byte limit and rejects the next byte", async () => {
    const { state, options } = setup()
    state.hook = () => json("x".repeat(responseLimit - 2))
    const api = openApi(options)
    expect((await api.request("/test")).data).toHaveLength(responseLimit - 2)
    state.hook = () => json("x".repeat(responseLimit - 1))
    await expect(api.request("/test")).rejects.toThrow("response exceeds the size limit")
  })

  it("caps aggregate operation bytes at 8 MiB even when each response is in bounds", async () => {
    const { state, options, fetcher } = setup()
    state.hook = () => json("x".repeat(responseLimit - 2))
    const api = openApi(options)
    for (let i = 0; i < 4; i++) await api.request("/test")
    await expect(api.request("/test")).rejects.toThrow("response exceeds the size limit")
    expect(fetcher).toHaveBeenCalledTimes(5)
  })

  it("caps an operation at 200 requests before dispatching request 201", async () => {
    const { state, options, fetcher } = setup()
    state.hook = () => json([])
    const api = openApi(options)
    for (let i = 0; i < 200; i++) await api.request("/test")
    await expect(api.request("/test")).rejects.toThrow("request limit exceeded")
    expect(fetcher).toHaveBeenCalledTimes(200)
  })

  it.each([
    "https://hostile.invalid",
    "//hostile.invalid/private",
    "/test#fragment",
    "/test\\private",
    "/test\r\nheader",
  ])("rejects unsafe API path %s before a request", async (path) => {
    const { options, fetcher } = setup()
    await expect(openApi(options).request(path)).rejects.toThrow("invalid mention data")
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("configures a 120-second operation bound and a 15-second request bound", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout")
    try {
      const { state, client, fetcher } = setup()
      state.notifications = []
      await client.scan()
      expect(timeout.mock.calls).toEqual([[120_000], [15_000], [15_000]])
      expect(fetcher.mock.calls.every(([, init]) => init?.signal instanceof AbortSignal)).toBe(true)
    } finally {
      timeout.mockRestore()
    }
  })

  it("preserves pre-request caller cancellation without credential access", async () => {
    const { client, fetcher, token } = setup()
    const controller = new AbortController()
    controller.abort(new Error("caller cancelled"))
    await expect(client.scan({}, controller.signal)).rejects.toThrow("caller cancelled")
    expect(token).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("does not return results when the caller aborts during HTTP", async () => {
    const { state, client, fetcher } = setup()
    const controller = new AbortController()
    state.hook = () => {
      controller.abort(new Error("cancelled during HTTP"))
      return json(state.account)
    }
    await expect(client.scan({}, controller.signal)).rejects.toThrow("cancelled during HTTP")
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("cancels streaming and preserves cancellation during a response read", async () => {
    const { state, client } = setup()
    const controller = new AbortController()
    const cancel = vi.fn()
    state.hook = () =>
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(stream) {
              controller.abort(new Error("cancelled during stream"))
              stream.enqueue(new TextEncoder().encode("{}"))
            },
            cancel,
          },
          { highWaterMark: 0 },
        ),
      )
    await expect(client.scan({}, controller.signal)).rejects.toThrow("cancelled during stream")
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it.each(["credential", "authorization"])(
    "rejects %s changes while HTTP is in flight",
    async (change) => {
      const { state, client, fetcher } = setup()
      state.hook = () => {
        if (change === "credential") state.credential = "replacement-synthetic-token"
        else state.authorized = false
        return json(state.account)
      }
      await expect(client.scan()).rejects.toThrow(
        change === "credential" ? "GitHub credentials changed" : "configuration revoked",
      )
      expect(fetcher).toHaveBeenCalledTimes(1)
    },
  )

  it("rejects credential replacement between operation requests", async () => {
    const { state, options, fetcher } = setup()
    const api = openApi(options)
    await api.request("/user")
    state.credential = "replacement-synthetic-token"
    await expect(api.request("/notifications")).rejects.toThrow("GitHub credentials changed")
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("sanitizes stream errors rather than leaking credentials or private upstream messages", async () => {
    const { state, client } = setup()
    state.hook = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(new Error(`${tokenValue} confidential-stream-error`))
          },
        }),
      )
    await expect(client.scan()).rejects.toThrow(
      new Error("GitHub mention request failed or timed out"),
    )
  })

  it("does not return credentials when source data is malformed", async () => {
    const { state, client } = setup()
    state.comments = [{ ...source(), updated_at: tokenValue }]
    await expect(client.scan()).rejects.toThrow(new Error("GitHub returned invalid mention data"))
  })
})
