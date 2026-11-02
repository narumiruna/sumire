import assert from "node:assert/strict"
import { createServer } from "node:http"

// Also bound cleanup and native calls that do not observe the request deadline.
const watchdog = setTimeout(() => {
  console.error("curl-cffi offline check exceeded 12 seconds")
  process.exit(1)
}, 12_000)

const target = "http://8.8.8.8/fixture"
const article = "The offline curl-cffi fixture confirms asynchronous article loading."
const html = `<html><body><article><p>${article}</p></article></body></html>`
const requests = []
const proxy = createServer({ maxHeaderSize: 4096 }, (request, response) => {
  requests.push({ method: request.method, url: request.url })
  request.resume()
  response.writeHead(request.method === "GET" && request.url === target ? 200 : 400, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    Connection: "close",
  })
  response.end(html)
})
proxy.requestTimeout = 2_000
proxy.headersTimeout = 2_000
proxy.maxRequestsPerSocket = 1

let client
try {
  const { Curl, NATIVE_IMPERSONATE_TARGETS } = await import("impers")
  const curl = new Curl()
  try {
    for (const { browser, target_name } of NATIVE_IMPERSONATE_TARGETS) {
      if (browser === "Chrome") curl.impersonate(target_name)
    }
  } finally {
    curl.cleanup()
  }

  await new Promise((resolve, reject) => {
    proxy.once("error", reject)
    proxy.listen(0, "127.0.0.1", resolve)
  })
  const address = proxy.address()
  assert(address && typeof address !== "string")
  const { UrlContentClient } = await import("@narumitw/sumire-url-reader")
  client = new UrlContentClient({
    deadlineSeconds: 5,
    firecrawlApiKey: null,
    fetchImplementation: async () => {
      throw new Error("HTTP fallback is forbidden in the offline curl-cffi check")
    },
  }).start()
  // Test-owned proxy only: production URL validation still checks the public target.
  client.impersProxy = async () => `http://127.0.0.1:${address.port}`
  // Do not let a native failure start a browser or make an external fallback request.
  client.browser = async () => {
    throw new Error("Browser fallback is forbidden in the offline curl-cffi check")
  }
  const result = await client.loadUrlDetailed(target, { firecrawlFallback: false })
  assert.equal(result.loaderId, "curl-cffi")
  assert.equal(result.content, article)
  assert.deepEqual(requests, [{ method: "GET", url: target }])
} finally {
  try {
    await client?.close()
  } finally {
    try {
      proxy.closeAllConnections()
      if (proxy.listening) {
        await new Promise((resolve, reject) => {
          proxy.close((error) => (error ? reject(error) : resolve()))
        })
      }
    } finally {
      clearTimeout(watchdog)
    }
  }
}
