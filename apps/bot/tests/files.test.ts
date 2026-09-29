import { Api } from "grammy"
import { describe, expect, it, vi } from "vitest"

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
