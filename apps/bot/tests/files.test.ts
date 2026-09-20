import type { Api } from "grammy"
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
