import { afterEach, describe, expect, it, vi } from "vitest"
import {
  readStatusIncident,
  readStatusSummary,
  type StatusProviderId,
  statusProviders,
} from "../src/index.js"
import { incident, statusFixtures } from "./fixtures.js"

const responseLimit = 2 * 1024 * 1024
const encoder = new TextEncoder()

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

describe("fixed public requests", () => {
  it.each(statusProviders)("reads only the $name summary endpoint", async ({ id, url }) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(statusFixtures[id]))
    const result = await readStatusSummary(id, { fetch: fetcher })
    expect(result.provider).toBe(id)
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [requested, options] = fetcher.mock.calls[0] ?? []
    expect(String(requested)).toBe(`${url}/api/v2/summary.json`)
    expect(options).toMatchObject({
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "omit",
      redirect: "error",
      signal: expect.any(AbortSignal),
    })
    expect(new URL(String(requested)).protocol).toBe("https:")
  })

  it.each(statusProviders)(
    "reads the $name incident envelope at its fixed origin",
    async ({ id, url }) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          incident: incident({
            id: "AZaz09_-",
            shortlink: "https://user:password@127.0.0.1/private",
            page: { url: "http://169.254.169.254/" },
          }),
        }),
      )
      const result = await readStatusIncident(id, "AZaz09_-", { fetch: fetcher })
      expect(String(fetcher.mock.calls[0]?.[0])).toBe(`${url}/api/v2/incidents/AZaz09_-.json`)
      expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("error")
      expect(result.url).toBe(`${url}/incidents/AZaz09_-`)
      expect(result.id).toBe("AZaz09_-")
    },
  )

  it("uses global fetch when none is injected", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(statusFixtures.openai))
    vi.stubGlobal("fetch", fetcher)
    await expect(readStatusSummary("openai")).resolves.toMatchObject({ provider: "openai" })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each(["GitHub", "openai\n", "__proto__", "https://hostile.invalid", null, {}, ["github"]])(
    "validates provider %j before dispatching either request",
    async (provider) => {
      const fetcher = vi.fn<typeof fetch>()
      await expect(
        readStatusSummary(provider as StatusProviderId, { fetch: fetcher }),
      ).rejects.toThrow("Unsupported status provider")
      await expect(
        readStatusIncident(provider as StatusProviderId, "incident_1", { fetch: fetcher }),
      ).rejects.toThrow("Unsupported status provider")
      expect(fetcher).not.toHaveBeenCalled()
    },
  )

  it.each([
    "",
    "../private",
    "https://hostile.invalid",
    "//hostile.invalid",
    "with space",
    "query?x",
    "hash#x",
    "back\\slash",
    "%2f",
    "new\nline",
    "ok\n",
    "ok\r\n",
    "é",
    "a".repeat(129),
    null,
    42,
  ])("validates incident ID %j before dispatch", async (id) => {
    const fetcher = vi.fn<typeof fetch>()
    await expect(readStatusIncident("github", id as string, { fetch: fetcher })).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each(["a", "a".repeat(128)])("accepts a valid incident ID of length %s", async (id) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ incident: incident({ id }) }))
    await expect(readStatusIncident("github", id, { fetch: fetcher })).resolves.toHaveProperty(
      "id",
      id,
    )
  })

  it("rejects an incident response with a different ID", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ incident: incident({ id: "other_incident" }) }))
    await expect(readStatusIncident("github", "incident_1", { fetch: fetcher })).rejects.toThrow(
      "Status incident ID does not match the request",
    )
  })
})

describe("HTTP and malformed responses", () => {
  it.each([301, 302, 307, 308, 400, 404, 429, 500])(
    "rejects HTTP %s without a retry",
    async (status) => {
      const cancel = vi.fn()
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(new ReadableStream<Uint8Array>({ cancel }), {
          status,
          headers: { location: "http://127.0.0.1/private" },
        }),
      )
      await expect(readStatusSummary("github", { fetch: fetcher })).rejects.toThrow(
        `Status page request failed (HTTP ${status})`,
      )
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("error")
      expect(cancel).toHaveBeenCalledTimes(1)
    },
  )

  it("rejects a network or fetch redirect failure", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed"))
    await expect(readStatusSummary("github", { fetch: fetcher })).rejects.toThrow("fetch failed")
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("rejects a response that an injected fetch already redirected", async () => {
    const response = Response.json(statusFixtures.github)
    Object.defineProperty(response, "redirected", { value: true })
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response)
    await expect(readStatusSummary("github", { fetch: fetcher })).rejects.toThrow(
      "Status page redirects are not allowed",
    )
  })

  it.each(["not json", "{broken", "", "null", "[]", "{}"])(
    "rejects invalid response %j",
    async (body) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body))
      await expect(readStatusSummary("github", { fetch: fetcher })).rejects.toThrow()
    },
  )

  it("rejects malformed incident envelopes", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ incident: null }))
    await expect(readStatusIncident("github", "incident_1", { fetch: fetcher })).rejects.toThrow()
  })

  it("rejects an absent response body", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null))
    await expect(readStatusSummary("github", { fetch: fetcher })).rejects.toThrow(
      "Status page response has no body",
    )
  })

  it("propagates stream failures and releases the reader", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("stream failed"))
      },
    })
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body))
    await expect(readStatusSummary("github", { fetch: fetcher })).rejects.toThrow("stream failed")
    expect(body.locked).toBe(false)
  })

  it("rejects invalid UTF-8 rather than replacing malformed bytes", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(Uint8Array.of(0xff, 0xfe)))
    await expect(readStatusSummary("github", { fetch: fetcher })).rejects.toThrow()
  })
})

describe("streamed decoded byte bounds", () => {
  it("rejects an oversized Content-Length before reading and cancels the stream", async () => {
    const cancel = vi.fn()
    const pull = vi.fn()
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 })
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(body, { headers: { "content-length": String(responseLimit + 1) } }),
      )
    await expect(readStatusSummary("github", { fetch: fetcher })).rejects.toThrow("2 MiB limit")
    expect(pull).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it.each([undefined, "1", String(responseLimit), "invalid", "-1"])(
    "counts streamed bytes despite Content-Length=%s",
    async (length) => {
      let chunks = 0
      const cancel = vi.fn()
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            chunks++
            controller.enqueue(new Uint8Array(256 * 1024).fill(0x20))
          },
          cancel,
        },
        { highWaterMark: 0 },
      )
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(body, { headers: length === undefined ? {} : { "content-length": length } }),
        )
      await expect(readStatusSummary("cloudflare", { fetch: fetcher })).rejects.toThrow(
        "2 MiB limit",
      )
      expect(chunks).toBe(9)
      expect(cancel).toHaveBeenCalledTimes(1)
      expect(body.locked).toBe(false)
    },
  )

  it("accepts exactly 2 MiB and rejects one more decoded byte", async () => {
    const json = JSON.stringify(statusFixtures.github)
    for (const extra of [0, 1]) {
      const text = json + " ".repeat(responseLimit - encoder.encode(json).byteLength + extra)
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(text))
      const result = readStatusSummary("github", { fetch: fetcher })
      if (extra === 0) await expect(result).resolves.toHaveProperty("provider", "github")
      else await expect(result).rejects.toThrow("2 MiB limit")
    }
  })

  it("counts UTF-8 bytes, not JavaScript string length", async () => {
    const prefix = JSON.stringify(statusFixtures.github)
    const text = `${prefix.slice(0, -1)},"ignored":"${"界".repeat(700_000)}"}`
    expect(text.length).toBeLessThan(responseLimit)
    expect(encoder.encode(text).byteLength).toBeGreaterThan(responseLimit)
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(text))
    await expect(readStatusSummary("github", { fetch: fetcher })).rejects.toThrow("2 MiB limit")
  })

  it("counts decompressed bytes rather than a compressed Content-Length", async () => {
    const raw = encoder.encode(JSON.stringify(statusFixtures.github) + " ".repeat(responseLimit))
    const gzip = new Blob([raw]).stream().pipeThrough(new CompressionStream("gzip"))
    const compressed = await new Response(gzip).arrayBuffer()
    expect(compressed.byteLength).toBeLessThan(responseLimit)
    const decoded = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"))
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(decoded, {
        headers: {
          "content-encoding": "gzip",
          "content-length": String(compressed.byteLength),
        },
      }),
    )
    await expect(readStatusSummary("github", { fetch: fetcher })).rejects.toThrow("2 MiB limit")
  })

  it("decodes multi-byte text split across response chunks", async () => {
    const fixture = { ...statusFixtures.openai, status: { indicator: "none", description: "界🙂" } }
    const bytes = encoder.encode(JSON.stringify(fixture))
    let offset = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.length) controller.close()
        else controller.enqueue(bytes.subarray(offset, ++offset))
      },
    })
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body))
    await expect(readStatusSummary("openai", { fetch: fetcher })).resolves.toHaveProperty(
      "description",
      "界🙂",
    )
  })
})

describe("deadline and caller cancellation", () => {
  it("rejects an already aborted caller without fetching", async () => {
    const controller = new AbortController()
    const reason = new Error("caller cancelled")
    controller.abort(reason)
    const fetcher = vi.fn<typeof fetch>()
    await expect(
      readStatusSummary("github", { fetch: fetcher, signal: controller.signal }),
    ).rejects.toBe(reason)
    await expect(
      readStatusIncident("github", "incident_1", { fetch: fetcher, signal: controller.signal }),
    ).rejects.toBe(reason)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("enforces 15 seconds even if fetch ignores its signal", async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>(() => {}))
    const result = readStatusSummary("github", { fetch: fetcher })
    const rejection = expect(result).rejects.toMatchObject({ name: "TimeoutError" })
    await vi.advanceTimersByTimeAsync(14_999)
    const signal = fetcher.mock.calls[0]?.[1]?.signal
    expect(signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await rejection
    expect(signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("includes both headers and body in one 15-second deadline", async () => {
    vi.useFakeTimers()
    const pending = deferred<Response>()
    const fetcher = vi.fn<typeof fetch>().mockReturnValue(pending.promise)
    const result = readStatusSummary("github", { fetch: fetcher })
    const rejection = expect(result).rejects.toMatchObject({ name: "TimeoutError" })
    await vi.advanceTimersByTimeAsync(10_000)
    const cancel = vi.fn()
    pending.resolve(new Response(new ReadableStream<Uint8Array>({ cancel })))
    await vi.advanceTimersByTimeAsync(4_999)
    expect(cancel).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await rejection
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("cancels a response that arrives after its deadline", async () => {
    vi.useFakeTimers()
    const pending = deferred<Response>()
    const fetcher = vi.fn<typeof fetch>().mockReturnValue(pending.promise)
    const result = readStatusSummary("github", { fetch: fetcher })
    const rejection = expect(result).rejects.toMatchObject({ name: "TimeoutError" })
    await vi.advanceTimersByTimeAsync(15_000)
    await rejection
    const cancel = vi.fn()
    pending.resolve(new Response(new ReadableStream<Uint8Array>({ cancel })))
    await vi.advanceTimersByTimeAsync(0)
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it("preserves caller cancellation while fetch is pending", async () => {
    const controller = new AbortController()
    const reason = new Error("cancelled during fetch")
    const pending = deferred<Response>()
    const fetcher = vi.fn<typeof fetch>().mockReturnValue(pending.promise)
    const result = readStatusSummary("github", { fetch: fetcher, signal: controller.signal })
    const rejection = expect(result).rejects.toBe(reason)
    controller.abort(reason)
    await rejection
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    const cancel = vi.fn()
    pending.resolve(new Response(new ReadableStream<Uint8Array>({ cancel })))
    await Promise.resolve()
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it("aborts a stalled body even if stream cancellation never settles", async () => {
    const controller = new AbortController()
    const reason = new Error("cancelled during body")
    const started = deferred<void>()
    const cancel = vi.fn(() => new Promise<void>(() => {}))
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          started.resolve()
        },
        cancel,
      },
      { highWaterMark: 0 },
    )
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body))
    const result = readStatusIncident("github", "incident_1", {
      fetch: fetcher,
      signal: controller.signal,
    })
    const rejection = expect(result).rejects.toBe(reason)
    await started.promise
    controller.abort(reason)
    await rejection
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(body.locked).toBe(false)
  })

  it("does not return a result when the caller aborts during a body chunk", async () => {
    const controller = new AbortController()
    const reason = new Error("cancelled before returning data")
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>(
      {
        pull(stream) {
          controller.abort(reason)
          stream.enqueue(encoder.encode(JSON.stringify(statusFixtures.github)))
        },
        cancel,
      },
      { highWaterMark: 0 },
    )
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body))
    await expect(
      readStatusSummary("github", { fetch: fetcher, signal: controller.signal }),
    ).rejects.toBe(reason)
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it("clears its deadline after successful requests and failed requests", async () => {
    vi.useFakeTimers()
    for (const response of [
      Response.json(statusFixtures.github),
      new Response(null, { status: 500 }),
    ]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response)
      await readStatusSummary("github", { fetch: fetcher }).catch(() => {})
      expect(vi.getTimerCount()).toBe(0)
    }
  })
})
