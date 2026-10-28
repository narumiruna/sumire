import { randomBytes } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { request } from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { McpAdmin } from "../src/admin/mcp.js"
import { ProviderAdmin } from "../src/admin/providers.js"
import { RuntimeConfigAdmin } from "../src/admin/runtime-config.js"
import { createAdminServer } from "../src/admin/server.js"
import { AdminStore } from "../src/admin/store.js"

let directory: string
let store: AdminStore
let runtime: RuntimeConfigAdmin
let mcp: McpAdmin
let services: Parameters<typeof createAdminServer>[1]
let server: ReturnType<typeof createAdminServer>
let session: { value: string; csrf: string }
const apply = vi.fn(async () => {
  store.applied(store.snapshot().revision, true)
})
const auth = () => ({
  cookie: `__Host-sumire-session=${session.value}`,
  origin: "https://admin.example.test",
  "x-csrf-token": session.csrf,
  "content-type": "application/json",
})
function call(
  url = "/api/runtime-config",
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
const mutation = (kind = "secret", value = "synthetic-secret") => ({
  revision: store.snapshot().revision,
  kind,
  value,
})
beforeEach(async () => {
  directory = mkdtempSync(path.join(os.tmpdir(), "sumire-runtime-api-"))
  store = new AdminStore(path.join(directory, "admin.sqlite"), 42)
  store.applied(1, true)
  session = store.createSession("42")
  runtime = new RuntimeConfigAdmin(store, randomBytes(32).toString("base64"))
  mcp = new McpAdmin(store, directory)
  services = {
    store,
    runtime,
    mcp,
    providers: new ProviderAdmin({} as ModelRuntime, store),
    apply,
    tools: () => [],
  }
  server = createAdminServer(
    { origin: "https://admin.example.test", host: "127.0.0.1", port: 0, assets: directory },
    services,
  )
  await server.start()
})
afterEach(async () => {
  await server.stop()
  store.close()
  rmSync(directory, { recursive: true, force: true })
  vi.restoreAllMocks()
  apply.mockReset()
  apply.mockImplementation(async () => {
    store.applied(store.snapshot().revision, true)
  })
})

describe("authenticated runtime configuration API", () => {
  it("never serializes secrets and applies committed mutations without changing policy grants", async () => {
    const before = store.snapshot()
    const secret = "synthetic-secret-value"
    const saved = await call("/api/runtime-config/KEY", "PUT", mutation("secret", secret))
    expect(saved.status).toBe(200)
    expect(saved.body).not.toContain(secret)
    expect(JSON.parse(saved.body)).toMatchObject({
      revision: before.revision + 1,
      applied: before.revision + 1,
      status: "applied",
      secretStatus: "ready",
      entries: [{ name: "KEY", kind: "secret", configured: true }],
    })
    expect(runtime.readSecret("KEY")).toBe(secret)
    expect(store.snapshot().policy).toEqual(before.policy)
    const listing = await call()
    expect(listing.body).not.toContain(secret)
    expect(listing.headers["cache-control"]).toBe("no-store")
    expect(listing.headers["x-content-type-options"]).toBe("nosniff")
    const variable = await call(
      "/api/runtime-config/LITERAL",
      "PUT",
      mutation("variable", ` \${KEY}\n`),
    )
    expect(variable.status).toBe(200)
    expect(JSON.parse(variable.body).entries).toContainEqual(
      expect.objectContaining({ kind: "variable", value: ` \${KEY}\n` }),
    )
    const deleted = await call("/api/runtime-config/KEY", "DELETE", {
      revision: store.snapshot().revision,
    })
    expect(deleted.status).toBe(200)
    expect(runtime.readSecret("KEY")).toBeUndefined()
    expect(JSON.stringify(store.listAudit(0))).not.toContain(secret)
  })
  it("requires the configured administrator, session, Host, Origin and CSRF", async () => {
    const before = store.snapshot()
    expect((await call(undefined, "GET", undefined, {})).status).toBe(401)
    const other = store.createSession("99")
    expect(
      (
        await call(undefined, "GET", undefined, {
          ...auth(),
          cookie: `__Host-sumire-session=${other.value}`,
        })
      ).status,
    ).toBe(401)
    for (const patch of [
      { origin: "https://evil.example.test" },
      { "x-csrf-token": "wrong" },
      { origin: "" },
    ]) {
      const response = await call("/api/runtime-config/KEY", "PUT", mutation(), {
        ...auth(),
        ...patch,
      })
      expect(response.status).toBe(403)
      expect(response.body).not.toContain("synthetic-secret")
    }
    expect(
      (await call(undefined, "GET", undefined, { ...auth(), host: "evil.example.test" })).status,
    ).toBe(400)
    expect(store.snapshot()).toEqual(before)
    expect(runtime.snapshot().entries).toEqual([])
    store.revoke(session.value)
    expect((await call()).status).toBe(401)
  })
  it("enforces route methods and makes missing optional services safely unavailable", async () => {
    for (const [url, method] of [
      ["/api/runtime-config", "POST"],
      ["/api/runtime-config", "PUT"],
      ["/api/runtime-config/KEY", "POST"],
      ["/api/runtime-config/KEY", "GET"],
      ["/api/runtime-config/KEY", "PATCH"],
    ])
      expect((await call(url, method)).status).toBe(405)
    services.runtime = undefined
    expect((await call()).status).toBe(503)
    expect((await call("/api/runtime-config/KEY", "PUT", mutation())).status).toBe(503)
  })
  it("enforces JSON, strict mutations, per-value bounds and streamed 64 KiB limit", async () => {
    expect(
      (
        await call("/api/runtime-config/KEY", "PUT", mutation(), {
          ...auth(),
          "content-type": "text/plain",
        })
      ).status,
    ).toBe(415)
    expect((await call("/api/runtime-config/KEY", "PUT", "{")).status).toBe(400)
    for (const input of [
      { revision: 1, kind: "secret" },
      mutation("secret", ""),
      mutation("other"),
      { ...mutation(), value: null },
      { ...mutation(), extra: "ignored?" },
      mutation("variable", "終".repeat(2731)),
    ])
      expect((await call("/api/runtime-config/KEY", "PUT", input)).status).toBe(400)
    const streamed = await call(
      "/api/runtime-config/KEY",
      "PUT",
      mutation("secret", "x".repeat(66000)),
      auth(),
      true,
    )
    expect(streamed.status).toBe(413)
    expect(streamed.body).not.toContain("xxxxx")
    expect(store.snapshot().revision).toBe(1)
    expect(runtime.snapshot().entries).toEqual([])
  })
  it("rejects stale revisions, kind changes, reserved names and failed persistence atomically", async () => {
    const original = mutation()
    expect((await call("/api/runtime-config/KEY", "PUT", original)).status).toBe(200)
    const before = store.snapshot()
    const audits = store.listAudit(0)
    expect((await call("/api/runtime-config/KEY", "PUT", original)).status).toBe(409)
    expect(
      (await call("/api/runtime-config/KEY", "PUT", mutation("variable", "disclosure"))).status,
    ).toBe(409)
    expect((await call("/api/runtime-config/ADMIN_KEY", "PUT", mutation())).status).toBe(400)
    store.db.exec(
      `CREATE TRIGGER reject_runtime BEFORE INSERT ON runtime_config BEGIN SELECT RAISE(ABORT,'synthetic-private-error'); END`,
    )
    const failed = await call("/api/runtime-config/NEW_KEY", "PUT", mutation())
    expect(failed.status).toBe(500)
    expect(failed.body).toBe('{"error":"Operation failed"}')
    expect(store.snapshot()).toEqual(before)
    expect(store.listAudit(0)).toEqual(audits)
    expect(runtime.values.readSecret("KEY")).toBe("synthetic-secret")
  })
  it("returns committed failed application state without echoing values or requiring resubmission", async () => {
    apply.mockRejectedValueOnce(new Error("synthetic-secret-upstream-echo"))
    const response = await call("/api/runtime-config/KEY", "PUT", mutation())
    expect(response.status).toBe(200)
    expect(response.body).not.toContain("synthetic-secret")
    expect(JSON.parse(response.body)).toMatchObject({ revision: 2, applied: 1, status: "failed" })
    expect(runtime.values.readSecret("KEY")).toBe("synthetic-secret")
    expect(runtime.readSecret("KEY")).toBeUndefined()
    const retry = await call("/api/apply", "POST", {})
    expect(retry.status).toBe(200)
    expect(runtime.readSecret("KEY")).toBe("synthetic-secret")
    expect(store.snapshot().revision).toBe(2)
  })
  it("rejects writes during probes and deletion of references in disabled MCP entries", async () => {
    vi.spyOn(mcp.probes, "size", "get").mockReturnValue(1)
    expect((await call("/api/runtime-config/KEY", "PUT", mutation())).status).toBe(409)
    vi.restoreAllMocks()
    expect((await call("/api/runtime-config/KEY", "PUT", mutation())).status).toBe(200)
    store.db
      .prepare("INSERT INTO mcp VALUES (?,?)")
      .run(
        "disabled-server",
        JSON.stringify({ command: "fixture", enabled: false, env: { TOKEN: `\${KEY}` } }),
      )
    const response = await call("/api/runtime-config/KEY", "DELETE", {
      revision: store.snapshot().revision,
    })
    expect(response.status).toBe(409)
    expect(response.body).toContain("disabled-server")
    expect(response.body).not.toContain(`\${KEY}`)
    expect(runtime.values.readSecret("KEY")).toBe("synthetic-secret")
  })
  it("does not report an applied commit as failed if the worker later throws", async () => {
    apply.mockImplementationOnce(async () => {
      store.applied(store.snapshot().revision, true)
      throw new Error("private worker error")
    })
    const response = await call("/api/runtime-config/KEY", "PUT", mutation())
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({ status: "applied", revision: 2, applied: 2 })
    expect(response.body).not.toContain("private worker error")
    expect(runtime.readSecret("KEY")).toBe("synthetic-secret")
  })
  it("returns safe locked status after wrong-key restart while variables remain writable", async () => {
    expect((await call("/api/runtime-config/KEY", "PUT", mutation())).status).toBe(200)
    runtime = new RuntimeConfigAdmin(store, randomBytes(32).toString("base64"))
    services.runtime = runtime
    expect(JSON.parse((await call()).body).secretStatus).toBe("locked")
    const before = store.snapshot()
    const rejected = await call("/api/runtime-config/KEY", "PUT", mutation())
    expect(rejected.status).toBe(503)
    expect(rejected.body).toBe(
      '{"error":"Secret storage is locked; restore the matching host key and database"}',
    )
    expect(store.snapshot()).toEqual(before)
    expect(
      (await call("/api/runtime-config/LITERAL", "PUT", mutation("variable", "available"))).status,
    ).toBe(200)
    expect(runtime.readVariable("LITERAL")).toBe("available")
    expect(runtime.readSecret("KEY")).toBeUndefined()
  })
  it("keeps variables available with no key and gives safe fixed secret errors", async () => {
    runtime = new RuntimeConfigAdmin(store)
    services.runtime = runtime
    expect((await call()).body).toContain('"secretStatus":"unavailable"')
    const rejected = await call("/api/runtime-config/KEY", "PUT", mutation())
    expect(rejected.status).toBe(503)
    expect(rejected.body).not.toContain("synthetic-secret")
    expect(
      (await call("/api/runtime-config/LITERAL", "PUT", mutation("variable", "available"))).status,
    ).toBe(200)
    expect(runtime.readVariable("LITERAL")).toBe("available")
  })
})
