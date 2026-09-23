import { createHmac, randomBytes } from "node:crypto"

import type { LoadedUrl } from "@narumitw/sumire-url-tool"

import { type Logger, withLogSpan } from "./logging.js"

// A process-local key prevents offline guessing of private URL paths or query parameters.
const fingerprintKey = randomBytes(32)

export function urlFingerprint(value: string): string {
  return createHmac("sha256", fingerprintKey).update(value).digest("hex")
}

export function singleUrlFingerprint(text: string): string | undefined {
  if (!/^https?:\/\//iu.test(text)) return undefined
  try {
    const url = new URL(text)
    if (url.username || url.password || /\s/u.test(text)) return undefined
    return urlFingerprint(text)
  } catch {
    return undefined
  }
}

export function traceUrlLoad(
  logger: Logger,
  url: string,
  requestedLoader: string | undefined,
  toolCallId: string,
  load: () => Promise<LoadedUrl>,
): Promise<LoadedUrl> {
  return withLogSpan(
    logger,
    "url.load",
    {
      "url.fingerprint": urlFingerprint(url),
      "url.requested_loader": requestedLoader ?? "auto",
      "pi.tool_call_id": toolCallId,
    },
    async (span) => {
      try {
        const result = await load()
        span.setAttribute("url.outcome", "success")
        span.setAttribute("url.source", result.source)
        span.setAttribute("url.loader", result.loaderId ?? "none")
        span.setAttribute("url.truncated", result.truncated)
        span.setAttribute("url.content_chars", result.text.length)
        if (result.status !== undefined) span.setAttribute("url.http_status", result.status)
        const host = loadedUrlHost(result.finalUrl)
        if (host) {
          span.setAttribute("url.host", host)
          span.setAttribute("url.final_fingerprint", urlFingerprint(result.finalUrl))
        }
        return result
      } catch (error) {
        span.setAttribute("url.outcome", "error")
        span.setAttribute("url.error_type", error instanceof Error ? error.name : "unknown")
        throw error
      }
    },
  )
}

export function loadedUrlHost(value: string): string | undefined {
  try {
    const url = new URL(value)
    return /^https?:$/u.test(url.protocol) && !url.username && !url.password
      ? url.hostname.slice(0, 253)
      : undefined
  } catch {
    return undefined
  }
}
