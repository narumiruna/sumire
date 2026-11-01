import assert from "node:assert/strict"
import { createServer } from "node:http"
import net from "node:net"
import { Agent } from "undici/index.js"
import { loadPublicUrl } from "../dist/public-url.js"

// Keep the real client and dispatcher. All sockets connect only to this fixture.
const requests = []
const server = createServer((request, response) => {
  requests.push(request.url ?? "")
  switch (request.url) {
    case "/start":
      response.writeHead(302, { location: "/article" }).end()
      break
    case "/article":
      response.writeHead(200, { "content-type": "text/html" })
      response.end("<title>Offline fixture</title><p>Installed client content</p>")
      break
    case "/private":
      response.writeHead(302, { location: "http://127.0.0.1/private" }).end()
      break
    default:
      response.writeHead(503, { "content-type": "text/plain" }).end("Unavailable")
  }
})
await new Promise((resolve, reject) => {
  server.once("error", reject)
  server.listen(0, "127.0.0.1", resolve)
})
const address = server.address()
assert.ok(address && typeof address !== "string")
const originalConnect = net.connect
const originalClose = Agent.prototype.close
const closedAgents = []
const pinnedAddresses = []
const resolvedHosts = []
const publicAddress = { address: "8.8.8.8", family: 4 }

// Verify the installed connector's real pinned lookup before substituting loopback.
net.connect = (connectOptions) => {
  assert.equal(connectOptions.host, "article.example")
  assert.equal(Number(connectOptions.port), 80)
  const pinnedLookup = connectOptions.lookup
  assert.equal(typeof pinnedLookup, "function")
  return originalConnect({
    ...connectOptions,
    port: address.port,
    lookup(hostname, lookupOptions, callback) {
      pinnedLookup(hostname, lookupOptions, (error, destination, family) => {
        assert.ifError(error)
        pinnedAddresses.push(destination)
        if (Array.isArray(destination)) {
          assert.deepEqual(destination, [publicAddress])
          callback(null, [{ address: "127.0.0.1", family: 4 }])
        } else {
          assert.equal(destination, publicAddress.address)
          assert.equal(family, publicAddress.family)
          callback(null, "127.0.0.1", 4)
        }
      })
    },
  })
}
Agent.prototype.close = function (...args) {
  if (args.length === 0) closedAgents.push(this)
  return Reflect.apply(originalClose, this, args)
}
const options = {
  allowedSchemes: new Set(["http", "https"]),
  loader: "built-in",
  maxChars: 100,
  timeoutMs: 2000,
  urlContentTimeoutSeconds: 5,
  firecrawlApiKey: null,
  resolve: async (hostname) => {
    resolvedHosts.push(hostname)
    return [publicAddress]
  },
}
try {
  const result = await loadPublicUrl("http://article.example/start", options)
  assert.equal(result.source, "built-in")
  assert.equal(result.finalUrl, "http://article.example/article")
  assert.equal(result.title, "Offline fixture")
  assert.match(result.text, /Installed client content/)
  assert.equal(result.truncated, false)
  assert.deepEqual(requests, ["/start", "/article"])
  assert.equal(closedAgents.length, 2)
  assert.equal(pinnedAddresses.length, 2)
  assert.deepEqual(resolvedHosts, Array(3).fill("article.example"))

  await assert.rejects(loadPublicUrl("http://article.example/private", options), {
    code: "unsafe_url",
  })
  assert.deepEqual(requests, ["/start", "/article", "/private"])
  assert.equal(closedAgents.length, 3)
  assert.equal(pinnedAddresses.length, 3)

  await assert.rejects(loadPublicUrl("http://article.example/unavailable", options), {
    code: "target_http_error",
  })
  assert.equal(closedAgents.length, 4)
  assert.equal(pinnedAddresses.length, 4)
  assert.equal(new Set(closedAgents).size, 4)
  for (const agent of closedAgents) {
    assert.equal(agent.closed, true)
    assert.equal(agent.destroyed, true)
  }
  console.log("Built-in URL client: connection pinning, redirects, extraction, and cleanup passed")
} finally {
  net.connect = originalConnect
  Agent.prototype.close = originalClose
  server.closeAllConnections()
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}
