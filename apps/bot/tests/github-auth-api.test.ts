import { request } from "node:http"
import type { AddressInfo } from "node:net"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import type { GitHubConnection, GitHubFlow } from "@narumitw/sumire-contracts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { McpAdmin } from "../src/admin/mcp.js"
import { ProviderAdmin } from "../src/admin/providers.js"
import { createAdminServer } from "../src/admin/server.js"
import { digest, sessionMaxAgeMs } from "../src/admin/store.js"
import type { GitHubToken } from "../src/github-client.js"
import {
  createGitHubFixture,
  deferred,
  type GitHubFixture,
  githubAccount,
  githubClientId,
  githubSecrets,
  githubToken,
} from "./helpers/github-fixture.js"

let fixture: GitHubFixture
let mcp: McpAdmin
let services: Parameters<typeof createAdminServer>[1]
let server: ReturnType<typeof createAdminServer>
const origin = "https://admin.example.test"
const auth = (session = fixture.session) => ({
  cookie: `__Host-sumire-session=${session.value}`,
  origin,
  "x-csrf-token": session.csrf,
  "content-type": "application/json",
})
function call(
  url = "/api/github/connection",
  method = "GET",
  data?: unknown,
  headers: Record<string, string> = auth(),
  chunked = false,
) {
  return new Promise<{ status: number; body: string; headers: Record<string, unknown> }>(
    (resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port: (server.server.address() as AddressInfo).port,
          path: url,
          method,
          headers: {
            host: "admin.example.test",
            ...(data !== undefined && !chunked
              ? {
                  "content-length": String(
                    Buffer.byteLength(typeof data === "string" ? data : JSON.stringify(data)),
                  ),
                }
              : {}),
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on("data", (chunk) => chunks.push(chunk))
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString(),
              headers: res.headers,
            }),
          )
        },
      )
      req.on("error", reject)
      if (data !== undefined) {
        const text = typeof data === "string" ? data : JSON.stringify(data)
        if (chunked) for (let i = 0; i < text.length; i += 1024) req.write(text.slice(i, i + 1024))
        else req.write(text)
      }
      req.end()
    },
  )
}
const startInput = (replace = false) => ({ revision: fixture.store.snapshot().revision, replace })
const disconnectInput = () => ({ revision: fixture.store.snapshot().revision, confirm: true })
const flowUrl = (id: string, action?: string) =>
  `/api/github/oauth/${id}${action ? `/${action}` : ""}`
const noSecrets = (value: unknown) => {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  for (const secret of Object.values(githubSecrets)) expect(text).not.toContain(secret)
  expect(text).not.toContain(digest(githubSecrets.accessToken))
}
async function start(replace = false) {
  const response = await call("/api/github/oauth", "POST", startInput(replace))
  expect(response.status).toBe(200)
  noSecrets(response.body)
  return JSON.parse(response.body) as GitHubFlow
}
async function authorize(token = githubToken, replace = false) {
  fixture.transport.exchange.mockResolvedValueOnce(token)
  const flow = await start(replace)
  await vi.advanceTimersByTimeAsync(5000)
  const response = await call(flowUrl(flow.id))
  expect(response.status).toBe(200)
  const state = JSON.parse(response.body) as GitHubFlow
  expect(state.status).toBe("authorized")
  noSecrets(response.body)
  return state
}
beforeEach(async () => {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  })
  vi.setSystemTime(new Date("2026-10-28T12:00:00Z"))
  fixture = createGitHubFixture()
  mcp = new McpAdmin(fixture.store, fixture.directory)
  services = {
    store: fixture.store,
    runtime: fixture.runtime,
    github: fixture.github,
    mcp,
    providers: new ProviderAdmin({} as ModelRuntime, fixture.store),
    apply: fixture.apply,
    tools: () => [],
  }
  server = createAdminServer(
    { origin, host: "127.0.0.1", port: 0, assets: fixture.directory },
    services,
  )
  await server.start()
})
afterEach(async () => {
  await server.stop()
  await fixture.close()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("authenticated GitHub administration API", () => {
  it.each([
    ["POST", "/api/github/connection/disconnect", { confirm: true }],
    ["PUT", "/api/runtime-config/GH_TOKEN", { kind: "secret", value: "unauthorized-replacement" }],
    [
      "PUT",
      "/api/runtime-config/GITHUB_OAUTH_CLIENT_ID",
      { kind: "variable", value: "unauthorized-client" },
    ],
  ] as const)(
    "rejects a revoked session after a partial body: %s %s",
    async (method, url, fields) => {
      await fixture.connect()
      const before = fixture.store.snapshot()
      const credential = fixture.runtime.githubCredentials()
      const authenticated = deferred<void>()
      const original = fixture.store.session.bind(fixture.store)
      vi.spyOn(fixture.store, "session").mockImplementation((value, now) => {
        const state = original(value, now)
        authenticated.resolve()
        return state
      })
      let finish = () => {}
      const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request(
          {
            hostname: "127.0.0.1",
            port: (server.server.address() as AddressInfo).port,
            path: url,
            method,
            headers: { host: "admin.example.test", ...auth() },
          },
          (res) => {
            const chunks: Buffer[] = []
            res.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
            res.on("end", () =>
              resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
            )
          },
        )
        req.on("error", reject)
        req.write('{"revision":')
        finish = () => req.end(`${before.revision},${JSON.stringify(fields).slice(1)}`)
      })
      await authenticated.promise
      expect((await call("/api/logout", "POST", {})).status).toBe(200)
      finish()
      const rejected = await response
      expect(rejected.status).toBe(401)
      expect(fixture.store.snapshot()).toEqual(before)
      expect(fixture.runtime.githubCredentials()).toEqual(credential)
      noSecrets(rejected.body)
    },
  )
  it("reads only local metadata on page load and returns no-store security headers", async () => {
    const response = await call()
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({
      mode: "none",
      clientId: githubClientId,
      reconnectRequired: false,
      secretStatus: "ready",
    })
    expect(response.headers["cache-control"]).toBe("no-store")
    expect(response.headers["x-content-type-options"]).toBe("nosniff")
    expect(response.headers["referrer-policy"]).toBe("no-referrer")
    for (const method of Object.values(fixture.transport)) expect(method).not.toHaveBeenCalled()
    noSecrets(response.body)
  })

  it("starts, verifies, saves, and disconnects an account without granting chat or tool permissions", async () => {
    const { store, runtime, transport } = fixture
    const before = store.snapshot()
    const pending = await start()
    expect(pending).toMatchObject({
      status: "pending",
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
    })
    expect((await call()).body).toContain(pending.id)
    transport.exchange.mockResolvedValueOnce({ ...githubToken, scopes: ["read:org"] })
    await vi.advanceTimersByTimeAsync(5000)
    const verified = await call(flowUrl(pending.id))
    expect(JSON.parse(verified.body)).toMatchObject({
      status: "authorized",
      account: githubAccount,
      scopes: ["read:org"],
    })
    expect(verified.body).not.toContain("ABCD-EFGH")
    expect(runtime.values.readSecret("GH_TOKEN")).toBeUndefined()
    const completed = await call(flowUrl(pending.id, "complete"), "POST", {})
    expect(completed.status).toBe(200)
    expect(JSON.parse(completed.body)).toMatchObject({
      status: "completed",
      receipt: { savedRevision: before.revision + 1, application: { status: "applied" } },
    })
    expect(runtime.readSecret("GH_TOKEN")).toBe(githubSecrets.accessToken)
    const connection = await call()
    expect(JSON.parse(connection.body)).toMatchObject({
      mode: "oauth",
      account: githubAccount,
      scopes: ["read:org"],
      reconnectRequired: false,
    })
    const listing = await call("/api/runtime-config")
    expect(listing.body).not.toContain("GITHUB_OAUTH_STATE")
    expect(JSON.parse(listing.body).entries).toContainEqual(
      expect.objectContaining({ name: "GH_TOKEN", kind: "secret", configured: true }),
    )
    const disconnected = await call("/api/github/connection/disconnect", "POST", disconnectInput())
    expect(disconnected.status).toBe(200)
    expect(JSON.parse(disconnected.body)).toMatchObject({
      mode: "none",
      reconnectRequired: false,
      status: "applied",
    })
    expect(runtime.values.readSecret("GH_TOKEN")).toBeUndefined()
    expect(runtime.values.readSecret("GITHUB_OAUTH_STATE")).toBeUndefined()
    expect(store.snapshot().policy).toEqual(before.policy)
    noSecrets([
      verified.body,
      completed.body,
      connection.body,
      disconnected.body,
      listing.body,
      store.listAudit(0),
    ])
    expect(JSON.stringify(store.listAudit(0))).not.toContain("ABCD-EFGH")
  })

  it("requires the configured administrator session before any GitHub operation", async () => {
    const { store, transport } = fixture
    const before = store.snapshot()
    const other = store.createSession("99")
    for (const headers of [{}, auth(other)]) {
      expect((await call(undefined, "GET", undefined, headers)).status).toBe(401)
      expect((await call("/api/github/oauth", "POST", startInput(), headers)).status).toBe(401)
      expect(
        (await call("/api/github/connection/disconnect", "POST", disconnectInput(), headers))
          .status,
      ).toBe(401)
    }
    expect(store.snapshot()).toEqual(before)
    expect(transport.device).not.toHaveBeenCalled()
  })

  it("requires Host, Origin, and CSRF checks for every mutation", async () => {
    const { store, transport } = fixture
    const flow = await start()
    const before = store.snapshot()
    for (const patch of [
      { origin: "https://evil.example.test" },
      { origin: "" },
      { "x-csrf-token": "wrong" },
      { "x-csrf-token": "" },
    ]) {
      for (const [url, data] of [
        ["/api/github/oauth", startInput()],
        [flowUrl(flow.id, "complete"), {}],
        [flowUrl(flow.id, "cancel"), {}],
        ["/api/github/connection/disconnect", disconnectInput()],
      ] as const) {
        const response = await call(url, "POST", data, { ...auth(), ...patch })
        expect(response.status).toBe(403)
        noSecrets(response.body)
      }
    }
    expect(
      (await call(undefined, "GET", undefined, { ...auth(), host: "evil.example.test" })).status,
    ).toBe(400)
    expect(
      (
        await call("/api/github/oauth", "POST", startInput(), {
          ...auth(),
          host: "evil.example.test",
        })
      ).status,
    ).toBe(400)
    expect(store.snapshot()).toEqual(before)
    expect(transport.device).toHaveBeenCalledOnce()
    expect(fixture.github.state(flow.id, fixture.owner).status).toBe("pending")
  })

  it("isolates flows between two cookies for the same administrator", async () => {
    const { store } = fixture
    const first = await authorize()
    const secondSession = store.createSession("42")
    const headers = auth(secondSession)
    expect((await call(flowUrl(first.id), "GET", undefined, headers)).status).toBe(404)
    expect((await call(flowUrl(first.id, "complete"), "POST", {}, headers)).status).toBe(404)
    expect((await call(flowUrl(first.id, "cancel"), "POST", {}, headers)).status).toBe(404)
    expect(JSON.parse((await call(undefined, "GET", undefined, headers)).body)).not.toHaveProperty(
      "flow",
    )
    const completed = await call(flowUrl(first.id, "complete"), "POST", {})
    expect(completed.status).toBe(200)
    expect((await call(flowUrl(first.id), "GET", undefined, headers)).status).toBe(404)
    expect(JSON.parse((await call(undefined, "GET", undefined, headers)).body)).toMatchObject({
      mode: "oauth",
      account: githubAccount,
    })
    expect(JSON.parse((await call(undefined, "GET", undefined, headers)).body)).not.toHaveProperty(
      "flow",
    )
    expect(JSON.parse((await call()).body).flow).toEqual(JSON.parse(completed.body))
  })

  it("enforces route methods and safely reports an unavailable optional service", async () => {
    const flow = await start()
    for (const [url, method] of [
      ["/api/github/connection", "POST"],
      ["/api/github/connection", "DELETE"],
      ["/api/github/oauth", "GET"],
      ["/api/github/oauth", "PUT"],
      [flowUrl(flow.id), "POST"],
      [flowUrl(flow.id), "DELETE"],
      [flowUrl(flow.id, "complete"), "GET"],
      [flowUrl(flow.id, "complete"), "PUT"],
      [flowUrl(flow.id, "cancel"), "GET"],
      [flowUrl(flow.id, "cancel"), "DELETE"],
      ["/api/github/connection/disconnect", "GET"],
      ["/api/github/connection/disconnect", "PUT"],
    ])
      expect((await call(url, method, method === "GET" ? undefined : {})).status).toBe(405)
    services.github = undefined
    expect((await call()).status).toBe(503)
    expect((await call("/api/github/oauth", "POST", startInput())).status).toBe(503)
    expect((await call(flowUrl(flow.id))).status).toBe(503)
  })

  it("rejects raw protocol inputs, unknown fields, and malformed revisions before issuing requests", async () => {
    const before = fixture.store.snapshot()
    for (const data of [
      {},
      { revision: before.revision },
      { ...startInput(), replace: "false" },
      { ...startInput(), revision: 0 },
      { ...startInput(), revision: 1.5 },
      { ...startInput(), revision: Number.MAX_SAFE_INTEGER + 1 },
      { ...startInput(), revision: "2" },
      { ...startInput(), clientId: "attacker-client" },
      { ...startInput(), scope: "admin:org" },
      { ...startInput(), deviceCode: githubSecrets.deviceCode },
      { ...startInput(), accessToken: githubSecrets.accessToken },
      { ...startInput(), verificationUri: "https://evil.example.test" },
      { ...startInput(), error: githubSecrets.upstreamError },
    ]) {
      const response = await call("/api/github/oauth", "POST", data)
      expect(response.status).toBe(400)
      noSecrets(response.body)
    }
    expect(fixture.transport.device).not.toHaveBeenCalled()
    expect(fixture.store.snapshot()).toEqual(before)
    noSecrets(fixture.store.listAudit(0))
  })

  it("requires empty strict completion/cancellation bodies and explicit disconnect confirmation", async () => {
    const flow = await authorize()
    const before = fixture.store.snapshot()
    for (const action of ["complete", "cancel"]) {
      for (const input of [
        [],
        null,
        { token: githubSecrets.accessToken },
        { confirm: true },
        { revision: before.revision },
      ]) {
        const response = await call(flowUrl(flow.id, action), "POST", input)
        expect(response.status).toBe(400)
        noSecrets(response.body)
      }
    }
    for (const input of [
      { revision: before.revision },
      { ...disconnectInput(), confirm: false },
      { ...disconnectInput(), confirm: "true" },
      { ...disconnectInput(), revision: 0 },
      { ...disconnectInput(), value: githubSecrets.refreshToken },
    ]) {
      const response = await call("/api/github/connection/disconnect", "POST", input)
      expect(response.status).toBe(400)
      noSecrets(response.body)
    }
    expect(fixture.store.snapshot()).toEqual(before)
    expect(fixture.github.state(flow.id, fixture.owner).status).toBe("authorized")
  })

  it("enforces JSON and a streamed request-size bound without reflecting the body", async () => {
    expect(
      (
        await call("/api/github/oauth", "POST", startInput(), {
          ...auth(),
          "content-type": "text/plain",
        })
      ).status,
    ).toBe(415)
    expect((await call("/api/github/oauth", "POST", "{")).status).toBe(400)
    const response = await call(
      "/api/github/oauth",
      "POST",
      { ...startInput(), secret: `${githubSecrets.upstreamError}${"x".repeat(66_000)}` },
      auth(),
      true,
    )
    expect(response.status).toBe(413)
    expect(response.body).not.toContain("xxxxx")
    noSecrets(response.body)
    expect(fixture.transport.device).not.toHaveBeenCalled()
  })

  it("rate-limits mutations before they can start upstream requests", async () => {
    for (let i = 0; i < 60; i++)
      expect((await call("/api/github/oauth", "POST", {})).status).toBe(400)
    const response = await call("/api/github/oauth", "POST", startInput())
    expect(response.status).toBe(429)
    expect(response.headers["retry-after"]).toBe("60")
    expect(fixture.transport.device).not.toHaveBeenCalled()
  })

  it("rejects stale starts and requires explicit consent before replacing a PAT", async () => {
    const { store, runtime, transport } = fixture
    const stale = startInput()
    fixture.save("GH_TOKEN", "manual-pat-api-fixture")
    expect((await call("/api/github/oauth", "POST", stale)).status).toBe(409)
    expect((await call("/api/github/oauth", "POST", startInput())).status).toBe(409)
    expect(transport.device).not.toHaveBeenCalled()
    const before = store.snapshot()
    const flow = await authorize(githubToken, true)
    expect(runtime.readSecret("GH_TOKEN")).toBe("manual-pat-api-fixture")
    expect(store.snapshot()).toEqual(before)
    const cancelled = await call(flowUrl(flow.id, "cancel"), "POST", {})
    expect(cancelled.status).toBe(200)
    expect(JSON.parse(cancelled.body).status).toBe("cancelled")
    expect(runtime.readSecret("GH_TOKEN")).toBe("manual-pat-api-fixture")
    noSecrets(cancelled.body)
  })

  it("rechecks original revision and MCP probes at completion, without changing the old credential", async () => {
    const { store, runtime } = fixture
    fixture.save("GH_TOKEN", "original-pat-api-fixture")
    vi.spyOn(mcp.probes, "size", "get").mockReturnValue(1)
    expect((await call("/api/github/oauth", "POST", startInput(true))).status).toBe(409)
    vi.restoreAllMocks()
    const flow = await authorize(githubToken, true)
    vi.spyOn(mcp.probes, "size", "get").mockReturnValue(1)
    expect((await call(flowUrl(flow.id, "complete"), "POST", {})).status).toBe(409)
    expect(runtime.readSecret("GH_TOKEN")).toBe("original-pat-api-fixture")
    vi.restoreAllMocks()
    fixture.save("LATER", "changed", "variable")
    const revision = store.snapshot().revision
    const conflict = await call(flowUrl(flow.id, "complete"), "POST", {})
    expect(conflict.status).toBe(200)
    expect(JSON.parse(conflict.body).status).toBe("conflict")
    expect(store.snapshot().revision).toBe(revision)
    expect(runtime.readSecret("GH_TOKEN")).toBe("original-pat-api-fixture")
  })

  it("does not report completion before verification and commits twice only once", async () => {
    const { store, apply, transport } = fixture
    const pending = await start()
    expect((await call(flowUrl(pending.id, "complete"), "POST", {})).status).toBe(409)
    transport.exchange.mockResolvedValueOnce(githubToken)
    await vi.advanceTimersByTimeAsync(5000)
    const before = store.snapshot()
    const [first, second] = await Promise.all([
      call(flowUrl(pending.id, "complete"), "POST", {}),
      call(flowUrl(pending.id, "complete"), "POST", {}),
    ])
    expect(first.status).toBe(200)
    expect(second.body).toBe(first.body)
    expect(store.snapshot().revision).toBe(before.revision + 1)
    expect(apply).toHaveBeenCalledOnce()
    expect(transport.exchange).toHaveBeenCalledOnce()
    expect(store.listAudit(0).filter((entry) => entry.operation === "github.connect")).toHaveLength(
      1,
    )
    expect((await call(flowUrl(pending.id, "cancel"), "POST", {})).body).toBe(first.body)
    noSecrets([first.body, second.body, store.listAudit(0)])
  })

  it("recovers a lost failed-application completion after a newer revision and retries apply only", async () => {
    const { store, apply, runtime, transport } = fixture
    apply.mockRejectedValueOnce(new Error(githubSecrets.upstreamError))
    const flow = await authorize()
    // Treat the completion response as lost. Recovery must use local, owner-bound reads.
    expect((await call(flowUrl(flow.id, "complete"), "POST", {})).status).toBe(200)
    const savedRevision = store.snapshot().revision
    apply.mockRejectedValueOnce(new Error(githubSecrets.upstreamError))
    const newer = await call("/api/runtime-config/LATER", "PUT", {
      revision: savedRevision,
      kind: "variable",
      value: "newer revision",
    })
    expect(newer.status).toBe(200)
    const recovered = await call()
    const connection = JSON.parse(recovered.body) as GitHubConnection
    expect(connection).toMatchObject({
      revision: savedRevision + 1,
      status: "failed",
      mode: "oauth",
      flow: {
        id: flow.id,
        status: "completed",
        receipt: { savedRevision, application: { revision: savedRevision, status: "failed" } },
      },
    })
    expect(JSON.parse((await call(flowUrl(flow.id))).body)).toEqual(connection.flow)
    const beforeRetry = store.snapshot().revision
    const applyCalls = apply.mock.calls.length
    expect((await call(flowUrl(flow.id, "complete"), "POST", {})).status).toBe(200)
    expect(apply).toHaveBeenCalledTimes(applyCalls)
    expect(runtime.readSecret("GH_TOKEN")).toBeUndefined()
    const retry = await call("/api/apply", "POST", {})
    expect(retry.status).toBe(200)
    expect(store.snapshot().revision).toBe(beforeRetry)
    expect(runtime.readSecret("GH_TOKEN")).toBe(githubSecrets.accessToken)
    expect(JSON.parse((await call()).body).flow).toEqual(connection.flow)
    expect(transport.device).toHaveBeenCalledOnce()
    expect(transport.exchange).toHaveBeenCalledOnce()
    expect(store.listAudit(0).filter((entry) => entry.operation === "github.connect")).toHaveLength(
      1,
    )
    noSecrets([newer.body, recovered.body, retry.body, store.listAudit(0)])
  })

  it("keeps an unknown saved-revision outcome separate when a newer revision wins during apply", async () => {
    const { store, apply } = fixture
    const flow = await authorize()
    const entered = deferred<void>()
    const applying = deferred<void>()
    apply.mockImplementationOnce(async () => {
      entered.resolve()
      await applying.promise
    })
    const completing = call(flowUrl(flow.id, "complete"), "POST", {})
    try {
      await Promise.race([
        entered.promise,
        completing.then(() => {
          throw new Error("Completion returned before application started")
        }),
      ])
      const savedRevision = store.snapshot().revision
      const newer = await call("/api/runtime-config/LATER", "PUT", {
        revision: savedRevision,
        kind: "variable",
        value: "newer",
      })
      expect(newer.status).toBe(200)
      applying.reject(new Error(githubSecrets.upstreamError))
      const completed = await completing
      expect(completed.status).toBe(200)
      expect(JSON.parse(completed.body)).toMatchObject({
        status: "completed",
        receipt: { savedRevision, application: { revision: savedRevision, status: "unknown" } },
      })
      expect(JSON.parse((await call()).body)).toMatchObject({
        revision: savedRevision + 1,
        status: "applied",
        flow: JSON.parse(completed.body),
      })
      noSecrets(completed.body)
    } finally {
      applying.resolve()
      await completing
    }
  })

  it("does not turn an applied commit into failure when apply throws after recording success", async () => {
    const { store, apply, runtime } = fixture
    const flow = await authorize()
    apply.mockImplementationOnce(async () => {
      store.applied(store.snapshot().revision, true)
      throw new Error(githubSecrets.upstreamError)
    })
    const completed = await call(flowUrl(flow.id, "complete"), "POST", {})
    expect(completed.status).toBe(200)
    expect(JSON.parse(completed.body)).toMatchObject({
      status: "completed",
      receipt: { application: { status: "applied" } },
    })
    expect(runtime.readSecret("GH_TOKEN")).toBe(githubSecrets.accessToken)
    noSecrets(completed.body)
  })

  it("rolls back paired persistence without leaking a raw database error", async () => {
    const { store, runtime, apply } = fixture
    fixture.save("GH_TOKEN", "old-manual-api-pat")
    const flow = await authorize(githubToken, true)
    const before = store.snapshot()
    const audit = store.listAudit(0)
    store.db.exec(
      "CREATE TRIGGER reject_api_github BEFORE INSERT ON runtime_config WHEN NEW.name='GITHUB_OAUTH_STATE' BEGIN SELECT RAISE(ABORT,'github-fixture-private-upstream-error'); END",
    )
    const response = await call(flowUrl(flow.id, "complete"), "POST", {})
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body).status).toBe("failed")
    expect(store.snapshot()).toEqual(before)
    expect(store.listAudit(0)).toEqual(audit)
    expect(runtime.readSecret("GH_TOKEN")).toBe("old-manual-api-pat")
    expect(apply).not.toHaveBeenCalled()
    noSecrets(response.body)
  })

  it("enforces locked storage, capacity, and kind checks before issuing a device request", async () => {
    const { runtime, store, transport } = fixture
    fixture.save("GH_TOKEN", "wrong-kind", "variable")
    expect((await call("/api/github/oauth", "POST", startInput(true))).status).toBe(409)
    runtime.remove("GH_TOKEN", store.snapshot().revision, "42")
    store.applied(store.snapshot().revision, true)
    for (let i = 0; i < 254; i++)
      runtime.values.setVariable(`FILL_${i}`, "fixture", {
        revision: store.snapshot().revision,
        updatedAt: Date.now(),
      })
    expect((await call("/api/github/oauth", "POST", startInput())).status).toBe(400)
    store.db.prepare("DELETE FROM runtime_config WHERE name LIKE 'FILL_%'").run()
    fixture.save("SECRET", "fixture")
    store.db.prepare("UPDATE runtime_config SET payload='{}' WHERE name='SECRET'").run()
    expect(runtime.values.verifySecrets()).toBe(false)
    const locked = await call("/api/github/oauth", "POST", startInput())
    expect(locked.status).toBe(503)
    expect(transport.device).not.toHaveBeenCalled()
    noSecrets(locked.body)
  })

  it.each(["orphan", "collision"])(
    "requires explicit paired reset for %s data and never overwrites it to start login",
    async (kind) => {
      const { runtime, store, transport } = fixture
      const sentinel = "legacy-companion-collision-private-value"
      if (kind === "orphan") {
        const flow = await authorize()
        expect((await call(flowUrl(flow.id, "complete"), "POST", {})).status).toBe(200)
        store.db.prepare("DELETE FROM runtime_config WHERE name='GH_TOKEN'").run()
      } else {
        fixture.save("GH_TOKEN", "old-manual-api-pat")
        runtime.values.setVariable("GITHUB_OAUTH_STATE", sentinel, {
          revision: store.snapshot().revision,
          updatedAt: Date.now(),
        })
      }
      const attempts = transport.device.mock.calls.length
      const before = store.snapshot()
      const invalid = await call()
      expect(JSON.parse(invalid.body)).toMatchObject({ mode: "invalid", reconnectRequired: true })
      expect(invalid.body).not.toContain(sentinel)
      const listing = await call("/api/runtime-config")
      expect(listing.body).not.toContain("GITHUB_OAUTH_STATE")
      expect(listing.body).not.toContain(sentinel)
      expect((await call("/api/github/oauth", "POST", startInput(true))).status).toBe(409)
      expect(transport.device).toHaveBeenCalledTimes(attempts)
      expect(
        (
          await call("/api/github/connection/disconnect", "POST", {
            revision: before.revision,
            confirm: false,
          })
        ).status,
      ).toBe(400)
      expect(store.snapshot()).toEqual(before)
      expect(
        (
          await call("/api/github/connection/disconnect", "POST", {
            revision: before.revision - 1,
            confirm: true,
          })
        ).status,
      ).toBe(409)
      const reset = await call("/api/github/connection/disconnect", "POST", disconnectInput())
      expect(reset.status).toBe(200)
      expect(JSON.parse(reset.body)).toMatchObject({ mode: "none", reconnectRequired: false })
      expect(runtime.values.listMetadata().map((entry) => entry.name)).not.toContain(
        "GITHUB_OAUTH_STATE",
      )
      expect(runtime.values.listMetadata().map((entry) => entry.name)).not.toContain("GH_TOKEN")
      expect(store.listAudit(0)).toContainEqual(
        expect.objectContaining({
          operation: "github.disconnect",
          target: "GH_TOKEN,GITHUB_OAUTH_STATE",
        }),
      )
      noSecrets([invalid.body, listing.body, reset.body, store.listAudit(0)])
      expect(JSON.stringify(store.listAudit(0))).not.toContain(sentinel)
    },
  )

  it("protects paired disconnect with MCP references and the probe interlock", async () => {
    const { store, runtime } = fixture
    const flow = await authorize()
    await call(flowUrl(flow.id, "complete"), "POST", {})
    vi.spyOn(mcp.probes, "size", "get").mockReturnValue(1)
    expect(
      (await call("/api/github/connection/disconnect", "POST", disconnectInput())).status,
    ).toBe(409)
    vi.restoreAllMocks()
    store.db
      .prepare("INSERT INTO mcp VALUES (?,?)")
      .run(
        "disabled-server",
        JSON.stringify({ command: "fixture", enabled: false, env: { TOKEN: `\${GH_TOKEN}` } }),
      )
    const response = await call("/api/github/connection/disconnect", "POST", disconnectInput())
    expect(response.status).toBe(409)
    expect(response.body).toContain("disabled-server")
    expect(response.body).not.toContain(`\${GH_TOKEN}`)
    expect(runtime.values.readSecret("GH_TOKEN")).toBe(githubSecrets.accessToken)
    noSecrets(response.body)
  })

  it("does not expose or permit generic edits of server-owned OAuth state", async () => {
    const { store, runtime } = fixture
    const before = store.snapshot()
    for (const method of ["PUT", "DELETE"]) {
      const response = await call(
        "/api/runtime-config/GITHUB_OAUTH_STATE",
        method,
        method === "PUT"
          ? { revision: before.revision, kind: "secret", value: githubSecrets.refreshToken }
          : { revision: before.revision },
      )
      expect(response.status).toBe(400)
      noSecrets(response.body)
    }
    expect(store.snapshot()).toEqual(before)
    expect(runtime.readSecret("GITHUB_OAUTH_STATE")).toBeUndefined()
    expect(runtime.readVariable("GITHUB_OAUTH_STATE")).toBeUndefined()
  })

  it("cancels on logout without browser polls and rejects the old cookie", async () => {
    const { transport } = fixture
    const flow = await start()
    const logout = await call("/api/logout", "POST", {})
    expect(logout.status).toBe(200)
    expect(transport.device.mock.calls[0]?.[1].aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(transport.exchange).not.toHaveBeenCalled()
    expect((await call(flowUrl(flow.id))).status).toBe(401)
    expect((await call()).status).toBe(401)
    noSecrets(logout.body)
  })

  it("expires a revoked session in the background without status requests", async () => {
    const { store, transport, owner } = fixture
    await start()
    store.db
      .prepare("UPDATE sessions SET created=? WHERE hash=?")
      .run(Date.now() - sessionMaxAgeMs + 2000, owner)
    await vi.advanceTimersByTimeAsync(2000)
    expect(transport.device.mock.calls[0]?.[1].aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(5000)
    expect(transport.exchange).not.toHaveBeenCalled()
    expect((await call()).status).toBe(401)
  })

  it("cancels an exchange and cannot persist a late successful response", async () => {
    const { transport, runtime, store } = fixture
    const response = deferred<GitHubToken>()
    transport.exchange.mockReturnValueOnce(response.promise)
    const flow = await start()
    await vi.advanceTimersByTimeAsync(5000)
    const cancelling = call(flowUrl(flow.id, "cancel"), "POST", {})
    // Wait until the request has reached the service, not merely the HTTP socket.
    const aborted = deferred<void>()
    const signal = transport.device.mock.calls[0]?.[1]
    signal?.addEventListener("abort", () => aborted.resolve(), { once: true })
    if (signal?.aborted) aborted.resolve()
    try {
      await Promise.race([
        aborted.promise,
        cancelling.then(() => {
          throw new Error("Cancellation returned before aborting the request")
        }),
      ])
      response.resolve(githubToken)
      const cancelled = await cancelling
      expect(cancelled.status).toBe(200)
      expect(JSON.parse(cancelled.body).status).toBe("cancelled")
      expect(runtime.values.readSecret("GH_TOKEN")).toBeUndefined()
      expect(transport.account).not.toHaveBeenCalled()
      expect(store.listAudit(0).filter((entry) => entry.operation === "github.connect")).toEqual([])
      noSecrets(cancelled.body)
    } finally {
      response.resolve(githubToken)
      await cancelling
    }
  })

  it("rejects late success after API deletion and recreation of the same PAT", async () => {
    const { transport, runtime, store } = fixture
    fixture.save("GH_TOKEN", "same-api-pat")
    const response = deferred<GitHubToken>()
    transport.exchange.mockReturnValueOnce(response.promise)
    const flow = await start(true)
    await vi.advanceTimersByTimeAsync(5000)
    try {
      const removed = await call("/api/runtime-config/GH_TOKEN", "DELETE", {
        revision: store.snapshot().revision,
      })
      expect(removed.status).toBe(200)
      const recreated = await call("/api/runtime-config/GH_TOKEN", "PUT", {
        revision: store.snapshot().revision,
        kind: "secret",
        value: "same-api-pat",
      })
      expect(recreated.status).toBe(200)
      response.resolve(githubToken)
      await vi.advanceTimersByTimeAsync(0)
      const state = await call(flowUrl(flow.id))
      expect(JSON.parse(state.body).status).toBe("conflict")
      expect(runtime.readSecret("GH_TOKEN")).toBe("same-api-pat")
      expect(runtime.values.readSecret("GITHUB_OAUTH_STATE")).toBeUndefined()
      expect(transport.account).not.toHaveBeenCalled()
      noSecrets(state.body)
    } finally {
      response.resolve(githubToken)
    }
  })

  it("stops pending GitHub work before closing HTTP and storage", async () => {
    const { transport } = fixture
    await start()
    await server.stop()
    expect(transport.device.mock.calls[0]?.[1].aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(transport.exchange).not.toHaveBeenCalled()
  })
})
