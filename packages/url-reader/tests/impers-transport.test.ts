import {
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
  spawn,
} from "node:child_process"
import { once } from "node:events"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { fileURLToPath } from "node:url"

import { Headers, Response, Session } from "impers"
import { afterEach, describe, expect, it, vi } from "vitest"

// Use compiled code so the genuine child resolves the compiled host entrypoint.
import { UrlContentClient } from "../dist/client.js"
import {
  BODY_CHUNK_BYTES,
  FrameReader,
  frame,
  MAX_BODY_BYTES,
  MAX_FRAME_BYTES,
  MAX_HEADER_BYTES,
  validMetadata,
  validRequest,
} from "../dist/core/impers-protocol.js"
import {
  type ImpersRequest,
  impersHostEnvironment,
  NodeImpersTransport,
} from "../dist/core/impers-transport.js"
import { fetchImpersResponse } from "../dist/loaders/generic.js"

const fixture = fileURLToPath(new URL("./fixtures/impers-host.mjs", import.meta.url))
const request: ImpersRequest = {
  url: "http://8.8.8.8/",
  proxy: "http://127.0.0.1:12345",
  impersonate: "chrome",
  headers: {},
  timeoutSeconds: 5,
  maxBytes: 1024,
}
const transports: NodeImpersTransport[] = []
const cleanups: (() => Promise<void>)[] = []
type Launch = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams
function transport(launch?: Launch) {
  // The transport uses only the three-argument, piped-stream spawn overload.
  const instance = new NodeImpersTransport(launch as unknown as typeof spawn | undefined)
  transports.push(instance)
  return instance
}
function fake(mode: string) {
  let child: ChildProcessWithoutNullStreams | undefined
  const instance = transport((_command, _args, options) => {
    child = spawn(process.execPath, [fixture, mode], options)
    return child
  })
  return {
    instance,
    child: () => {
      if (!child) throw new Error("Host has not started")
      return child
    },
  }
}
async function proxy(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler)
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  })
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}
function bunRuntime() {
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, "bun")
  Object.defineProperty(process.versions, "bun", { configurable: true, value: "fixture" })
  cleanups.push(async () => {
    if (descriptor) Object.defineProperty(process.versions, "bun", descriptor)
    else Reflect.deleteProperty(process.versions, "bun")
  })
}

afterEach(async () => {
  await Promise.all(transports.splice(0).map((instance) => instance.close()))
  for (const cleanup of cleanups.splice(0)) await cleanup()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe("impers framing", () => {
  it("handles byte-split UTF-8 and coalesced frames", () => {
    const reader = new FrameReader()
    const received: unknown[] = []
    const bytes = Buffer.from(frame({ text: "日本語" }) + frame({ type: "ready" }))
    for (const byte of bytes) reader.push(Buffer.from([byte]), (value) => received.push(value))
    reader.push(Buffer.from(frame(1) + frame(2)), (value) => received.push(value))
    expect(received).toEqual([{ text: "日本語" }, { type: "ready" }, 1, 2])
  })

  it("bounds encoded bytes, including unterminated and fragmented frames", () => {
    const exact = "a".repeat(MAX_FRAME_BYTES - 2)
    expect(Buffer.byteLength(frame(exact))).toBe(MAX_FRAME_BYTES + 1)
    const accepted: unknown[] = []
    new FrameReader().push(Buffer.from(frame(exact) + frame(exact)), (value) =>
      accepted.push(value),
    )
    expect(accepted).toEqual([exact, exact])
    expect(() => frame(`${exact}a`)).toThrow("limit")
    expect(() => frame("界".repeat(MAX_FRAME_BYTES / 2))).toThrow("limit")
    const reader = new FrameReader()
    reader.push(Buffer.alloc(MAX_FRAME_BYTES, 32), () => undefined)
    expect(() => reader.push(Buffer.from("x"), () => undefined)).toThrow("limit")
    expect(() => new FrameReader().push(Buffer.from("bad\n"), () => undefined)).toThrow()
  })

  it("validates bounded requests and structured metadata", () => {
    expect(validRequest(request)).toBe(true)
    for (const patch of [
      { maxBytes: MAX_BODY_BYTES + 1 },
      { maxBytes: -1 },
      { maxBytes: 0.5 },
      { timeoutSeconds: Infinity },
      { timeoutSeconds: 0 },
      { timeoutSeconds: 3601 },
      { proxy: "http://localhost:1234" },
      { proxy: "http://127.0.0.1:1234/path" },
      { url: "file:///tmp/data" },
      { url: "http://user:password@8.8.8.8/" },
      { headers: { test: 1 } },
      { impersonate: "x".repeat(129) },
    ])
      expect(validRequest({ ...request, ...patch })).toBe(false)
    expect(validMetadata({ status: 200 })).toBe(false)
    expect(BODY_CHUNK_BYTES).toBeLessThan(MAX_FRAME_BYTES)
  })

  it("rejects oversized request frames before launching", async () => {
    const launch = vi.fn<Launch>()
    await expect(
      transport(launch).get({ ...request, headers: { huge: "x".repeat(MAX_FRAME_BYTES) } }),
    ).rejects.toThrow("limit")
    expect(launch).not.toHaveBeenCalled()
  })
})

describe("impers child lifecycle", () => {
  it("isolates the startup environment and does not inherit Node arguments", async () => {
    vi.stubEnv("NODE_OPTIONS", "--inspect=0")
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-secret")
    vi.stubEnv("OPENAI_API_KEY", "test-secret")
    vi.stubEnv("NO_PROXY", "*")
    vi.stubEnv("LIBCURL_PATH", "/test/library")
    const env = impersHostEnvironment()
    expect(env).toMatchObject({ LIBCURL_PATH: "/test/library", PATH: process.env.PATH })
    for (const key of ["NODE_OPTIONS", "TELEGRAM_BOT_TOKEN", "OPENAI_API_KEY", "NO_PROXY"])
      expect(env).not.toHaveProperty(key)
    const launch = vi.fn<Launch>((_command, _args, options) =>
      spawn(process.execPath, [fixture, "ok"], options),
    )
    await transport(launch).get(request)
    expect(launch.mock.calls[0]?.[0]).toBe("node")
    expect(launch.mock.calls[0]?.[1]).toHaveLength(1)
    expect(launch.mock.calls[0]?.[2]).toMatchObject({ env, stdio: ["pipe", "pipe", "pipe"] })
  })

  it("rejects missing executables without leaking native diagnostics", async () => {
    const instance = transport((_command, _args, options) =>
      spawn("/missing/impers-node", [], options),
    )
    await expect(instance.get(request)).rejects.toMatchObject({
      code: "ECONNRESET",
      message: "Impers Node.js transport failed",
    })
    expect(instance.unusable).toBe(true)
  })

  it("rejects the real host under a wrong runtime before loading impers", async () => {
    const bootstrap = `Object.defineProperty(process.versions, 'node', { value: '25.0.0' }); await import(process.argv[1])`
    const instance = transport((_command, args, options) =>
      spawn(process.execPath, ["--input-type=module", "--eval", bootstrap, ...args], options),
    )
    await expect(instance.get(request)).rejects.toMatchObject({ code: "ECONNRESET" })
    expect(instance.unusable).toBe(true)
  })

  it.each(["exit", "crash", "json", "oversized", "unknown", "base64", "metadata"])(
    "fails closed on %s",
    async (mode) => {
      const { instance, child } = fake(mode)
      await expect(instance.get(request)).rejects.toMatchObject({ code: "ECONNRESET" })
      expect(child().exitCode !== null || child().signalCode !== null).toBe(true)
      expect(instance.unusable).toBe(true)
      await expect(instance.get(request)).rejects.toMatchObject({ code: "ECONNRESET" })
    },
  )

  it("enforces the parent body bound even against an invalid host", async () => {
    await expect(fake("body").instance.get({ ...request, maxBytes: 10 })).rejects.toThrow(
      "body byte limit",
    )
  })

  it("ignores a coalesced success frame after failing the receiver body limit", async () => {
    const { instance, child } = fake("body-end")
    await expect(instance.get({ ...request, maxBytes: 10 })).rejects.toThrow("body byte limit")
    expect(instance.unusable).toBe(true)
    expect(child().signalCode).toBe("SIGKILL")
  })

  it("keeps certificate failures distinct from transport resets", async () => {
    const error = await fake("tls")
      .instance.get(request)
      .catch((reason: unknown) => reason)
    expect(error).toMatchObject({ name: "CertificateVerifyError" })
    expect(error).not.toHaveProperty("code")
  })

  it("kills abandoned startup before settling and permits client recovery", async () => {
    const { instance, child } = fake("startup")
    await expect(instance.get({ ...request, timeoutSeconds: 0.05 })).rejects.toMatchObject({
      code: "ETIMEDOUT",
    })
    expect(child().signalCode).toBe("SIGKILL")
    expect(instance.unusable).toBe(true)
    const endpoint = await proxy((_req, res) => res.end("recovered"))
    const client = new UrlContentClient().start()
    Reflect.set(client, "processTransport", instance)
    try {
      const replacement = await client.impersTransport()
      expect(replacement).not.toBe(instance)
      expect((await replacement.get({ ...request, proxy: endpoint })).content.toString()).toBe(
        "recovered",
      )
    } finally {
      await client.close()
    }
  })

  it("retains a starting host while another request still waits for readiness", async () => {
    const { instance } = fake("delayed")
    const first = expect(instance.get({ ...request, timeoutSeconds: 0.05 })).rejects.toMatchObject({
      code: "ETIMEDOUT",
    })
    const second = instance.get(request)
    await first
    expect(instance.unusable).toBe(false)
    expect((await second).status).toBe(200)
    expect(instance.unusable).toBe(false)
  })

  it("kills noncooperative work before settling a timeout", async () => {
    const { instance, child } = fake("stubborn")
    const first = expect(instance.get(request)).rejects.toMatchObject({ code: "ECONNRESET" })
    await once(child().stdout, "data")
    const started = Date.now()
    await expect(instance.get({ ...request, timeoutSeconds: 0.05 })).rejects.toMatchObject({
      code: "ETIMEDOUT",
    })
    await first
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000)
    expect(child().signalCode).toBe("SIGKILL")
    expect(instance.unusable).toBe(true)
  })

  it("preserves cancellation identity before launch and during native work", async () => {
    const reason = { cancelled: true }
    const already = new AbortController()
    already.abort(reason)
    const launch = vi.fn<Launch>()
    try {
      transport(launch).get(request, already.signal)
      expect.fail("pre-aborted request must throw")
    } catch (error) {
      expect(error).toBe(reason)
    }
    expect(launch).not.toHaveBeenCalled()
    const { instance, child } = fake("wait")
    const controller = new AbortController()
    const pending = instance.get(request, controller.signal)
    const assertion = expect(pending).rejects.toBe(reason)
    await once(child().stdout, "data")
    controller.abort(reason)
    await assertion
    expect(instance.unusable).toBe(false)
  })

  it("closes idempotently, waits for process exit, and rejects future work", async () => {
    const { instance, child } = fake("stubborn")
    const pending = instance.get(request)
    const assertion = expect(pending).rejects.toMatchObject({ code: "ECONNRESET" })
    await once(child().stdout, "data")
    await Promise.all([instance.close(), instance.close()])
    await assertion
    expect(child().exitCode !== null || child().signalCode !== null).toBe(true)
    await expect(instance.get(request)).rejects.toMatchObject({ code: "ECONNRESET" })
  })

  it("settles only after response cleanup and hides cleanup failures", async () => {
    const preload = fileURLToPath(new URL("./fixtures/impers-native.mjs", import.meta.url))
    const instance = transport((_command, args, options) =>
      spawn(process.execPath, ["--import", preload, ...args], options),
    )
    await instance.get(request)
    const started = Date.now()
    expect((await instance.get(request)).content).toEqual(Buffer.from([0, 255, 128]))
    expect(Date.now() - started).toBeGreaterThanOrEqual(90)
    await expect(
      instance.get({ ...request, url: "http://8.8.8.8/close-fails" }),
    ).rejects.toMatchObject({
      code: "ECONNRESET",
      message: "Impers Node.js transport failed",
    })
    expect(instance.unusable).toBe(false)
    expect((await instance.get(request)).status).toBe(200)
  })

  it("recreates a failed client-owned transport and closes the replacement", async () => {
    const endpoint = await proxy((_req, res) => res.end("ok"))
    const client = new UrlContentClient().start()
    try {
      const first = await client.impersTransport()
      expect(await client.impersTransport()).toBe(first)
      await first.get({ ...request, proxy: endpoint })
      // Simulate an unexpected host crash, not an orderly client shutdown.
      const child = Reflect.get(first, "child") as ChildProcessWithoutNullStreams
      const exited = once(child, "close")
      child.kill("SIGKILL")
      await exited
      expect(first.unusable).toBe(true)
      const replacement = await client.impersTransport()
      expect(replacement).not.toBe(first)
      expect(replacement.unusable).toBe(false)
      await client.close()
      expect(replacement.unusable).toBe(true)
    } finally {
      await client.close()
    }
  })
})

describe("Bun shared-loader integration", () => {
  it.each(["127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1"])(
    "rejects a redirect to %s before another native request",
    async (host) => {
      bunRuntime()
      let requests = 0
      const endpoint = await proxy((_req, res) => {
        requests += 1
        res.writeHead(302, { Location: `http://${host}/private` })
        res.end()
      })
      const client = new UrlContentClient().start()
      vi.spyOn(client, "impersProxy").mockResolvedValue(endpoint)
      try {
        await expect(fetchImpersResponse(request.url, { resources: client })).rejects.toThrow()
        expect(requests).toBe(1)
      } finally {
        await client.close()
      }
    },
  )

  it("preserves the real response and binary data while removing cross-origin secrets", async () => {
    bunRuntime()
    const seen: IncomingMessage["headers"][] = []
    const bytes = Buffer.from([0, 255, 128, 10])
    const endpoint = await proxy((_req, res) => {
      seen.push(_req.headers)
      if (seen.length === 1) res.writeHead(302, { Location: "http://1.1.1.1/final" })
      else res.writeHead(200, { "Content-Type": "application/pdf", "X-Multi": ["one", "two"] })
      res.end(seen.length === 1 ? undefined : bytes)
    })
    const client = new UrlContentClient().start()
    vi.spyOn(client, "impersProxy").mockResolvedValue(endpoint)
    try {
      const response = await fetchImpersResponse(request.url, {
        resources: client,
        maxBytes: 32,
        headers: {
          Authorization: "Bearer test",
          Cookie: "test=value",
          "Proxy-Authorization": "Basic test",
        },
      })
      expect(response).toBeInstanceOf(Response)
      expect(response.content).toEqual(bytes)
      expect(response.headers.getAll("x-multi")).toEqual(["one", "two"])
      expect(seen[0]?.authorization).toBe("Bearer test")
      for (const name of ["authorization", "cookie", "proxy-authorization"])
        expect(seen[1]).not.toHaveProperty(name)
    } finally {
      await client.close()
    }
  })

  it("enforces an HTTPS-only policy before native I/O", async () => {
    bunRuntime()
    let requests = 0
    const endpoint = await proxy((_req, res) => {
      requests += 1
      res.end("unexpected")
    })
    const client = new UrlContentClient({ allowedSchemes: new Set(["https"]) }).start()
    vi.spyOn(client, "impersProxy").mockResolvedValue(endpoint)
    try {
      await expect(fetchImpersResponse(request.url, { resources: client })).rejects.toThrow(
        "URL scheme is not allowed",
      )
      expect(requests).toBe(0)
    } finally {
      await client.close()
    }
  })

  it("preserves target HTTP status diagnostics", async () => {
    bunRuntime()
    const endpoint = await proxy((_req, res) => {
      res.writeHead(403)
      res.end("denied")
    })
    const client = new UrlContentClient().start()
    vi.spyOn(client, "impersProxy").mockResolvedValue(endpoint)
    try {
      await expect(fetchImpersResponse(request.url, { resources: client })).rejects.toMatchObject({
        status: 403,
      })
    } finally {
      await client.close()
    }
  })

  it.each([false, true])(
    "keeps automatic fallback and exact-loader semantics (explicit=%s)",
    async (explicit) => {
      bunRuntime()
      const failed = fake("crash").instance
      const fetchImplementation = vi.fn(
        async () =>
          new globalThis.Response("<article>HTTP fallback</article>", {
            headers: { "Content-Type": "text/html" },
          }),
      )
      const client = new UrlContentClient({
        deadlineSeconds: 5,
        firecrawlApiKey: null,
        fetchImplementation,
      }).start()
      vi.spyOn(client, "impersTransport").mockResolvedValue(failed)
      vi.spyOn(client, "impersProxy").mockResolvedValue(request.proxy)
      vi.spyOn(client, "browser").mockRejectedValue(new Error("browser disabled in fixture"))
      try {
        const loading = client.loadUrlDetailed(
          request.url,
          explicit ? { loaderNames: ["curl-cffi"] } : {},
        )
        if (explicit) {
          await expect(loading).rejects.toMatchObject({
            attempts: [
              expect.objectContaining({
                loaderId: "curl-cffi",
                diagnostic: { code: "transport_failure", phase: "loading" },
              }),
            ],
          })
          expect(fetchImplementation).not.toHaveBeenCalled()
        } else {
          const result = await loading
          expect(result.loaderId).toBe("httpx")
          expect(result.attempts[0]).toMatchObject({
            loaderId: "curl-cffi",
            diagnostic: { code: "transport_failure", phase: "loading" },
          })
          expect(fetchImplementation).toHaveBeenCalledOnce()
        }
      } finally {
        await client.close()
      }
    },
  )
})

describe("Node native routing", () => {
  it("keeps native Session requests in process and returns the native Response", async () => {
    const session = new Session()
    const response = new Response({
      content: Buffer.from("native"),
      headers: new Headers(),
      requestUrl: request.url,
      url: request.url,
      statusCode: 200,
    })
    const get = vi.spyOn(session, "get").mockResolvedValue(response)
    const client = new UrlContentClient().start()
    vi.spyOn(client, "impersSession").mockResolvedValue(session)
    vi.spyOn(client, "impersProxy").mockResolvedValue(request.proxy)
    const isolated = vi.spyOn(client, "impersTransport")
    try {
      expect(await fetchImpersResponse(request.url, { resources: client })).toBe(response)
      expect(get).toHaveBeenCalledOnce()
      expect(isolated).not.toHaveBeenCalled()
    } finally {
      await response.close()
      await session.close()
      await client.close()
    }
  })
})

describe("real Node impers host through a loopback fixture proxy", () => {
  it("preserves binary bytes, cookies, and session reuse without forwarding", async () => {
    const binary = Buffer.from([0, 255, 128, 13, 10, 0, 42])
    const seen: string[] = []
    const endpoint = await proxy((req, res) => {
      seen.push(req.url ?? "")
      if (req.url?.endsWith("/cookie")) {
        expect(req.headers.cookie).toContain("session=test")
      } else res.setHeader("Set-Cookie", "session=test; Path=/")
      res.end(binary)
    })
    const instance = transport()
    for (const path of ["/", "/cookie"]) {
      const reply = await instance.get({
        ...request,
        proxy: endpoint,
        url: `http://8.8.8.8${path}`,
      })
      expect(reply.status).toBe(200)
      expect(reply.content).toEqual(binary)
    }
    expect(seen).toEqual(["http://8.8.8.8/", "http://8.8.8.8/cookie"])
    expect(instance.unusable).toBe(false)
  })

  it.each(["absent", "lying", "large"])(
    "bounds streamed bodies with %s content-length",
    async (mode) => {
      const endpoint = await proxy((_req, res) => {
        if (mode === "lying") {
          res.setHeader("Content-Length", "1")
          res.setHeader("Transfer-Encoding", "chunked")
        } else if (mode === "large") res.setHeader("Content-Length", "1000000")
        res.write(Buffer.alloc(4096))
        res.end()
      })
      const instance = transport()
      await expect(instance.get({ ...request, proxy: endpoint, maxBytes: 32 })).rejects.toThrow(
        /limit/,
      )
      expect(instance.unusable).toBe(false)
    },
  )

  it("bounds response headers and can reuse the host after callback cancellation", async () => {
    const endpoint = await proxy((req, res) => {
      if (req.url?.endsWith("/huge")) res.setHeader("X-Large", "a".repeat(MAX_HEADER_BYTES + 1))
      res.end("ok")
    })
    const instance = transport()
    await expect(
      instance.get({ ...request, proxy: endpoint, url: "http://8.8.8.8/huge" }),
    ).rejects.toThrow(/limit/)
    expect((await instance.get({ ...request, proxy: endpoint })).content.toString()).toBe("ok")
  })

  it("stops active native work when the parent input disconnects", async () => {
    let markStarted: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const endpoint = await proxy((_req, res) => {
      res.writeHead(200)
      res.write("waiting")
      markStarted()
    })
    const instance = transport()
    const assertion = expect(instance.get({ ...request, proxy: endpoint })).rejects.toMatchObject({
      code: "ECONNRESET",
    })
    await started
    const child = Reflect.get(instance, "child") as ChildProcessWithoutNullStreams
    child.stdin.end()
    await assertion
    expect(child.exitCode).toBe(0)
    expect(instance.unusable).toBe(true)
  })

  it("cancels one concurrent request without aborting another", async () => {
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const endpoint = await proxy((req, res) => {
      if (req.url?.endsWith("/slow")) {
        res.writeHead(200)
        res.write("waiting")
        markStarted()
      } else res.end("survived")
    })
    const instance = transport()
    const controller = new AbortController()
    const reason = new Error("caller stopped this request")
    const pending = instance.get(
      { ...request, proxy: endpoint, url: "http://8.8.8.8/slow" },
      controller.signal,
    )
    const assertion = expect(pending).rejects.toBe(reason)
    await started
    const other = instance.get({ ...request, proxy: endpoint })
    controller.abort(reason)
    await assertion
    expect((await other).content.toString()).toBe("survived")
    expect(instance.unusable).toBe(false)
  })
})
