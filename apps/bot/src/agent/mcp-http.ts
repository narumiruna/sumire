import type { McpFetch } from "@earendil-works/pi-mcp"
import { MCP_MAX_MESSAGE_BYTES } from "./mcp-results.js"

/** Pi 1.0.2 bounds SSE events, but not JSON/error bodies; bound those before response.json/text. */
export function boundedMcpFetch(timeoutMs: number, request: McpFetch = fetch): McpFetch {
  return async (url, init) => {
    const deadline = new AbortController()
    const timer = setTimeout(
      () => deadline.abort(new DOMException("MCP HTTP request timed out", "TimeoutError")),
      timeoutMs,
    )
    timer.unref()
    const signal = init?.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal
    const clearDeadline = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", clearDeadline)
    }
    signal.addEventListener("abort", clearDeadline, { once: true })
    if (signal.aborted) clearDeadline()
    let response: Response
    try {
      response = await request(url, { ...init, signal, redirect: "error" })
    } catch (error) {
      clearDeadline()
      throw error
    }
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
    const sse = response.ok && mediaType === "text/event-stream"
    // Pi owns GET stream lifetime (including resumption); keep only its header wait bounded.
    // POST responses and GET error/non-SSE bodies retain their absolute request deadline.
    if (!response.body || (sse && (init?.method ?? "GET").toUpperCase() === "GET")) {
      clearDeadline()
      return response
    }
    const reader = response.body.getReader()
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      clearDeadline()
      reader.releaseLock()
    }
    let bytes = 0
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read()
          if (finished) return
          if (done) {
            finish()
            controller.close()
            return
          }
          bytes += value.byteLength
          if (!sse && bytes > MCP_MAX_MESSAGE_BYTES)
            throw new Error("MCP HTTP response exceeds the byte limit")
          controller.enqueue(value)
        } catch (error) {
          if (finished) return
          void reader.cancel(error).catch(() => {})
          finish()
          controller.error(error)
        }
      },
      cancel(reason) {
        const cancelled = reader.cancel(reason)
        finish()
        return cancelled
      },
    })
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
}
