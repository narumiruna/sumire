import { randomUUID } from "node:crypto"
import { request as httpRequest } from "node:http"
import type { AddressInfo } from "node:net"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { McpAdmin } from "../src/admin/mcp.js"
import { ProviderAdmin } from "../src/admin/providers.js"
import { createAdminServer } from "../src/admin/server.js"
import { approvedStore, closeTestStores } from "./helpers/admin-store.js"

let store: ReturnType<typeof approvedStore>
let server: ReturnType<typeof createAdminServer>
let session: { value: string; csrf: string }
const auth = () => ({
  cookie: `__Host-sumire-session=${session.value}`,
  origin: "https://admin.example.test",
  "x-csrf-token": session.csrf,
  "content-type": "application/json",
})
const input = () => ({
  requestId: randomUUID(),
  chatId: 42,
  task: "fixture-scheduled-user-message",
  runAt: Date.now() + 3600_000,
  timeZone: "Asia/Taipei",
  repeatMinutes: null,
})
function call(
  path = "/api/schedules",
  method = "GET",
  data?: unknown,
  headers: Record<string, string> = auth(),
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const text = data === undefined ? "" : JSON.stringify(data)
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port: (server.server.address() as AddressInfo).port,
        path,
        method,
        headers: {
          host: "admin.example.test",
          "content-length": Buffer.byteLength(text),
          ...headers,
        },
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
    req.end(text)
  })
}
beforeEach(async () => {
  store = approvedStore([42])
  store.observe(42, "private", "Fixture chat")
  session = store.createSession("7")
  server = createAdminServer(
    { origin: "https://admin.example.test", host: "127.0.0.1", port: 0, assets: store.file },
    {
      store,
      mcp: new McpAdmin(store, "/tmp"),
      providers: new ProviderAdmin({} as ModelRuntime, store),
      apply: vi.fn(async () => {}),
      tools: () => [],
    },
  )
  await server.start()
})
afterEach(async () => {
  await server.stop()
  closeTestStores()
})

describe("admin schedule API", () => {
  it("supports bounded list, create, pause, resume and deletion without changing policy", async () => {
    const policy = store.snapshot()
    expect(JSON.parse((await call()).body)).toEqual({ items: [], limit: 100 })
    const draft = input()
    const created = await call("/api/schedules", "POST", draft)
    expect(created.status).toBe(201)
    const item = JSON.parse(created.body)
    expect(item).toMatchObject({
      id: draft.requestId,
      task: draft.task,
      state: "active",
      revision: 1,
    })
    expect(item.actor).toBeUndefined()
    expect(item.runId).toBeUndefined()
    expect((await call("/api/schedules", "POST", draft)).status).toBe(201)
    expect(JSON.parse((await call()).body).items).toHaveLength(1)
    const path = `/api/schedules/${item.id}`
    const paused = await call(path, "PUT", { revision: 1, action: "pause" })
    expect(paused.status).toBe(200)
    expect(JSON.parse(paused.body)).toMatchObject({ state: "paused", revision: 2 })
    expect((await call(path, "PUT", { revision: 1, action: "resume" })).status).toBe(409)
    expect((await call(path, "PUT", { revision: 2, action: "resume" })).status).toBe(200)
    expect((await call(path, "DELETE", { revision: 2 })).status).toBe(409)
    expect((await call(path, "DELETE", { revision: 3 })).status).toBe(200)
    expect(JSON.parse((await call()).body).items).toEqual([])
    expect(JSON.stringify(store.listAudit(0))).not.toContain(draft.task)
    expect(store.snapshot()).toEqual(policy)
  })
  it("requires a current admin session for reads and writes", async () => {
    expect((await call("/api/schedules", "GET", undefined, {})).status).toBe(401)
    expect((await call("/api/schedules", "POST", input(), {})).status).toBe(401)
    store.revoke(session.value)
    expect((await call()).status).toBe(401)
  })
  it("enforces origin, CSRF, JSON and strict bounded mutation schemas", async () => {
    expect(
      (await call("/api/schedules", "POST", input(), { ...auth(), origin: "https://evil.example" }))
        .status,
    ).toBe(403)
    expect(
      (await call("/api/schedules", "POST", input(), { ...auth(), "x-csrf-token": "wrong" }))
        .status,
    ).toBe(403)
    expect(
      (await call("/api/schedules", "POST", input(), { ...auth(), "content-type": "text/plain" }))
        .status,
    ).toBe(415)
    for (const value of [
      { ...input(), extra: true },
      { ...input(), runAt: Date.now() - 1 },
      { ...input(), chatId: 999 },
      { ...input(), timeZone: "Invalid/Zone" },
      { ...input(), repeatMinutes: 1 },
      { ...input(), requestId: "not-a-uuid" },
      { ...input(), task: "x".repeat(8001) },
    ])
      expect((await call("/api/schedules", "POST", value)).status).toBeGreaterThanOrEqual(400)
    expect(
      (await call("/api/schedules", "POST", { ...input(), task: "x".repeat(70_000) })).status,
    ).toBe(413)
    expect(JSON.parse((await call()).body).items).toEqual([])
  })
  it("rejects unsupported paths/methods and malformed revisions", async () => {
    expect((await call("/api/schedules?limit=10000")).status).toBe(400)
    expect((await call("/api/schedules/not-a-uuid")).status).toBe(404)
    expect((await call("/api/schedules", "PUT", {})).status).toBe(405)
    expect(
      (await call(`/api/schedules/${randomUUID()}`, "PUT", { revision: 1, action: "resume" }))
        .status,
    ).toBe(404)
    const item = JSON.parse((await call("/api/schedules", "POST", input())).body)
    const path = `/api/schedules/${item.id}`
    expect((await call(path, "GET")).status).toBe(405)
    expect((await call(path, "PUT", { revision: "1", action: "pause" })).status).toBe(400)
    expect((await call(path, "PUT", { revision: 1, action: "execute" })).status).toBe(400)
    expect((await call(path, "DELETE", { revision: 1, force: true })).status).toBe(400)
  })
})
