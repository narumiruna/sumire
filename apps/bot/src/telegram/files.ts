import { setTimeout as delay } from "node:timers/promises"

import { type Api, GrammyError, HttpError } from "grammy"

import {
  errorAttributes,
  isCancellation,
  type Logger,
  setSpanError,
  withLogSpan,
} from "../logging.js"
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
  logger?: Logger,
): Promise<Uint8Array> {
  return withLogSpan(
    logger,
    "telegram.download",
    { "download.max_bytes": maxBytes },
    async (span) => {
      let attempts = 0
      // Count all streamed bytes, including discarded partial attempts and overflow chunks.
      const progress = { bytes: 0, phase: "metadata" }
      try {
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
            if (attempt > 0) {
              progress.phase = "retry_wait"
              await delay(250, undefined, { signal: requestSignal })
            }
            attempts++
            const bytes = await downloadAttempt(
              api,
              token,
              reference,
              maxBytes,
              fetchImplementation,
              requestSignal,
              progress,
            )
            requestSignal.throwIfAborted()
            span.setAttribute("operation.outcome", "success")
            span.setAttribute("download.outcome", "success")
            return bytes
          } catch (error) {
            requestSignal.throwIfAborted()
            if (attempt > 0 || !isConnectionReset(error)) throw error
          }
        }
      } catch (error) {
        const metadata = errorAttributes(error)
        const cancelled = signal?.aborted || isCancellation(error)
        if (cancelled) {
          for (const [key, value] of Object.entries(metadata)) span.setAttribute(key, value)
          span.setAttribute("operation.outcome", "cancelled")
          span.setAttribute("download.outcome", "cancelled")
        } else {
          if (!(error instanceof TelegramDownloadTooLargeError)) setSpanError(span, error)
          const outcome = error instanceof TelegramDownloadTooLargeError ? "rejected" : "error"
          span.setAttribute("operation.outcome", outcome)
          span.setAttribute("download.outcome", outcome)
        }
        throw error
      } finally {
        span.setAttribute("download.attempts", attempts)
        span.setAttribute("download.bytes", progress.bytes)
        span.setAttribute("download.phase", progress.phase)
      }
    },
  )
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
  progress: { bytes: number; phase: string },
): Promise<Uint8Array> {
  progress.phase = "get_file"
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

  progress.phase = "fetch"
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

    progress.phase = "stream"
    const reader = body.getReader()
    try {
      const chunks: Uint8Array[] = []
      let received = 0
      while (true) {
        const { done, value } = await reader.read()
        if (!done) progress.bytes += value.byteLength
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
  logger?: Logger,
): Promise<{ type: "image"; data: string; mimeType: string }> {
  const content = await downloadTelegramFile(
    api,
    token,
    reference,
    maxBytes,
    fetchImplementation,
    60_000,
    signal,
    logger,
  )
  return {
    type: "image",
    data: Buffer.from(content).toString("base64"),
    mimeType: reference.mediaType,
  }
}
