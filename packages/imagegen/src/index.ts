import { type DecodedImage, decodeImage, MAX_IMAGE_BYTES } from "./image.js"

export { type DecodedImage, decodeImage, MAX_IMAGE_BYTES } from "./image.js"
export const IMAGE_ENDPOINT = "https://chatgpt.com/backend-api/codex/images/generations"
export const MAX_RESPONSE_BYTES = 4 * Math.ceil(MAX_IMAGE_BYTES / 3) + 65_536
export const MAX_PROMPT_CHARS = 32_000
export type ImagegenFailure =
  | "auth"
  | "input"
  | "denied"
  | "quota"
  | "timeout"
  | "cancelled"
  | "response"
  | "transport"
const messages: Record<ImagegenFailure, string> = {
  auth: "Compatible Codex OAuth is unavailable. Sign in to openai-codex through Pi.",
  input: "The image prompt must contain 1 to 32,000 characters and cannot be blank.",
  denied: "Image access was denied. Check account entitlement and organization policy.",
  quota: "The image quota or rate limit was reached. Check account limits.",
  timeout: "Image generation timed out. No automatic retry was made; quota may still be consumed.",
  cancelled: "Image generation was cancelled. Remote generation and quota use may continue.",
  response: "The image endpoint returned an invalid or oversized image response.",
  transport: "Image generation failed. No automatic retry was made; quota may still be consumed.",
}
export class ImagegenError extends Error {
  constructor(readonly kind: ImagegenFailure) {
    super(messages[kind])
    this.name = "ImagegenError"
  }
}
function fail(kind: ImagegenFailure): never {
  throw new ImagegenError(kind)
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
export function isCanonicalCodexRoot(value: unknown): boolean {
  return [
    "https://chatgpt.com/backend-api",
    "https://chatgpt.com/backend-api/",
    "https://chatgpt.com/backend-api/codex",
    "https://chatgpt.com/backend-api/codex/",
  ].includes(value as string)
}
/** Parse the account header, not the JWT signature. Pi and the server own authentication. */
function account(token: unknown): { token: string; accountId: string } {
  if (typeof token !== "string" || token.length > 32_768) fail("auth")
  const parts = token.split(".")
  if (parts.length !== 3 || parts.some((p) => p.length % 4 === 1 || !/^[A-Za-z0-9_-]+$/.test(p)))
    fail("auth")
  try {
    const header: unknown = JSON.parse(Buffer.from(parts[0] ?? "", "base64url").toString("utf8"))
    const payload: unknown = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"))
    if (
      !object(header) ||
      typeof header.alg !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(header.alg) ||
      header.alg.toLowerCase() === "none"
    )
      fail("auth")
    const claim = object(payload) ? payload["https://api.openai.com/auth"] : undefined
    const id = object(claim) ? claim.chatgpt_account_id : undefined
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(id)) fail("auth")
    return { token, accountId: id }
  } catch {
    return fail("auth")
  }
}
export interface ImagegenOptions {
  resolveAuth(signal: AbortSignal): Promise<{ accessToken: string }>
  signal?: AbortSignal
  fetch?: typeof fetch
}
function closeBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => {})
  } catch {
    /* Best-effort release. */
  }
}
/** One fixed-destination request. No automatic generation retry or credential fallback. */
export async function generateImage(
  request: { prompt: string },
  options: ImagegenOptions,
): Promise<DecodedImage & { requestId?: string }> {
  const controller = new AbortController()
  const abort = (kind: ImagegenFailure) => {
    if (!controller.signal.aborted) controller.abort(new ImagegenError(kind))
  }
  const onAbort = () => abort("cancelled")
  options.signal?.addEventListener("abort", onAbort, { once: true })
  const expiresAt = Date.now() + 300_000
  const timer = setTimeout(() => abort("timeout"), 300_000)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let response: Response | undefined
  const check = () => {
    if (options.signal?.aborted) abort("cancelled")
    if (Date.now() >= expiresAt) abort("timeout")
    controller.signal.throwIfAborted()
  }
  const wait = <T>(promise: Promise<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      const aborted = () => reject(controller.signal.reason)
      controller.signal.addEventListener("abort", aborted, { once: true })
      if (controller.signal.aborted) aborted()
      promise
        .then(resolve, reject)
        .finally(() => controller.signal.removeEventListener("abort", aborted))
    })
  try {
    check()
    if (
      typeof request.prompt !== "string" ||
      !request.prompt.trim() ||
      request.prompt.length > MAX_PROMPT_CHARS
    )
      fail("input")
    let auth: { accessToken: string }
    const authTimer = setTimeout(() => abort("timeout"), 30_000)
    try {
      auth = await wait(options.resolveAuth(controller.signal))
    } catch {
      check()
      return fail("auth")
    } finally {
      clearTimeout(authTimer)
    }
    check()
    const { token, accountId } = account(auth.accessToken)
    const pending = (options.fetch ?? globalThis.fetch)(IMAGE_ENDPOINT, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "ChatGPT-Account-ID": accountId,
        originator: "sumire-imagegen",
        "User-Agent": "sumire-imagegen",
      },
      body: JSON.stringify({
        prompt: request.prompt,
        model: "gpt-image-2",
        quality: "auto",
        size: "auto",
        background: "opaque",
      }),
    })
    void pending.then(
      (late) => {
        if (controller.signal.aborted) closeBody(late)
      },
      () => {},
    )
    response = await wait(pending)
    check()
    if (response.redirected) fail("response")
    if (!response.ok) {
      if (response.status === 401) fail("auth")
      if (response.status === 403) fail("denied")
      if (response.status === 429) fail("quota")
      if (response.status >= 300 && response.status < 400) fail("response")
      fail("transport")
    }
    if (
      response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
      "application/json"
    )
      fail("response")
    const length = response.headers.get("content-length")
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES))
      fail("response")
    if (!response.body) fail("response")
    reader = response.body.getReader()
    let body = Buffer.allocUnsafe(65_536)
    let size = 0
    for (;;) {
      const chunk = await wait(reader.read())
      check()
      if (chunk.done) break
      const next = size + chunk.value.byteLength
      if (next > MAX_RESPONSE_BYTES) fail("response")
      if (next > body.byteLength) {
        const grown = Buffer.allocUnsafe(
          Math.min(MAX_RESPONSE_BYTES, Math.max(next, body.byteLength * 2)),
        )
        body.copy(grown, 0, 0, size)
        body = grown
      }
      body.set(chunk.value, size)
      size = next
    }
    let result: unknown
    try {
      result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.subarray(0, size)))
    } catch {
      fail("response")
    }
    check()
    if (!object(result) || !Array.isArray(result.data) || result.data.length !== 1) fail("response")
    const image: unknown = result.data[0]
    if (!object(image) || typeof image.b64_json !== "string") fail("response")
    let decoded: DecodedImage
    try {
      decoded = decodeImage(image.b64_json)
    } catch {
      return fail("response")
    }
    check()
    const id = response.headers.get("x-codex-imagegen-request-id")
    return { ...decoded, ...(id && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? { requestId: id } : {}) }
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason
    if (error instanceof ImagegenError) throw error
    return fail("transport")
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener("abort", onAbort)
    if (reader) {
      try {
        void reader.cancel().catch(() => {})
        reader.releaseLock()
      } catch {
        /* Best-effort release. */
      }
    } else if (response) closeBody(response)
  }
}
