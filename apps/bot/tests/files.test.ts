import { Api, GrammyError, HttpError } from "grammy"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Logger, SpanAttributes } from "../src/logging.js"
import {
  downloadTelegramFile,
  downloadTelegramImage,
  TelegramDownloadTooLargeError,
} from "../src/telegram/files.js"

function apiWithFile(file: { file_path?: string; file_size?: number } = {}): Api {
  return {
    getFile: vi.fn(async () => ({
      file_id: "file",
      file_unique_id: "unique",
      file_path: "documents/file.bin",
      ...file,
    })),
  } as unknown as Api
}

function connectionReset(): Error {
  return Object.assign(new Error("connection reset"), { code: "ECONNRESET" })
}

function downloadTrace() {
  const spans: Array<{ name: string; attributes: SpanAttributes }> = []
  const logger: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    async span(name, attributes, callback) {
      const record = { name, attributes: { ...attributes } }
      spans.push(record)
      return callback({
        setAttribute: (key, value) => {
          record.attributes[key] = value
        },
      })
    },
  }
  return { logger, spans }
}

describe("Telegram download connection-reset retry", () => {
  it.each([
    ["direct", () => connectionReset()],
    ["native cause", () => new TypeError("fetch failed", { cause: connectionReset() })],
    ["grammY wrapper", () => new HttpError("getFile failed", connectionReset())],
  ])("recovers from a %s reset with one complete retry", async (_name, createError) => {
    const api = apiWithFile()
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(createError())
      .mockResolvedValueOnce(new Response("complete"))

    await expect(
      downloadTelegramFile(api, "token", { fileId: "file" }, 100, fetchImplementation),
    ).resolves.toEqual(Buffer.from("complete"))
    expect(api.getFile).toHaveBeenCalledTimes(2)
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
  })

  it("retries a reset wrapped by the real grammY getFile client", async () => {
    const telegramFetch = vi
      .fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              result: { file_id: "file", file_unique_id: "unique", file_path: "photos/file.jpg" },
            }),
          ),
      )
      .mockRejectedValueOnce(connectionReset())
    const api = new Api("test-token", {
      fetch: telegramFetch as unknown as NonNullable<
        NonNullable<ConstructorParameters<typeof Api>[1]>["fetch"]
      >,
    })
    const mediaFetch = vi.fn<typeof fetch>(async () => new Response("image"))

    await expect(
      downloadTelegramFile(api, "test-token", { fileId: "file" }, 100, mediaFetch),
    ).resolves.toEqual(Buffer.from("image"))
    expect(telegramFetch).toHaveBeenCalledTimes(2)
    expect(mediaFetch).toHaveBeenCalledOnce()
  })

  it("preserves the final error after two failed attempts", async () => {
    const api = apiWithFile()
    const finalError = connectionReset()
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(connectionReset())
      .mockRejectedValueOnce(finalError)

    await expect(
      downloadTelegramFile(api, "token", { fileId: "file" }, 100, fetchImplementation),
    ).rejects.toBe(finalError)
    expect(api.getFile).toHaveBeenCalledTimes(2)
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
  })

  it("shares the retry budget between getFile and media fetch", async () => {
    const api = apiWithFile()
    const finalError = new HttpError("getFile failed", connectionReset())
    vi.mocked(api.getFile).mockImplementationOnce(async () => {
      return { file_id: "file", file_unique_id: "unique", file_path: "photos/file.jpg" }
    })
    vi.mocked(api.getFile).mockRejectedValueOnce(finalError)
    const mediaFetch = vi.fn<typeof fetch>().mockRejectedValue(connectionReset())

    await expect(
      downloadTelegramFile(api, "token", { fileId: "file" }, 100, mediaFetch),
    ).rejects.toBe(finalError)
    expect(api.getFile).toHaveBeenCalledTimes(2)
    expect(mediaFetch).toHaveBeenCalledOnce()
  })

  it("releases a partial reset body and discards its bytes before retry", async () => {
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(Buffer.from("discard"))
        else controller.error(connectionReset())
      },
    })
    const api = apiWithFile()
    const mediaFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(body))
      .mockImplementationOnce(async () => {
        expect(body.locked).toBe(false)
        return new Response("complete")
      })

    await expect(
      downloadTelegramFile(api, "token", { fileId: "file" }, 100, mediaFetch),
    ).resolves.toEqual(Buffer.from("complete"))
    expect(api.getFile).toHaveBeenCalledTimes(2)
    expect(mediaFetch).toHaveBeenCalledTimes(2)
    expect(body.locked).toBe(false)
  })
})

describe("Telegram download retry exclusions and bounds", () => {
  it.each([
    ["message text", () => new Error("ECONNRESET")],
    ["other code", () => Object.assign(new Error("network"), { code: "ETIMEDOUT" })],
    [
      "other native cause",
      () => new TypeError("fetch failed", { cause: { code: "UND_ERR_SOCKET" } }),
    ],
    [
      "abort wrapper",
      () => Object.assign(new DOMException("aborted", "AbortError"), { cause: connectionReset() }),
    ],
    [
      "timeout wrapper",
      () =>
        new HttpError(
          "getFile failed",
          Object.assign(new DOMException("timeout", "TimeoutError"), { cause: connectionReset() }),
        ),
    ],
    [
      "nested abort",
      () => Object.assign(connectionReset(), { cause: new DOMException("aborted", "AbortError") }),
    ],
    [
      "size error",
      () =>
        Object.assign(new TelegramDownloadTooLargeError("too large"), { cause: connectionReset() }),
    ],
    [
      "Telegram API error",
      () =>
        Object.assign(
          new GrammyError(
            "getFile failed",
            { ok: false, error_code: 429, description: "rate limited" },
            "getFile",
            {},
          ),
          { cause: connectionReset() },
        ),
    ],
    [
      "cyclic wrapper",
      () => {
        const error = connectionReset()
        return Object.assign(error, { cause: error })
      },
    ],
    [
      "deep wrapper",
      () => {
        let error: Error = connectionReset()
        for (let i = 0; i < 8; i++) error = new Error("wrapper", { cause: error })
        return error
      },
    ],
  ])("does not retry a %s", async (_name, createError) => {
    const api = apiWithFile()
    const error = createError()
    const mediaFetch = vi.fn<typeof fetch>().mockRejectedValue(error)

    await expect(
      downloadTelegramFile(api, "token", { fileId: "file" }, 100, mediaFetch),
    ).rejects.toBe(error)
    expect(api.getFile).toHaveBeenCalledOnce()
    expect(mediaFetch).toHaveBeenCalledOnce()
  })

  it.each([302, 401, 403, 404, 429, 500, 503])(
    "does not retry HTTP %s and cancels its body",
    async (status) => {
      const api = apiWithFile()
      // A cleanup error must not replace the HTTP failure or make it retryable.
      const cancel = vi.fn(async () => {
        throw connectionReset()
      })
      const body = new ReadableStream<Uint8Array>({ cancel })
      const mediaFetch = vi.fn<typeof fetch>(async (_input, init) => {
        expect(init?.redirect).toBe("manual")
        return new Response(body, { status })
      })

      await expect(
        downloadTelegramFile(api, "token", { fileId: "file" }, 100, mediaFetch),
      ).rejects.toThrow(`HTTP ${status}`)
      expect(api.getFile).toHaveBeenCalledOnce()
      expect(mediaFetch).toHaveBeenCalledOnce()
      expect(cancel).toHaveBeenCalledOnce()
      expect(body.locked).toBe(false)
    },
  )

  it.each(["missing path", "empty body", "zero-length body"])(
    "does not retry a %s",
    async (failure) => {
      const api = apiWithFile(failure === "missing path" ? { file_path: undefined } : {})
      const mediaFetch = vi.fn<typeof fetch>(
        async () => new Response(failure === "empty body" ? null : ""),
      )

      await expect(
        downloadTelegramFile(api, "token", { fileId: "file" }, 100, mediaFetch),
      ).rejects.toThrow(failure === "missing path" ? "file path" : "empty body")
      expect(api.getFile).toHaveBeenCalledOnce()
      expect(mediaFetch).toHaveBeenCalledTimes(failure === "missing path" ? 0 : 1)
    },
  )

  it.each(["getFile", "Content-Length", "stream"])(
    "enforces the %s byte limit on the second attempt",
    async (phase) => {
      const api = apiWithFile()
      vi.mocked(api.getFile)
        .mockResolvedValueOnce({ file_id: "file", file_unique_id: "unique", file_path: "file.bin" })
        .mockResolvedValueOnce({
          file_id: "file",
          file_unique_id: "unique",
          file_path: "file.bin",
          ...(phase === "getFile" ? { file_size: 11 } : {}),
        })
      const cancel = vi.fn()
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from("123456"))
          controller.enqueue(Buffer.from("789012"))
        },
        cancel,
      })
      const mediaFetch = vi
        .fn<typeof fetch>()
        .mockRejectedValueOnce(connectionReset())
        .mockResolvedValueOnce(
          new Response(body, {
            headers: phase === "Content-Length" ? { "content-length": "11" } : {},
          }),
        )

      await expect(
        downloadTelegramFile(api, "token", { fileId: "file" }, 10, mediaFetch),
      ).rejects.toBeInstanceOf(TelegramDownloadTooLargeError)
      expect(api.getFile).toHaveBeenCalledTimes(2)
      expect(mediaFetch).toHaveBeenCalledTimes(phase === "getFile" ? 1 : 2)
      if (phase !== "getFile") expect(cancel).toHaveBeenCalledOnce()
      expect(body.locked).toBe(false)
    },
  )
})

describe("Telegram download retry deadline and cancellation", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], fakeNodeBuiltins: true })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  function controlledDeadline() {
    return vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(new DOMException("timeout", "TimeoutError")), ms)
      return controller.signal
    })
  }

  it("waits exactly 250 ms and reuses one signal for both complete attempts", async () => {
    const timeout = controlledDeadline()
    const api = apiWithFile()
    const mediaFetch = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(connectionReset())
      .mockResolvedValueOnce(new Response("complete"))
    const pending = downloadTelegramFile(api, "token", { fileId: "file" }, 100, mediaFetch, 1_000)
    await vi.advanceTimersByTimeAsync(249)
    expect(api.getFile).toHaveBeenCalledOnce()
    expect(mediaFetch).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toEqual(Buffer.from("complete"))

    const signal = vi.mocked(api.getFile).mock.calls[0]?.[1]
    expect(signal).toBeDefined()
    expect(vi.mocked(api.getFile).mock.calls[1]?.[1]).toBe(signal)
    expect(mediaFetch.mock.calls.map(([, init]) => init?.signal)).toEqual([signal, signal])
    expect(timeout).toHaveBeenCalledExactlyOnceWith(1_000)
  })

  it("does not restart the total deadline after a slow first attempt", async () => {
    const timeout = controlledDeadline()
    const api = apiWithFile()
    const mediaFetch = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 600))
        throw connectionReset()
      })
      .mockImplementationOnce(
        async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            })
          }),
      )
    const pending = downloadTelegramFile(api, "token", { fileId: "file" }, 100, mediaFetch, 1_000)
    const rejected = expect(pending).rejects.toMatchObject({ name: "TimeoutError" })
    await vi.advanceTimersByTimeAsync(850)
    expect(api.getFile).toHaveBeenCalledTimes(2)
    expect(mediaFetch).toHaveBeenCalledTimes(2)
    expect(mediaFetch.mock.calls[1]?.[1]?.signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(150)
    await rejected
    expect(mediaFetch.mock.calls[1]?.[1]?.signal?.aborted).toBe(true)
    expect(timeout).toHaveBeenCalledExactlyOnceWith(1_000)
    const signal = vi.mocked(api.getFile).mock.calls[0]?.[1]
    expect(vi.mocked(api.getFile).mock.calls[1]?.[1]).toBe(signal)
    expect(mediaFetch.mock.calls.map(([, init]) => init?.signal)).toEqual([signal, signal])
  })

  it("expires during retry delay without another request", async () => {
    const timeout = controlledDeadline()
    const api = apiWithFile()
    const mediaFetch = vi.fn<typeof fetch>().mockRejectedValue(connectionReset())
    const pending = downloadTelegramFile(api, "token", { fileId: "file" }, 100, mediaFetch, 100)
    const rejected = expect(pending).rejects.toMatchObject({ name: "TimeoutError" })
    await vi.advanceTimersByTimeAsync(1_000)
    await rejected
    expect(api.getFile).toHaveBeenCalledOnce()
    expect(mediaFetch).toHaveBeenCalledOnce()
    expect(timeout).toHaveBeenCalledExactlyOnceWith(100)
  })

  it.each(["before delay", "during delay", "second attempt"])(
    "honors caller abort %s without another retry",
    async (phase) => {
      const api = apiWithFile()
      const controller = new AbortController()
      const reason = new DOMException("cancelled", "AbortError")
      const mediaFetch = vi
        .fn<typeof fetch>()
        .mockImplementationOnce(async () => {
          if (phase === "before delay") controller.abort(reason)
          throw connectionReset()
        })
        .mockImplementationOnce(
          async (_input, init) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
                once: true,
              })
            }),
        )
      const pending = downloadTelegramFile(
        api,
        "token",
        { fileId: "file" },
        100,
        mediaFetch,
        60_000,
        controller.signal,
      )
      const rejected = expect(pending).rejects.toBe(reason)
      await vi.advanceTimersByTimeAsync(phase === "second attempt" ? 250 : 0)
      controller.abort(reason)
      await rejected
      await vi.advanceTimersByTimeAsync(1_000)
      const attempts = phase === "second attempt" ? 2 : 1
      expect(api.getFile).toHaveBeenCalledTimes(attempts)
      expect(mediaFetch).toHaveBeenCalledTimes(attempts)
    },
  )
})

describe("Telegram download telemetry", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], fakeNodeBuiltins: true })
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(new DOMException("timeout", "TimeoutError")), ms)
      return controller.signal
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it("records both attempts and all streamed bytes after a recovered partial reset", async () => {
    const trace = downloadTrace()
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(Buffer.from("lost"))
        else controller.error(connectionReset())
      },
    })
    const api = apiWithFile()
    const mediaFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(body))
      .mockResolvedValueOnce(new Response("complete"))
    const pending = downloadTelegramFile(
      api,
      "private-token",
      { fileId: "private-file" },
      100,
      mediaFetch,
      1_000,
      undefined,
      trace.logger,
    )
    await vi.advanceTimersByTimeAsync(250)
    await expect(pending).resolves.toEqual(Buffer.from("complete"))
    expect(trace.spans).toEqual([
      {
        name: "telegram.download",
        attributes: {
          "download.max_bytes": 100,
          "download.attempts": 2,
          "download.bytes": 12,
          "download.phase": "stream",
          "download.outcome": "success",
          "operation.outcome": "success",
        },
      },
    ])
    expect(body.locked).toBe(false)
    expect(api.getFile).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(trace.spans)).not.toMatch(
      /private-token|private-file|documents\/file.bin|complete/,
    )
  })

  it("records exhausted retries without replacing the final error or repeating work", async () => {
    const trace = downloadTrace()
    const finalError = connectionReset()
    const api = apiWithFile()
    const mediaFetch = vi.fn<typeof fetch>().mockRejectedValue(finalError)
    const pending = downloadTelegramFile(
      api,
      "token",
      { fileId: "file" },
      100,
      mediaFetch,
      1_000,
      undefined,
      trace.logger,
    )
    const rejected = expect(pending).rejects.toBe(finalError)
    await vi.advanceTimersByTimeAsync(250)
    await rejected
    expect(trace.spans[0]?.attributes).toMatchObject({
      "download.attempts": 2,
      "download.bytes": 0,
      "download.phase": "fetch",
      "operation.outcome": "error",
    })
    expect(api.getFile).toHaveBeenCalledTimes(2)
    expect(mediaFetch).toHaveBeenCalledTimes(2)
  })

  it("records cancellation during backoff with only one attempt", async () => {
    const trace = downloadTrace()
    const controller = new AbortController()
    const api = apiWithFile()
    const mediaFetch = vi.fn<typeof fetch>().mockRejectedValue(connectionReset())
    const pending = downloadTelegramFile(
      api,
      "token",
      { fileId: "file" },
      100,
      mediaFetch,
      1_000,
      controller.signal,
      trace.logger,
    )
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" })
    await vi.advanceTimersByTimeAsync(100)
    controller.abort()
    await rejected
    expect(trace.spans[0]?.attributes).toMatchObject({
      "download.attempts": 1,
      "download.bytes": 0,
      "download.phase": "retry_wait",
      "operation.outcome": "cancelled",
    })
    expect(api.getFile).toHaveBeenCalledOnce()
  })

  it("keeps one deadline across the first attempt, retry delay and second stream", async () => {
    const trace = downloadTrace()
    const api = apiWithFile()
    const cancel = vi.fn()
    const mediaFetch = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 600))
        throw connectionReset()
      })
      .mockImplementationOnce(
        async (_input, init) =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(Buffer.from("part"))
                init?.signal?.addEventListener("abort", () => controller.close(), { once: true })
              },
              cancel,
            }),
          ),
      )
    const pending = downloadTelegramFile(
      api,
      "token",
      { fileId: "file" },
      100,
      mediaFetch,
      1_000,
      undefined,
      trace.logger,
    )
    const rejected = expect(pending).rejects.toMatchObject({ name: "TimeoutError" })
    await vi.advanceTimersByTimeAsync(999)
    expect(api.getFile).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    await rejected
    expect(AbortSignal.timeout).toHaveBeenCalledExactlyOnceWith(1_000)
    expect(trace.spans[0]?.attributes).toMatchObject({
      "download.attempts": 2,
      "download.bytes": 4,
      "download.phase": "stream",
      "operation.outcome": "error",
    })
    expect(mediaFetch.mock.calls[0]?.[1]?.signal).toBe(mediaFetch.mock.calls[1]?.[1]?.signal)
  })

  it.each(["metadata", "stream"])("records %s byte rejection", async (phase) => {
    const trace = downloadTrace()
    const api = apiWithFile()
    const mediaFetch = vi.fn<typeof fetch>(async () => new Response("123456"))
    await expect(
      downloadTelegramFile(
        api,
        "token",
        { fileId: "file", ...(phase === "metadata" ? { fileSize: 6 } : {}) },
        5,
        mediaFetch,
        1_000,
        undefined,
        trace.logger,
      ),
    ).rejects.toBeInstanceOf(TelegramDownloadTooLargeError)
    expect(trace.spans[0]?.attributes).toMatchObject({
      "download.attempts": phase === "metadata" ? 0 : 1,
      "download.bytes": phase === "metadata" ? 0 : 6,
      "download.phase": phase,
      "operation.outcome": "rejected",
    })
  })
})

describe("bounded Telegram file downloads", () => {
  it("rejects message metadata overflow before calling getFile", async () => {
    const api = apiWithFile()
    await expect(
      downloadTelegramFile(api, "token", { fileId: "file", fileSize: 11 }, 10),
    ).rejects.toBeInstanceOf(TelegramDownloadTooLargeError)
    expect(api.getFile).not.toHaveBeenCalled()
  })

  it("rejects getFile and Content-Length overflow before reading the body", async () => {
    await expect(
      downloadTelegramFile(apiWithFile({ file_size: 11 }), "token", { fileId: "file" }, 10),
    ).rejects.toBeInstanceOf(TelegramDownloadTooLargeError)

    const fetchImplementation = vi.fn<typeof fetch>(
      async () => new Response("small", { headers: { "content-length": "11" } }),
    )
    await expect(
      downloadTelegramFile(apiWithFile(), "token", { fileId: "file" }, 10, fetchImplementation),
    ).rejects.toBeInstanceOf(TelegramDownloadTooLargeError)
  })

  it("rejects streamed overflow when metadata is absent", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("123456"))
        controller.enqueue(Buffer.from("789012"))
        controller.close()
      },
    })
    await expect(
      downloadTelegramFile(
        apiWithFile(),
        "token",
        { fileId: "file" },
        10,
        async () => new Response(body),
      ),
    ).rejects.toBeInstanceOf(TelegramDownloadTooLargeError)
  })

  it("rejects redirects, non-2xx responses, missing paths, and empty bodies", async () => {
    const redirect = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.redirect).toBe("manual")
      return new Response(null, { status: 302, headers: { location: "http://127.0.0.1" } })
    })
    await expect(
      downloadTelegramFile(apiWithFile(), "token", { fileId: "file" }, 100, redirect),
    ).rejects.toThrow("HTTP 302")
    await expect(
      downloadTelegramFile(
        apiWithFile(),
        "token",
        { fileId: "file" },
        100,
        async () => new Response("no", { status: 500 }),
      ),
    ).rejects.toThrow("HTTP 500")
    await expect(
      downloadTelegramFile(apiWithFile({ file_path: undefined }), "token", { fileId: "file" }, 100),
    ).rejects.toThrow("file path")
    await expect(
      downloadTelegramFile(
        apiWithFile(),
        "token",
        { fileId: "file" },
        100,
        async () => new Response(null),
      ),
    ).rejects.toThrow("empty body")
  })

  it("applies a download timeout", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
      })
    })
    await expect(
      downloadTelegramFile(apiWithFile(), "token", { fileId: "file" }, 100, fetchImplementation, 1),
    ).rejects.toMatchObject({ name: "TimeoutError" })
  })

  it("cancels or times out a pending getFile before starting the media fetch", async () => {
    const getFile = vi.fn(
      (_fileId: string, requestSignal?: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          requestSignal?.addEventListener("abort", () => reject(requestSignal.reason), {
            once: true,
          })
        }),
    )
    const api = { getFile } as unknown as Api
    const fetchImplementation = vi.fn<typeof fetch>()
    const controller = new AbortController()
    const pending = downloadTelegramFile(
      api,
      "token",
      { fileId: "image" },
      100,
      fetchImplementation,
      60_000,
      controller.signal,
    )
    await vi.waitFor(() => expect(getFile).toHaveBeenCalledOnce())
    const passedSignal = getFile.mock.calls[0]?.[1]
    expect(passedSignal).toBeDefined()
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(passedSignal?.aborted).toBe(true)
    expect(fetchImplementation).not.toHaveBeenCalled()

    await expect(
      downloadTelegramFile(api, "token", { fileId: "image" }, 100, fetchImplementation, 1),
    ).rejects.toMatchObject({ name: "TimeoutError" })
    expect(getFile).toHaveBeenCalledTimes(2)
    expect(fetchImplementation).not.toHaveBeenCalled()
  })

  it("propagates a native cancellation signal through the real grammY getFile client", async () => {
    const telegramFetch = vi.fn<
      NonNullable<NonNullable<ConstructorParameters<typeof Api>[1]>["fetch"]>
    >(
      async (_input, init) =>
        new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("getFile aborted")))
        }),
    )
    const mediaFetch = vi.fn<typeof fetch>()
    const api = new Api("test-token", { fetch: telegramFetch })
    const controller = new AbortController()
    const pending = downloadTelegramImage(
      api,
      "test-token",
      { fileId: "image", filename: "image.jpg", mediaType: "image/jpeg" },
      100,
      mediaFetch,
      controller.signal,
    )
    await vi.waitFor(() => expect(telegramFetch).toHaveBeenCalledOnce())
    controller.abort()
    await expect(pending).rejects.toThrow()
    expect(mediaFetch).not.toHaveBeenCalled()
  })

  it("cancels on-demand image downloads before or during fetch", async () => {
    const controller = new AbortController()
    controller.abort()
    const api = apiWithFile()
    const fetchImplementation = vi.fn<typeof fetch>()
    await expect(
      downloadTelegramImage(
        api,
        "token",
        { fileId: "image", filename: "image.jpg", mediaType: "image/jpeg" },
        100,
        fetchImplementation,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(api.getFile).not.toHaveBeenCalled()

    const active = new AbortController()
    const waitingFetch = vi.fn<typeof fetch>(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
        }),
    )
    const pending = downloadTelegramImage(
      api,
      "token",
      { fileId: "image", filename: "image.jpg", mediaType: "image/jpeg" },
      100,
      waitingFetch,
      active.signal,
    )
    await vi.waitFor(() => expect(waitingFetch).toHaveBeenCalledOnce())
    active.abort()
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  })

  it("returns bytes and keeps the image wrapper behavior", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => new Response("hello"))
    await expect(
      downloadTelegramFile(apiWithFile(), "token", { fileId: "file" }, 100, fetchImplementation),
    ).resolves.toEqual(Buffer.from("hello"))
    await expect(
      downloadTelegramImage(
        apiWithFile(),
        "token",
        { fileId: "file", filename: "image.png", mediaType: "image/png" },
        100,
        fetchImplementation,
      ),
    ).resolves.toEqual({
      type: "image",
      data: Buffer.from("hello").toString("base64"),
      mimeType: "image/png",
    })
  })
})
