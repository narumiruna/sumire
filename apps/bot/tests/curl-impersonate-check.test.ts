import { spawnSync } from "node:child_process"
import { get } from "node:http"
import { fileURLToPath } from "node:url"

import { beforeEach, expect, it, vi } from "vitest"

const { impersonate, cleanup, start, close, load, construct, state } = vi.hoisted(() => ({
  impersonate: vi.fn(),
  cleanup: vi.fn(),
  start: vi.fn(),
  close: vi.fn(),
  load: vi.fn(),
  construct: vi.fn(),
  state: { proxy: "", fallback: undefined as undefined | (() => Promise<unknown>) },
}))

vi.mock("impers", () => ({
  Curl: class {
    impersonate = impersonate
    cleanup = cleanup
  },
  NATIVE_IMPERSONATE_TARGETS: [
    { browser: "Chrome", target_name: "chrome131" },
    { browser: "Firefox", target_name: "firefox147" },
    { browser: "Chrome", target_name: "chrome150" },
  ],
}))

vi.mock("@narumitw/sumire-url-reader", () => ({
  UrlContentClient: class {
    constructor(options: { fetchImplementation: () => Promise<unknown> }) {
      construct(options)
      state.fallback = options.fetchImplementation
    }
    start() {
      start()
      return this
    }
    close = close
    impersProxy = async () => ""
    browser = async (): Promise<unknown> => undefined
    async loadUrlDetailed(...args: unknown[]) {
      state.proxy = await this.impersProxy()
      return load(...args)
    }
  },
}))

function getText(url: string, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    get(url, { path }, (response) => {
      let body = ""
      response.setEncoding("utf8")
      response.on("data", (chunk: string) => {
        body += chunk
      })
      response.on("end", () => resolve(body))
      response.on("error", reject)
    }).on("error", reject)
  })
}

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  state.proxy = ""
  state.fallback = undefined
  load.mockImplementation(async (target: string) => {
    const html = await getText(state.proxy, target)
    return { loaderId: "curl-cffi", content: html.match(/<p>(.*?)<\/p>/)?.[1] }
  })
})

function runCheck(): Promise<unknown> {
  return import(new URL("../scripts/check-curl-impersonate.mjs", import.meta.url).href)
}

async function expectProxyClosed() {
  expect(state.proxy).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  await expect(getText(state.proxy, "http://8.8.8.8/fixture")).rejects.toMatchObject({
    code: "ECONNREFUSED",
  })
}

it("checks every Chrome fingerprint and loads the exact article through a real loopback fixture", async () => {
  await runCheck()

  expect(impersonate.mock.calls).toEqual([["chrome131"], ["chrome150"]])
  expect(cleanup).toHaveBeenCalledOnce()
  expect(start).toHaveBeenCalledOnce()
  expect(load).toHaveBeenCalledExactlyOnceWith("http://8.8.8.8/fixture", {
    firecrawlFallback: false,
  })
  expect(construct).toHaveBeenCalledWith(
    expect.objectContaining({ deadlineSeconds: 5, firecrawlApiKey: null }),
  )
  await expect(state.fallback?.()).rejects.toThrow("HTTP fallback is forbidden")
  expect(close).toHaveBeenCalledOnce()
  await expectProxyClosed()
})

it("preserves a fingerprint failure and releases the native handle", async () => {
  const error = new Error("Unsupported Chrome fingerprint")
  impersonate.mockImplementationOnce(() => {
    throw error
  })

  await expect(runCheck()).rejects.toBe(error)

  expect(impersonate).toHaveBeenCalledOnce()
  expect(cleanup).toHaveBeenCalledOnce()
  expect(start).not.toHaveBeenCalled()
  expect(close).not.toHaveBeenCalled()
})

it("closes the client and proxy after a network failure", async () => {
  const error = new Error("Native request failed")
  load.mockRejectedValueOnce(error)

  await expect(runCheck()).rejects.toBe(error)

  expect(cleanup).toHaveBeenCalledOnce()
  expect(close).toHaveBeenCalledOnce()
  await expectProxyClosed()
})

it.each([
  {
    loaderId: "httpx",
    content: "The offline curl-cffi fixture confirms asynchronous article loading.",
  },
  { loaderId: "curl-cffi", content: "Wrong article" },
])("rejects an incorrect smoke result: $loaderId / $content", async (result) => {
  load.mockResolvedValueOnce(result)

  await expect(runCheck()).rejects.toThrow()

  expect(close).toHaveBeenCalledOnce()
  await expectProxyClosed()
})

it("requires actual proxy I/O even when the returned result is correct", async () => {
  load.mockResolvedValueOnce({
    loaderId: "curl-cffi",
    content: "The offline curl-cffi fixture confirms asynchronous article loading.",
  })

  await expect(runCheck()).rejects.toThrow()

  expect(close).toHaveBeenCalledOnce()
  await expectProxyClosed()
})

it("closes the proxy even when client cleanup fails", async () => {
  const error = new Error("Client cleanup failed")
  close.mockRejectedValueOnce(error)

  await expect(runCheck()).rejects.toBe(error)

  await expectProxyClosed()
})

// The final Docker image always runs this check with the native library installed.
// Local runs can use the same library path to test genuine native async I/O too.
it.skipIf(!process.env.LIBCURL_PATH)(
  "runs the native offline check in an isolated Bun process",
  () => {
    const script = fileURLToPath(new URL("../scripts/check-curl-impersonate.mjs", import.meta.url))
    const result = spawnSync("bun", ["--no-env-file", script], {
      encoding: "utf8",
      timeout: 20_000,
      killSignal: "SIGKILL",
    })

    expect(result.error).toBeUndefined()
    expect(result.signal, result.stderr).toBeNull()
    expect(result.status, result.stderr).toBe(0)
  },
  25_000,
)

it.skipIf(process.platform === "win32")(
  "rejects unsupported image architectures before downloading an archive",
  () => {
    const script = fileURLToPath(
      new URL("../../../scripts/install-curl-impersonate.sh", import.meta.url),
    )
    const result = spawnSync("/bin/sh", [script], {
      env: { TARGETARCH: "unsupported", PATH: "/nonexistent" },
      encoding: "utf8",
      timeout: 5_000,
    })

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("Unsupported curl-impersonate architecture: unsupported")
  },
)
