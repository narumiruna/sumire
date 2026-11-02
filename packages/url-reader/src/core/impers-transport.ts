import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

import {
  BODY_CHUNK_BYTES,
  FrameReader,
  frame,
  type ImpersReply,
  type ImpersRequest,
  record,
  requestId,
  validMetadata,
  validRequest,
} from "./impers-protocol.js"

export type { ImpersReply, ImpersRequest } from "./impers-protocol.js"

interface Pending {
  id: number
  request: ImpersRequest
  resolve: (reply: ImpersReply) => void
  reject: (reason: unknown) => void
  chunks: Buffer[]
  bytes: number
  sent: boolean
  cancelled: boolean
  reason?: unknown
  failure?: Error
  signal?: AbortSignal
  onAbort: () => void
  timer: ReturnType<typeof setTimeout>
  cancelTimer?: ReturnType<typeof setTimeout>
}

function transportError(): Error {
  return Object.assign(new Error("Impers Node.js transport failed"), { code: "ECONNRESET" })
}

/** Only library/runtime settings cross this boundary, never bot credentials or NODE_OPTIONS. */
export function impersHostEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of [
    "PATH",
    "HOME",
    "XDG_CACHE_HOME",
    "IMPER_CACHE_DIR",
    "IMPER_DOWNLOAD_LIBCURL",
    "LIBCURL_PATH",
    "LIBCURL_IMPERSONATE_PATH",
    "LD_LIBRARY_PATH",
    "DYLD_LIBRARY_PATH",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "CURL_CA_BUNDLE",
  ]) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  return env
}

/** A client-owned Node host. Each terminal frame acknowledges native request cleanup. */
export class NodeImpersTransport {
  private child?: ChildProcessWithoutNullStreams
  private exited?: Promise<void>
  private ready = false
  private stopping = false
  private failed = false
  private nextId = 1
  private readonly pending = new Map<number, Pending>()

  // The launcher is an internal test seam, not a runtime configuration option.
  constructor(private readonly launch: typeof spawn = spawn) {}

  get unusable(): boolean {
    return this.stopping || this.failed
  }

  get(request: ImpersRequest, signal?: AbortSignal): Promise<ImpersReply> {
    signal?.throwIfAborted()
    if (this.unusable) return Promise.reject(transportError())
    if (!validRequest(request)) return Promise.reject(new TypeError("Invalid impers request"))
    const id = this.nextId++
    // Check the request frame before spawning or retaining any request resources.
    try {
      frame({ type: "get", id, request })
    } catch (error) {
      return Promise.reject(error)
    }
    return new Promise((resolve, reject) => {
      const operation: Pending = {
        id,
        request,
        resolve,
        reject,
        chunks: [],
        bytes: 0,
        sent: false,
        cancelled: false,
        signal,
        onAbort: () => this.cancel(operation, signal?.reason),
        timer: setTimeout(
          () =>
            this.cancel(
              operation,
              Object.assign(new Error("Impers request timed out"), { code: "ETIMEDOUT" }),
            ),
          Math.max(1, Math.ceil(request.timeoutSeconds * 1_000)),
        ),
      }
      operation.timer.unref()
      this.pending.set(id, operation)
      signal?.addEventListener("abort", operation.onAbort, { once: true })
      if (signal?.aborted) {
        operation.onAbort()
        return
      }
      try {
        this.start()
        if (this.ready) this.submit(operation)
      } catch {
        this.failed = true
        if (this.child) this.fail()
        else this.finish(operation, transportError())
      }
    })
  }

  private start(): void {
    if (this.child) return
    const child = this.launch(
      "node",
      [fileURLToPath(new URL("./impers-host.js", import.meta.url))],
      {
        env: impersHostEnvironment(),
        stdio: ["pipe", "pipe", "pipe"],
        // Do not inherit Node startup arguments from the parent.
        windowsHide: true,
      },
    )
    this.child = child
    this.exited = new Promise((resolve) => {
      child.once("close", () => {
        this.failed = true
        for (const operation of this.pending.values())
          this.finish(operation, operation.failure ?? transportError())
        resolve()
      })
    })
    const reader = new FrameReader()
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.failed) return
      try {
        reader.push(chunk, (message) => this.receive(message))
      } catch {
        this.fail()
      }
    })
    // Drain bounded OS chunks, but never retain or export native stderr or its URLs.
    child.stderr.on("data", () => undefined)
    child.once("error", () => this.fail())
    child.stdin.on("error", () => this.fail())
    child.stdout.on("error", () => this.fail())
    child.stderr.on("error", () => this.fail())
  }

  private submit(operation: Pending): void {
    if (operation.sent || operation.cancelled || this.unusable) return
    operation.sent = true
    this.send({ type: "get", id: operation.id, request: operation.request })
  }

  private send(message: unknown): void {
    try {
      this.child?.stdin.write(frame(message), (error) => {
        if (error) this.fail()
      })
    } catch {
      this.fail()
    }
  }

  private receive(message: unknown): void {
    // A coalesced stdout read can contain more frames after fail() killed the host.
    // None may settle a request before the close event confirms process exit.
    if (this.failed) return
    if (!record(message)) throw new Error("Invalid impers frame")
    if (message.type === "ready" && !this.ready) {
      this.ready = true
      for (const operation of this.pending.values()) this.submit(operation)
      return
    }
    if (!this.ready || !requestId(message.id)) throw new Error("Invalid impers frame")
    const operation = this.pending.get(message.id)
    if (!operation?.sent) throw new Error("Unknown impers request")
    if (
      message.type === "chunk" &&
      typeof message.data === "string" &&
      message.data.length <= Math.ceil(BODY_CHUNK_BYTES / 3) * 4
    ) {
      const chunk = Buffer.from(message.data, "base64")
      if (chunk.toString("base64") !== message.data) throw new Error("Invalid body frame")
      operation.bytes += chunk.length
      if (operation.bytes > operation.request.maxBytes) {
        operation.failure = new Error("Impers response exceeds body byte limit")
        this.fail()
      } else if (!operation.cancelled) {
        operation.chunks.push(chunk)
      }
    } else if (message.type === "complete" && validMetadata(message.metadata)) {
      this.finish(operation, undefined, {
        ...message.metadata,
        content: operation.cancelled
          ? Buffer.alloc(0)
          : Buffer.concat(operation.chunks, operation.bytes),
      })
    } else if (
      message.type === "failure" &&
      ["tls_certificate", "transport_failure", "response_limit"].includes(String(message.code))
    ) {
      const error =
        message.code === "response_limit"
          ? new Error("Impers response exceeds body or header byte limit")
          : transportError()
      if (message.code === "tls_certificate") {
        error.name = "CertificateVerifyError"
        // A certificate failure must not also masquerade as a transport reset.
        Reflect.deleteProperty(error, "code")
      }
      this.finish(operation, error)
    } else {
      throw new Error("Invalid impers frame")
    }
  }

  private cancel(operation: Pending, reason: unknown): void {
    if (!this.pending.has(operation.id) || operation.cancelled) return
    operation.cancelled = true
    operation.reason = reason
    operation.chunks = []
    clearTimeout(operation.timer)
    if (!operation.sent) {
      // Do not keep a stalled native initialization alive once nobody is waiting for it.
      // Other startup requests retain their own budgets and must not be cancelled here.
      if (this.child && !this.ready && this.pending.size === 1) this.fail()
      else this.finish(operation)
      return
    }
    this.send({ type: "cancel", id: operation.id })
    // A non-cooperative native request cannot retain admission capacity indefinitely.
    operation.cancelTimer = setTimeout(() => this.fail(), 1_000)
    operation.cancelTimer.unref()
  }

  private finish(operation: Pending, error?: unknown, reply?: ImpersReply): void {
    if (!this.pending.delete(operation.id)) return
    clearTimeout(operation.timer)
    clearTimeout(operation.cancelTimer)
    operation.signal?.removeEventListener("abort", operation.onAbort)
    operation.chunks = []
    if (operation.cancelled) operation.reject(operation.reason)
    else if (error !== undefined) operation.reject(error)
    else if (reply) operation.resolve(reply)
    else operation.reject(transportError())
  }

  private fail(): void {
    this.failed = true
    // Pending requests settle in close, after the process can no longer do network work.
    this.child?.kill("SIGKILL")
  }

  async close(): Promise<void> {
    if (this.stopping) return this.exited
    this.stopping = true
    if (!this.child) return
    this.child.stdin.end()
    const timer = setTimeout(() => this.child?.kill("SIGKILL"), 1_000)
    timer.unref()
    try {
      await this.exited
    } finally {
      clearTimeout(timer)
    }
  }
}
