import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { request as httpRequest } from "node:http"
import { request as httpsRequest, createServer as httpsServer } from "node:https"
import os from "node:os"
import path from "node:path"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node"
import { createReadTool } from "@earendil-works/pi-durable/tools"
import { McpAdmin } from "../dist/admin/mcp.js"
import { ProviderAdmin } from "../dist/admin/providers.js"
import { createAdminServer } from "../dist/admin/server.js"
import { AdminStore } from "../dist/admin/store.js"

// Offline image smoke test. No bot token, provider credentials, or persistent volumes are used.
const directory = await mkdtemp(path.join(os.tmpdir(), "sumire-admin-smoke-"))
const origin = "https://admin.example.test"
const file = path.join(directory, "admin.sqlite")
let store
let admin
let proxy
try {
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      path.join(directory, "key.pem"),
      "-out",
      path.join(directory, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=admin.example.test",
    ],
    { stdio: "ignore" },
  )
  const cert = await readFile(path.join(directory, "cert.pem"))
  const privateFixture = path.join(directory, "private-fixture")
  await writeFile(privateFixture, "isolation-sentinel", { mode: 0o600 })
  const visible = await createReadTool().execute(
    { path: privateFixture },
    { env: new NodeExecutionEnv({ cwd: directory }) },
    BACKGROUND_CONTEXT,
  )
  assert.match(JSON.stringify(visible), /isolation-sentinel/)
  store = new AdminStore(file, 42)
  store.applied(1, true)
  const session = store.createSession("42")
  const runtime = { getProviders: () => [], getModels: () => [] }
  admin = createAdminServer(
    {
      origin,
      host: "127.0.0.1",
      port: 0,
      assets: path.resolve(import.meta.dirname, "../../admin/dist"),
      assetsV2: path.resolve(import.meta.dirname, "../../admin2/dist"),
    },
    {
      store,
      mcp: new McpAdmin(store, directory),
      providers: new ProviderAdmin(runtime, store),
      tools: () => [],
      apply: async () => store.applied(store.snapshot().revision, true),
    },
  )
  await admin.start()
  const backend = admin.server.address()
  proxy = httpsServer(
    { cert, key: await readFile(path.join(directory, "key.pem")) },
    (req, res) => {
      const upstream = httpRequest(
        {
          hostname: "127.0.0.1",
          port: backend.port,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: "admin.example.test" },
        },
        (response) => {
          res.writeHead(response.statusCode, response.headers)
          response.pipe(res)
        },
      )
      upstream.on("error", () => {
        res.writeHead(502)
        res.end()
      })
      req.pipe(upstream)
    },
  )
  await new Promise((resolve, reject) => {
    proxy.once("error", reject)
    proxy.listen(0, "127.0.0.1", resolve)
  })
  const call = (route, method = "GET", data, headers = {}) =>
    new Promise((resolve, reject) => {
      const req = httpsRequest(
        {
          hostname: "127.0.0.1",
          port: proxy.address().port,
          servername: "admin.example.test",
          ca: cert,
          path: route,
          method,
          headers: { host: "admin.example.test", ...headers },
        },
        (res) => {
          const chunks = []
          res.on("data", (chunk) => chunks.push(chunk))
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: Buffer.concat(chunks).toString(),
            }),
          )
        },
      )
      req.on("error", reject)
      if (data) req.write(JSON.stringify(data))
      req.end()
    })
  assert.equal((await call("/healthz")).status, 200)
  assert.equal((await call("/api/settings")).status, 401)
  const root = await call("/")
  assert.equal(root.status, 200)
  assert.match(root.body, /assets\//)
  const v2 = await call("/v2/audit")
  assert.equal(v2.status, 200)
  assert.match(v2.body, /\/v2\/assets\//)
  const auth = {
    cookie: `__Host-sumire-session=${session.value}`,
    origin,
    "x-csrf-token": session.csrf,
    "content-type": "application/json",
  }
  assert.equal((await call("/api/session", "GET", undefined, auth)).status, 200)
  const passkeyStart = await call("/auth/passkey/authenticate/options", "POST", {}, auth)
  assert.equal(passkeyStart.status, 200)
  assert.equal(JSON.parse(passkeyStart.body).userVerification, "required")
  assert.match(String(passkeyStart.headers["set-cookie"]), /HttpOnly; Secure; SameSite=Strict/)
  assert.equal((await call("/auth/telegram")).status, 404)
  assert.equal(
    (await call("/api/apply", "POST", {}, { ...auth, origin: "https://attacker.invalid" })).status,
    403,
  )
  const policy = store.snapshot().policy
  policy.privateUsers.push(43)
  assert.equal((await call("/api/settings", "PUT", { revision: 1, policy }, auth)).status, 200)
  const logout = await call("/api/logout", "POST", {}, auth)
  assert.equal(logout.status, 200)
  assert.match(String(logout.headers["set-cookie"]), /HttpOnly; Secure/)
  assert.equal((await call("/api/session", "GET", undefined, auth)).status, 401)
  await admin.stop()
  admin = undefined
  store.close()
  store = new AdminStore(file, 42)
  assert.deepEqual(store.snapshot().policy.privateUsers, [43])
  assert.equal(store.allows(42), false)
  console.log(
    "Admin offline HTTPS smoke passed: assets, passkey challenge creation, sessions, CSRF, logout, and restart persistence. Same-user file access confirmed: coding tools are not credential-isolated. Live Telegram and providers were not tested.",
  )
} finally {
  await admin?.stop()
  if (proxy) await new Promise((resolve) => proxy.close(resolve))
  store?.close()
  await rm(directory, { recursive: true, force: true })
}
