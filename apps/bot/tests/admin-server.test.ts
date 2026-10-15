import { mkdtempSync, rmSync } from "node:fs"
import { request as httpRequest } from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { McpAdmin } from "../src/admin/mcp.js"
import { ProviderAdmin } from "../src/admin/providers.js"
import { createAdminServer } from "../src/admin/server.js"
import { AdminStore } from "../src/admin/store.js"

let directory: string
let store: AdminStore
let server: ReturnType<typeof createAdminServer>
let value: string
let csrf: string
let runtime: ModelRuntime
const apply = vi.fn(async () => {
  store.applied(store.snapshot().revision, true)
})
function call(url: string, method = "GET", data?: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>(
    (resolve, reject) => {
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          port: (server.server.address() as AddressInfo).port,
          path: url,
          method,
          headers: { host: "admin.example.test", ...headers },
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on("data", (chunk) => chunks.push(chunk))
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString(),
            }),
          )
        },
      )
      req.on("error", reject)
      if (data !== undefined) req.write(typeof data === "string" ? data : JSON.stringify(data))
      req.end()
    },
  )
}
const auth = () => ({
  cookie: `__Host-sumire-session=${value}`,
  origin: "https://admin.example.test",
  "x-csrf-token": csrf,
  "content-type": "application/json",
})
beforeEach(async () => {
  directory = mkdtempSync(path.join(os.tmpdir(), "sumire-admin-http-"))
  store = new AdminStore(path.join(directory, "admin.sqlite"), new Set([42]), 42)
  store.applied(1, true)
  const session = store.createSession("42")
  value = session.value
  csrf = session.csrf
  runtime = {
    getProviders: () => [],
    getProvider: (id: string) =>
      id === "fixture" ? { auth: { apiKey: { login: true } } } : undefined,
    login: vi.fn(async () => ({})),
    getRegisteredProviderIds: () => [],
    getModels: () => [],
    getModel: () => undefined,
  } as unknown as ModelRuntime
  server = createAdminServer(
    {
      origin: "https://admin.example.test",
      clientId: "test",
      clientSecret: "fixture-not-a-secret",
      host: "127.0.0.1",
      port: 0,
      assets: directory,
    },
    {
      store,
      providers: new ProviderAdmin(runtime, store),
      mcp: new McpAdmin(store, directory),
      apply,
      tools: () => ["read"],
    },
  )
  await server.start()
})
afterEach(async () => {
  await server.stop()
  store.close()
  rmSync(directory, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe("admin HTTP security", () => {
  it("revision-checks credential writes and reports upstream failures without secrets", async () => {
    const route = "/api/providers/fixture/credential"
    const success = await call(route, "POST", { key: "literal-fixture", revision: 1 }, auth())
    expect(success.status).toBe(200)
    expect(success.body).not.toContain("literal-fixture")
    expect(store.snapshot().revision).toBe(2)
    expect((await call(route, "POST", { key: "stale-fixture", revision: 1 }, auth())).status).toBe(
      409,
    )
    expect((await call(route, "POST", { key: "!command", revision: 2 }, auth())).status).toBe(400)
    expect(store.snapshot().revision).toBe(2)
    vi.mocked(runtime.login).mockRejectedValueOnce(new Error("upstream-secret-fixture"))
    const failed = await call(route, "POST", { key: "replacement-fixture", revision: 2 }, auth())
    expect(failed.status).toBe(500)
    expect(failed.body).not.toContain("upstream-secret-fixture")
    expect(failed.body).not.toContain("replacement-fixture")
    expect(store.snapshot().status).toBe("failed")
    expect(store.allows(42)).toBe(false)
    expect((await call("/api/session", "GET", undefined, auth())).status).toBe(200)
    expect(JSON.stringify(store.listAudit(0))).not.toContain("literal-fixture")
    expect(JSON.stringify(store.listAudit(0))).not.toContain("replacement-fixture")
    expect(store.listAudit(0)).toContainEqual(
      expect.objectContaining({ target: "provider:fixture" }),
    )
  })
  it("bounds login starts and total requests without trusting forwarded client addresses", async () => {
    for (let i = 0; i < 10; i++) expect((await call("/auth/telegram")).status).toBe(302)
    expect((await call("/auth/telegram")).status).toBe(429)
    let response = await call("/healthz")
    for (let i = 0; i < 240; i++)
      response = await call("/healthz", "GET", undefined, {
        "x-forwarded-for": `198.51.100.${i % 255}`,
      })
    expect(response.status).toBe(429)
    expect(response.headers["retry-after"]).toBe("60")
  })
  it("requires authentication across management routes", async () => {
    for (const route of [
      "settings",
      "session",
      "inventory",
      "chats",
      "audit",
      "providers/openai/test",
      "mcp/demo",
      "oauth/unknown",
    ])
      expect((await call(`/api/${route}`)).status).toBe(401)
  })
  it("requires Origin and CSRF for all mutations", async () => {
    for (const route of [
      "settings",
      "logout",
      "apply",
      "providers/openai/credential",
      "providers/openai/oauth",
      "mcp/demo",
    ]) {
      expect((await call(`/api/${route}`, "POST", {}, { cookie: auth().cookie })).status).toBe(403)
      expect(
        (await call(`/api/${route}`, "POST", {}, { ...auth(), origin: "https://attacker.invalid" }))
          .status,
      ).toBe(403)
    }
  })
  it("ignores forged proxy headers and requires the registered host", async () => {
    expect(
      (
        await call("/api/settings", "GET", undefined, {
          ...auth(),
          host: "attacker.invalid",
          "x-forwarded-host": "admin.example.test",
        })
      ).status,
    ).toBe(400)
    expect((await call("/api/settings", "GET", undefined, auth())).status).toBe(200)
  })
  it("saves valid settings, applies them, and rejects stale revisions", async () => {
    const policy = store.snapshot().policy
    policy.privateUsers.push(43)
    const first = await call("/api/settings", "PUT", { revision: 1, policy }, auth())
    expect(first.status).toBe(200)
    expect(JSON.parse(first.body)).toMatchObject({ revision: 2, applied: 2, status: "applied" })
    expect((await call("/api/settings", "PUT", { revision: 1, policy }, auth())).status).toBe(409)
    expect(apply).toHaveBeenCalledTimes(1)
  })
  it("rejects oversized and malformed bodies without leaking input", async () => {
    expect((await call("/api/settings", "PUT", "x".repeat(262145), auth())).status).toBe(413)
    const malformed = await call("/api/settings", "PUT", '{"credential":"fixture-value"', auth())
    expect(malformed.status).toBe(400)
    expect(malformed.body).not.toContain("fixture-value")
  })
  it("binds login to a one-use transaction and sends secure cookies", async () => {
    const started = await call("/auth/telegram")
    expect(started.status).toBe(302)
    const cookies = String(started.headers["set-cookie"])
    expect(cookies).toContain("__Host-sumire-login=")
    expect(cookies).toContain("Secure; SameSite=Lax")
    const location = new URL(String(started.headers.location))
    expect(location.searchParams.get("scope")).toBe("openid profile")
    expect(location.searchParams.get("code_challenge_method")).toBe("S256")
    const browserCookie = cookies.split(";")[0] as string
    expect(
      (
        await call("/auth/callback?code=fixture&state=wrong", "GET", undefined, {
          cookie: browserCookie,
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await call(
          `/auth/callback?code=fixture&state=${location.searchParams.get("state")}`,
          "GET",
          undefined,
          { cookie: browserCookie },
        )
      ).status,
    ).toBe(403)
  })
  it("revokes the session on logout and adds security headers", async () => {
    const response = await call("/api/logout", "POST", {}, auth())
    expect(response.status).toBe(200)
    expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'")
    expect(response.headers["referrer-policy"]).toBe("no-referrer")
    expect((await call("/api/session", "GET", undefined, auth())).status).toBe(401)
  })
})
