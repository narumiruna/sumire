import { getFailureDiagnostic } from "./errors.js"
import {
  BODY_CHUNK_BYTES,
  FrameReader,
  frame,
  type ImpersMetadata,
  type ImpersRequest,
  MAX_HEADER_BYTES,
  record,
  requestId,
  validRequest,
} from "./impers-protocol.js"

// This entrypoint is private. It must never run impers I/O under Bun.
if (process.versions.bun || Number(process.versions.node.split(".")[0]) < 26) process.exit(1)

const active = new Map<number, AbortController>()
let session: import("impers").Session | undefined
let stopping = false
const send = (value: unknown) => process.stdout.write(frame(value))
const stop = async () => {
  if (stopping) return
  stopping = true
  for (const controller of active.values()) controller.abort()
  try {
    await session?.close()
  } finally {
    process.exit(0)
  }
}
// Register before loading the native library, including its optional first-use download.
process.stdin.once("end", () => void stop())
process.stdin.once("error", () => process.exit(1))
process.stdout.once("error", () => process.exit(1))
process.once("SIGTERM", () => void stop())
process.stdin.resume()

const { Session } = await import("impers")
session = new Session({ impersonate: "chrome" })
const reader = new FrameReader()
process.stdin.on("data", (chunk: Buffer) => {
  try {
    reader.push(chunk, (message) => {
      if (!record(message) || !requestId(message.id)) throw new Error("Invalid command")
      if (message.type === "cancel") {
        active.get(message.id)?.abort()
      } else if (
        message.type === "get" &&
        validRequest(message.request) &&
        !active.has(message.id)
      ) {
        const controller = new AbortController()
        active.set(message.id, controller)
        void get(message.id, message.request, controller)
      } else {
        throw new Error("Invalid command")
      }
    })
  } catch {
    process.exit(1)
  }
})
send({ type: "ready" })

async function get(id: number, request: ImpersRequest, controller: AbortController): Promise<void> {
  let bodyBytes = 0
  let headerBytes = 0
  let limited = false
  let response: import("impers").Response | undefined
  let terminal: unknown
  try {
    if (!session) throw new Error("Impers session is unavailable")
    response = await session.get(request.url, {
      impersonate: request.impersonate,
      timeout: request.timeoutSeconds,
      headers: request.headers,
      proxy: request.proxy,
      // Never allow ambient NO_PROXY to bypass the parent's pinned public proxy.
      curlOptions: { 10177: "" },
      allowRedirects: false,
      acceptEncoding: "identity",
      stream: true,
      signal: controller.signal,
      headerCallback: (chunk: Buffer) => {
        headerBytes += chunk.byteLength
        if (headerBytes > MAX_HEADER_BYTES) {
          limited = true
          controller.abort()
        }
      },
      contentCallback: (chunk: Buffer) => {
        bodyBytes += chunk.byteLength
        if (bodyBytes > request.maxBytes) {
          limited = true
          controller.abort()
        }
        if (controller.signal.aborted) return
        for (let offset = 0; offset < chunk.length; offset += BODY_CHUNK_BYTES) {
          send({
            type: "chunk",
            id,
            data: chunk.subarray(offset, offset + BODY_CHUNK_BYTES).toString("base64"),
          })
        }
      },
    })
    const metadata: ImpersMetadata = {
      status: response.status,
      statusText: response.statusText,
      url: response.url,
      headers: [...response.headers],
      elapsed: response.elapsed,
      primaryIp: response.primaryIp,
      primaryPort: response.primaryPort,
      localIp: response.localIp,
      localPort: response.localPort,
      redirectCount: response.redirectCount,
      redirectUrl: response.redirectUrl,
      httpVersion: response.httpVersion,
    }
    terminal = { type: "complete", id, metadata }
    // Bound encoded header and URL metadata before it enters stdout.
    frame(terminal)
  } catch (error) {
    terminal = {
      type: "failure",
      id,
      code: limited
        ? "response_limit"
        : getFailureDiagnostic(error).code === "tls_certificate"
          ? "tls_certificate"
          : "transport_failure",
    }
  } finally {
    try {
      await response?.close()
    } catch {
      terminal = { type: "failure", id, code: "transport_failure" }
    }
    active.delete(id)
  }
  // A terminal frame acknowledges that native request work and cleanup have stopped.
  if (!stopping) send(terminal)
}
