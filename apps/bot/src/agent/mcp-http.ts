import type { McpFetch } from "@earendil-works/pi-mcp"
import { MCP_MAX_MESSAGE_BYTES } from "./mcp-results.js"

/** Pi 1.0.2 bounds SSE events, but not JSON/error bodies; bound those before response.json/text. */
export function boundedMcpFetch(timeoutMs: number, request: McpFetch = fetch): McpFetch {
  return async (url, init) => {
    const deadline = AbortSignal.timeout(timeoutMs)
    const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline
    const response = await request(url, { ...init, signal, redirect: "error" })
    if (!response.body || response.headers.get("content-type")?.includes("text/event-stream"))
      return response
    let bytes = 0
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytes += chunk.byteLength
          if (bytes > MCP_MAX_MESSAGE_BYTES)
            throw new Error("MCP HTTP response exceeds the byte limit")
          controller.enqueue(chunk)
        },
      }),
    )
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
}
