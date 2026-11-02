// Private, bounded protocol for the Node.js impers host. No upstream error text crosses it.
export const MAX_FRAME_BYTES = 64 * 1024
export const MAX_BODY_BYTES = 25 * 1024 * 1024
export const BODY_CHUNK_BYTES = 24 * 1024
export const MAX_HEADER_BYTES = 16 * 1024

export interface ImpersRequest {
  url: string
  proxy: string
  impersonate: string
  headers: Record<string, string>
  timeoutSeconds: number
  maxBytes: number
}

export interface ImpersMetadata {
  status: number
  statusText: string
  url: string
  headers: [string, string][]
  elapsed: number
  primaryIp: string | null
  primaryPort: number
  localIp: string | null
  localPort: number
  redirectCount: number
  redirectUrl: string | null
  httpVersion: number
}

export interface ImpersReply extends ImpersMetadata {
  content: Buffer
}

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function requestId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

export function validRequest(value: unknown): value is ImpersRequest {
  if (!record(value)) return false
  try {
    const url = new URL(String(value.url))
    const proxy = new URL(String(value.proxy))
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      proxy.protocol !== "http:" ||
      proxy.hostname !== "127.0.0.1" ||
      !proxy.port ||
      proxy.username ||
      proxy.password ||
      proxy.pathname !== "/" ||
      proxy.search ||
      proxy.hash
    )
      return false
  } catch {
    return false
  }
  return (
    typeof value.url === "string" &&
    typeof value.proxy === "string" &&
    typeof value.impersonate === "string" &&
    value.impersonate.length <= 128 &&
    record(value.headers) &&
    Object.values(value.headers).every((v) => typeof v === "string") &&
    typeof value.timeoutSeconds === "number" &&
    Number.isFinite(value.timeoutSeconds) &&
    value.timeoutSeconds > 0 &&
    value.timeoutSeconds <= 3_600 &&
    Number.isSafeInteger(value.maxBytes) &&
    Number(value.maxBytes) >= 0 &&
    Number(value.maxBytes) <= MAX_BODY_BYTES
  )
}

export function validMetadata(value: unknown): value is ImpersMetadata {
  if (!record(value)) return false
  return (
    Number.isInteger(value.status) &&
    Number(value.status) >= 100 &&
    Number(value.status) <= 599 &&
    typeof value.statusText === "string" &&
    typeof value.url === "string" &&
    Array.isArray(value.headers) &&
    value.headers.every(
      (pair) =>
        Array.isArray(pair) && pair.length === 2 && pair.every((v) => typeof v === "string"),
    ) &&
    ["elapsed", "primaryPort", "localPort", "redirectCount", "httpVersion"].every(
      (key) =>
        typeof value[key] === "number" && Number.isFinite(value[key]) && Number(value[key]) >= 0,
    ) &&
    ["primaryIp", "localIp", "redirectUrl"].every(
      (key) => value[key] === null || typeof value[key] === "string",
    )
  )
}

export function frame(value: unknown): string {
  const line = JSON.stringify(value)
  if (Buffer.byteLength(line) > MAX_FRAME_BYTES)
    throw new Error("Impers protocol frame exceeded limit")
  return `${line}\n`
}

/** Enforce the frame limit before JSON parsing, including partial and coalesced reads. */
export class FrameReader {
  private buffered = Buffer.alloc(0)

  push(chunk: Buffer, accept: (value: unknown) => void): void {
    let offset = 0
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset)
      const end = newline === -1 ? chunk.length : newline
      const part = chunk.subarray(offset, end)
      if (this.buffered.length + part.length > MAX_FRAME_BYTES)
        throw new Error("Impers protocol frame exceeded limit")
      this.buffered = Buffer.concat([this.buffered, part])
      if (newline === -1) return
      const line = this.buffered
      this.buffered = Buffer.alloc(0)
      accept(JSON.parse(line.toString("utf8")))
      offset = end + 1
    }
  }
}
