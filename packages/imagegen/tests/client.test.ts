import { afterEach, expect, it, vi } from "vitest"
import { generateImage, IMAGE_ENDPOINT, ImagegenError, MAX_RESPONSE_BYTES } from "../src/index.js"
import { PNG } from "./fixtures.js"

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
const token = `${encode({ alg: "RS256" })}.${encode({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })}.${encode("synthetic")}`
const auth = async () => ({ accessToken: token })
const response = (body: unknown = { data: [{ b64_json: PNG.toString("base64") }] }) =>
  new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
      "x-codex-imagegen-request-id": "image-test-123",
    },
  })
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})
it("sends exactly the fixed generation contract and preserves original bytes", async () => {
  const fetch = vi.fn(async () => response())
  const image = await generateImage({ prompt: "a fox" }, { resolveAuth: auth, fetch })
  expect(image.bytes).toEqual(PNG)
  expect(image).toMatchObject({
    mimeType: "image/png",
    width: 2,
    height: 1,
    requestId: "image-test-123",
  })
  expect(fetch).toHaveBeenCalledTimes(1)
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe(IMAGE_ENDPOINT)
  expect(init).toMatchObject({
    method: "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "ChatGPT-Account-ID": "fixture-account",
      originator: "sumire-imagegen",
      "User-Agent": "sumire-imagegen",
    },
  })
  expect(JSON.parse(init.body as string)).toEqual({
    prompt: "a fox",
    model: "gpt-image-2",
    quality: "auto",
    size: "auto",
    background: "opaque",
  })
  expect(Object.keys(init.headers as object)).toHaveLength(5)
})
it.each([
  [401, "auth"],
  [403, "denied"],
  [429, "quota"],
  [302, "response"],
  [500, "transport"],
] as const)("redacts HTTP %s and never retries", async (status, kind) => {
  const fetch = vi.fn(async () => new Response("upstream-secret", { status }))
  await expect(
    generateImage({ prompt: "fox" }, { resolveAuth: auth, fetch }),
  ).rejects.toMatchObject({ kind })
  expect(fetch).toHaveBeenCalledTimes(1)
  try {
    await generateImage({ prompt: "fox" }, { resolveAuth: auth, fetch })
  } catch (error) {
    expect(String(error)).not.toContain("upstream-secret")
  }
})
it.each(["", " ", "x".repeat(32_001)])(
  "rejects invalid prompts before resolving auth",
  async (prompt) => {
    const resolveAuth = vi.fn(auth)
    await expect(generateImage({ prompt }, { resolveAuth })).rejects.toMatchObject({
      kind: "input",
    })
    expect(resolveAuth).not.toHaveBeenCalled()
  },
)
it.each([
  "api-key",
  `${encode({ alg: "none" })}.${encode({})}.eA`,
  `${encode({ alg: "RS256" })}.${encode({ "https://api.openai.com/auth": { chatgpt_account_id: "bad\r\nheader" } })}.eA`,
])("rejects incompatible auth before HTTP", async (accessToken) => {
  const fetch = vi.fn()
  await expect(
    generateImage({ prompt: "fox" }, { resolveAuth: async () => ({ accessToken }), fetch }),
  ).rejects.toMatchObject({ kind: "auth" })
  expect(fetch).not.toHaveBeenCalled()
})
it.each([
  {},
  { data: [] },
  { data: [{ url: "https://example.com/image" }] },
  { data: [{ b64_json: "AA==" }] },
  { data: [{ b64_json: PNG.toString("base64") }, { b64_json: PNG.toString("base64") }] },
])("rejects invalid response payloads", async (body) => {
  await expect(
    generateImage({ prompt: "fox" }, { resolveAuth: auth, fetch: async () => response(body) }),
  ).rejects.toMatchObject({ kind: "response" })
})
it("rejects invalid UTF8, content type, redirect metadata and content-length", async () => {
  const responses = [
    new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } }),
    new Response("{}", { headers: { "content-type": "text/html" } }),
    new Response("{}", {
      headers: {
        "content-type": "application/json",
        "content-length": String(MAX_RESPONSE_BYTES + 1),
      },
    }),
    new Response("{}", {
      headers: { "content-type": "application/json", "content-length": "invalid" },
    }),
  ]
  const redirected = response()
  Object.defineProperty(redirected, "redirected", { value: true })
  responses.push(redirected)
  for (const r of responses)
    await expect(
      generateImage({ prompt: "fox" }, { resolveAuth: auth, fetch: async () => r }),
    ).rejects.toMatchObject({ kind: "response" })
})
it("enforces the streamed limit without content-length", async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(MAX_RESPONSE_BYTES))
      c.enqueue(new Uint8Array([1]))
    },
    cancel() {
      cancelled = true
    },
  })
  await expect(
    generateImage(
      { prompt: "fox" },
      {
        resolveAuth: auth,
        fetch: async () => new Response(body, { headers: { "content-type": "application/json" } }),
      },
    ),
  ).rejects.toMatchObject({ kind: "response" })
  expect(cancelled).toBe(true)
})
it("cancels stalled auth and never consumes its late result", async () => {
  const controller = new AbortController()
  let started = () => {}
  const ready = new Promise<void>((r) => {
    started = r
  })
  let finish!: (v: { accessToken: string }) => void
  const fetch = vi.fn()
  const result = generateImage(
    { prompt: "fox" },
    {
      signal: controller.signal,
      resolveAuth: () => {
        started()
        return new Promise((r) => {
          finish = r
        })
      },
      fetch,
    },
  )
  const rejected = expect(result).rejects.toMatchObject({ kind: "cancelled" })
  await ready
  controller.abort()
  await rejected
  finish({ accessToken: token })
  await Promise.resolve()
  expect(fetch).not.toHaveBeenCalled()
})
it("bounds auth and header/body stalls with independent total deadlines", async () => {
  vi.useFakeTimers()
  const authStall = generateImage({ prompt: "fox" }, { resolveAuth: () => new Promise(() => {}) })
  const authCheck = expect(authStall).rejects.toMatchObject({ kind: "timeout" })
  await vi.advanceTimersByTimeAsync(30_000)
  await authCheck
  const headerStall = generateImage(
    { prompt: "fox" },
    { resolveAuth: auth, fetch: () => new Promise(() => {}) },
  )
  const headerCheck = expect(headerStall).rejects.toMatchObject({ kind: "timeout" })
  await vi.advanceTimersByTimeAsync(300_000)
  await headerCheck
  let closed = false
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      closed = true
    },
  })
  const bodyStall = generateImage(
    { prompt: "fox" },
    {
      resolveAuth: auth,
      fetch: async () => new Response(body, { headers: { "content-type": "application/json" } }),
    },
  )
  const bodyCheck = expect(bodyStall).rejects.toMatchObject({ kind: "timeout" })
  await vi.advanceTimersByTimeAsync(300_000)
  await bodyCheck
  expect(closed).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})
it("releases a late fetch body and ignores raw transport/auth errors", async () => {
  const controller = new AbortController()
  let finish!: (r: Response) => void
  let ready = () => {}
  const started = new Promise<void>((r) => {
    ready = r
  })
  const promise = generateImage(
    { prompt: "fox" },
    {
      resolveAuth: auth,
      signal: controller.signal,
      fetch: () => {
        ready()
        return new Promise((r) => {
          finish = r
        })
      },
    },
  )
  const rejected = expect(promise).rejects.toMatchObject({ kind: "cancelled" })
  await started
  controller.abort()
  await rejected
  let cancelled = false
  finish(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true
        },
      }),
    ),
  )
  await Promise.resolve()
  expect(cancelled).toBe(true)
  for (const resolveAuth of [
    async () => {
      throw new Error("secret")
    },
    auth,
  ]) {
    try {
      await generateImage(
        { prompt: "fox" },
        {
          resolveAuth,
          fetch: async () => {
            throw new Error("secret")
          },
        },
      )
    } catch (error) {
      expect(error).toBeInstanceOf(ImagegenError)
      expect(String(error)).not.toContain("secret")
    }
  }
})
