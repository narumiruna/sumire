import { setTimeout as delay } from "node:timers/promises"

import { type Api, GrammyError, HttpError } from "grammy"

import type { ImageReference } from "./messages.js"

export class TelegramDownloadTooLargeError extends Error {}

export interface TelegramFileReference {
  fileId: string
  fileSize?: number
}

export async function downloadTelegramFile(
  api: Api,
  token: string,
  reference: TelegramFileReference,
  maxBytes: number,
  fetchImplementation: typeof fetch = fetch,
  timeoutMs = 60_000,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  signal?.throwIfAborted()
  if (reference.fileSize !== undefined && reference.fileSize > maxBytes) {
    throw new TelegramDownloadTooLargeError("Telegram file exceeds the configured byte limit")
  }
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs)
  for (let attempt = 0; ; attempt++) {
    try {
      requestSignal.throwIfAborted()
      if (attempt > 0) await delay(250, undefined, { signal: requestSignal })
      const bytes = await downloadAttempt(
        api,
        token,
        reference,
        maxBytes,
        fetchImplementation,
        requestSignal,
      )
      requestSignal.throwIfAborted()
      return bytes
    } catch (error) {
      requestSignal.throwIfAborted()
      if (attempt > 0 || !isConnectionReset(error)) throw error
    }
  }
}

function isConnectionReset(error: unknown): boolean {
  let foundReset = false
  // Fail closed for excessively deep or cyclic error wrappers.
  for (let depth = 0; depth < 8; depth++) {
    if (typeof error !== "object" || error === null) return foundReset
    if (
      error instanceof TelegramDownloadTooLargeError ||
      error instanceof GrammyError ||
      ("name" in error && (error.name === "AbortError" || error.name === "TimeoutError"))
    ) {
      return false
    }
    if ("code" in error && error.code === "ECONNRESET") foundReset = true
    error = error instanceof HttpError ? error.error : "cause" in error ? error.cause : undefined
  }
  return false
}

async function downloadAttempt(
  api: Api,
  token: string,
  reference: TelegramFileReference,
  maxBytes: number,
  fetchImplementation: typeof fetch,
  signal: AbortSignal,
): Promise<Uint8Array> {
  // grammY's signal declaration uses abort-controller types; its runtime accepts native AbortSignal.
  const file = await api.getFile(
    reference.fileId,
    signal as unknown as Parameters<Api["getFile"]>[1],
  )
  signal.throwIfAborted()
  if (!file.file_path) throw new Error("Telegram did not return a file path")
  if (file.file_size !== undefined && file.file_size > maxBytes) {
    throw new TelegramDownloadTooLargeError("Telegram file exceeds the configured byte limit")
  }

  const response = await fetchImplementation(
    `https://api.telegram.org/file/bot${token}/${file.file_path}`,
    { redirect: "manual", signal },
  )
  const body = response.body
  try {
    signal.throwIfAborted()
    if (!response.ok) throw new Error(`Telegram file download failed with HTTP ${response.status}`)
    const declaredLength = Number(response.headers.get("content-length"))
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new TelegramDownloadTooLargeError("Telegram file exceeds the configured byte limit")
    }
    if (!body) throw new Error("Telegram file download returned an empty body")

    const reader = body.getReader()
    try {
      const chunks: Uint8Array[] = []
      let received = 0
      while (true) {
        const { done, value } = await reader.read()
        signal.throwIfAborted()
        if (done) break
        received += value.byteLength
        if (received > maxBytes) {
          throw new TelegramDownloadTooLargeError("Telegram file exceeds the configured byte limit")
        }
        chunks.push(value)
      }
      if (received === 0) throw new Error("Telegram file download returned an empty body")
      return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
    } finally {
      reader.releaseLock()
    }
  } finally {
    await body?.cancel().catch(() => {})
  }
}

export async function downloadTelegramImage(
  api: Api,
  token: string,
  reference: ImageReference,
  maxBytes: number,
  fetchImplementation: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<{ type: "image"; data: string; mimeType: string }> {
  const content = await downloadTelegramFile(
    api,
    token,
    reference,
    maxBytes,
    fetchImplementation,
    60_000,
    signal,
  )
  return {
    type: "image",
    data: Buffer.from(content).toString("base64"),
    mimeType: reference.mediaType,
  }
}
