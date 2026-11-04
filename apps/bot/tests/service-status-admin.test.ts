import { mkdtempSync, rmSync } from "node:fs"
import { request as httpRequest } from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import type { ServiceStatusDeliveryResponse } from "@narumitw/sumire-contracts"
import { initialStatusNotifications, type StatusNotifications } from "@narumitw/sumire-policy"
import type {
  readStatusIncident,
  readStatusSummary,
  StatusProviderId,
  StatusSummary,
} from "@narumitw/sumire-status-page"
import type { Api } from "grammy"
import { afterEach, describe, expect, it, vi } from "vitest"
import { McpAdmin } from "../src/admin/mcp.js"
import { ProviderAdmin } from "../src/admin/providers.js"
import { createAdminServer } from "../src/admin/server.js"
import type { ServiceStatusAdmin } from "../src/admin/service-status.js"
import { AdminError, AdminStore, digest, sessionMaxAgeMs } from "../src/admin/store.js"
import {
  createStatusNotificationWorker,
  StatusNotificationWorker,
  type StatusWorkerClock,
  type StatusWorkerOptions,
} from "../src/service-status/runtime.js"
import { StatusDeliveryState } from "../src/service-status/state.js"

const cleanup: Array<() => Promise<void>> = []
const origin = "https://admin.example.test"
const route = "/api/service-status"
const epoch = Date.parse("2030-01-01T12:00:00Z")
const testText =
  "Sumire service status test notification. This is a manual delivery test, not a service incident."

afterEach(async () => {
  try {
    for (const close of cleanup.splice(0).reverse()) await close()
  } finally {
    vi.useRealTimers()
    vi.restoreAllMocks()
  }
})

function deferred<T>() {
  let resolve = (_value: T) => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function clock() {
  let now = epoch
  let monotonic = 0
  const value: StatusWorkerClock = {
    now: () => now,
    monotonic: () => monotonic,
    wait: async (milliseconds, signal) => {
      signal.throwIfAborted()
      now += milliseconds
      monotonic += milliseconds
    },
  }
  return {
    value,
    advance(milliseconds: number) {
      now += milliseconds
      monotonic += milliseconds
    },
  }
}

function summary(
  provider: StatusProviderId,
  overrides: Partial<StatusSummary> = {},
): StatusSummary {
  return {
    provider,
    indicator: "none",
    description: "All systems operational",
    components: [
      { id: "platform", name: "Platform", status: "operational", isGroup: true },
      { id: "api", name: "API", status: "operational", groupId: "platform" },
    ],
    incidents: [],
    maintenances: [],
    ...overrides,
  }
}

function fixture(settings: Partial<StatusNotifications> = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sumire-status-admin-"))
  const file = path.join(directory, "admin.sqlite")
  let store = new AdminStore(file, 42)
  let storeClosed = false
  const time = clock()
  const send = vi.fn<StatusWorkerOptions["send"]>().mockResolvedValue(undefined)
  const readSummary = vi.fn<typeof readStatusSummary>(async (provider) => summary(provider))
  const readIncident = vi
    .fn<typeof readStatusIncident>()
    .mockRejectedValue(new Error("Unexpected incident lookup"))
  const logger = { warn: vi.fn() }
  const workers: StatusNotificationWorker[] = []
  const create = () => {
    const worker = new StatusNotificationWorker({
      store,
      send,
      readSummary,
      readIncident,
      logger,
      clock: time.value,
    })
    workers.push(worker)
    return worker
  }
  const configure = (next: Partial<StatusNotifications>, applied = true) => {
    const before = store.snapshot()
    before.policy.statusNotifications = { ...before.policy.statusNotifications, ...next }
    const saved = store.save(before.policy, before.revision, "42")
    if (applied) store.applied(saved.revision, true)
    return saved.revision
  }
  configure({
    ...initialStatusNotifications(),
    providers: ["github"],
    chatIds: [101, -202],
    ...settings,
  })
  let worker = create()
  const closeStore = () => {
    if (storeClosed) return
    storeClosed = true
    store.close()
  }
  cleanup.push(async () => {
    await Promise.all(workers.map((item) => item.close()))
    closeStore()
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    directory,
    time,
    send,
    readSummary,
    readIncident,
    logger,
    configure,
    closeStore,
    get store() {
      return store
    },
    get worker() {
      return worker
    },
    input: (chatId = 101) => ({
      chatId,
      revision: store.snapshot().revision,
      confirm: true as const,
    }),
    context: (signal = new AbortController().signal) => ({ actor: "42", signal, authorize() {} }),
    state: () => new StatusDeliveryState(store.db),
    async reopen() {
      await Promise.all(workers.map((item) => item.close()))
      closeStore()
      store = new AdminStore(file, 42)
      storeClosed = false
      worker = create()
    },
  }
}

function mockService() {
  return {
    components: vi.fn<ServiceStatusAdmin["components"]>().mockResolvedValue({
      provider: "github",
      components: summary("github").components,
      fetchedAt: epoch,
      stale: false,
      error: null,
    }),
    deliveries: vi.fn<ServiceStatusAdmin["deliveries"]>().mockReturnValue({
      items: [],
      sources: [],
      total: 0,
      offset: 0,
      limit: 100,
      serverTime: epoch,
      nextPollAt: null,
    }),
    test: vi.fn<ServiceStatusAdmin["test"]>().mockResolvedValue({
      chatId: 101,
      success: true,
      code: null,
      attemptedAt: epoch,
    }),
    wake: vi.fn(),
  }
}

async function httpFixture(
  service?: ServiceStatusAdmin,
  settings: Partial<StatusNotifications> = {},
) {
  const f = fixture(settings)
  const runtime = {
    getProviders: () => [],
    getRegisteredProviderIds: () => [],
    getModels: () => [],
    getProvider: () => undefined,
    getModel: () => undefined,
  } as unknown as ModelRuntime
  const providers = new ProviderAdmin(runtime, f.store)
  const apply = vi.fn(async () => {
    f.store.applied(f.store.snapshot().revision, true)
  })
  const services = {
    store: f.store,
    providers,
    mcp: new McpAdmin(f.store, f.directory),
    serviceStatus: service ?? f.worker,
    apply,
    tools: () => [],
  }
  const server = createAdminServer(
    { origin, host: "127.0.0.1", port: 0, assets: f.directory },
    services,
  )
  await server.start()
  cleanup.push(() => server.stop())
  const session = f.store.createSession("42")
  const auth = () => ({
    cookie: `__Host-sumire-session=${session.value}`,
    origin,
    "x-csrf-token": session.csrf,
    "content-type": "application/json",
  })
  const request = (
    url: string,
    method = "GET",
    data?: unknown,
    headers: Record<string, string> = auth(),
  ) => {
    const payload =
      data === undefined ? undefined : typeof data === "string" ? data : JSON.stringify(data)
    let destroy = () => {}
    const promise = new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          port: (server.server.address() as AddressInfo).port,
          path: url,
          method,
          headers: {
            host: "admin.example.test",
            ...(payload === undefined
              ? {}
              : { "content-length": String(Buffer.byteLength(payload)) }),
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
      destroy = () => req.destroy()
      req.on("error", reject)
      req.end(payload)
    })
    return { promise, destroy: () => destroy() }
  }
  return {
    ...f,
    server,
    services,
    apply,
    session,
    auth,
    request,
    call: (url: string, method = "GET", data?: unknown, headers: Record<string, string> = auth()) =>
      request(url, method, data, headers).promise,
  }
}

function incidentState(f: ReturnType<typeof fixture>) {
  const state = f.state()
  state.acknowledge(101, "github", "incident:sent", "sent-fingerprint", true, false, epoch)
  expect(
    state.admit({
      chatId: 101,
      provider: "github",
      eventId: "incident:pending",
      fingerprint: "pending-fingerprint",
      event: {
        id: "incident:pending",
        kind: "incident",
        active: true,
        maintenance: false,
        name: "Pending incident",
        status: "investigating",
        impact: "major",
        url: "https://www.githubstatus.com/incidents/pending",
        body: "Synthetic incident data, not manual test text",
        components: [{ id: "api", name: "API", status: "partial_outage" }],
      },
      change: "new",
      dueAt: epoch + 3600_000,
      firstSeenAt: epoch,
      changes: 1,
      ruleFingerprint: "fixture-rule",
      initial: true,
    }),
  ).toBe(true)
  return () => ({
    checkpoints: f.store.db
      .prepare("SELECT * FROM status_deliveries ORDER BY chat_id,event_id")
      .all(),
    pending: f.store.db.prepare("SELECT * FROM status_pending ORDER BY chat_id,event_id").all(),
    meta: f.store.db.prepare("SELECT * FROM status_meta").all(),
  })
}

function testAudit(store: AdminStore) {
  return store
    .listAudit(0, { operation: "status.test" })
    .reverse()
    .map(({ actor, operation, revision, outcome, target }) => ({
      actor,
      operation,
      revision,
      outcome,
      target,
    }))
}

function results(f: ReturnType<typeof fixture>, provider?: "test" | StatusProviderId) {
  return f.worker.deliveries({ offset: 0, limit: 100, ...(provider ? { provider } : {}) })
}

describe("service status admin HTTP validation", () => {
  it("requires a current administrator session before it calls any status service", async () => {
    const service = mockService()
    const f = await httpFixture(service)
    const before = f.store.snapshot()
    for (const [url, method, body] of [
      [`${route}/components?provider=github`, "GET", undefined],
      [`${route}/deliveries`, "GET", undefined],
      [`${route}/test`, "POST", f.input()],
    ] as const) {
      expect((await f.call(url, method, body, {})).status).toBe(401)
    }
    const wrongActor = f.store.createSession("7")
    expect(
      (
        await f.call(`${route}/deliveries`, "GET", undefined, {
          cookie: `__Host-sumire-session=${wrongActor.value}`,
        })
      ).status,
    ).toBe(401)
    f.store.revoke(f.session.value)
    expect((await f.call(`${route}/test`, "POST", f.input())).status).toBe(401)
    expect(service.components).not.toHaveBeenCalled()
    expect(service.deliveries).not.toHaveBeenCalled()
    expect(service.test).not.toHaveBeenCalled()
    expect(f.store.snapshot()).toEqual(before)
  })

  it.each([
    { origin: "" },
    { origin: "https://other.example.test" },
    { "x-csrf-token": "" },
    { "x-csrf-token": "incorrect" },
  ])("rejects a manual test with invalid Origin or CSRF headers: %j", async (headers) => {
    const service = mockService()
    const f = await httpFixture(service)
    expect(
      (await f.call(`${route}/test`, "POST", f.input(), { ...f.auth(), ...headers })).status,
    ).toBe(403)
    expect(service.test).not.toHaveBeenCalled()
    expect(f.send).not.toHaveBeenCalled()
  })

  it.each([
    ["/components?provider=github", "POST", 405],
    ["/components?provider=github", "PUT", 405],
    ["/deliveries", "POST", 405],
    ["/deliveries", "DELETE", 405],
    ["/test", "GET", 405],
    ["/test", "DELETE", 405],
    ["/components?provider=github", "PATCH", 405],
    ["/unknown", "GET", 404],
  ])("rejects %s with method %s", async (suffix, method, status) => {
    const service = mockService()
    const f = await httpFixture(service)
    expect((await f.call(`${route}${suffix}`, method)).status).toBe(status)
    expect(service.components).not.toHaveBeenCalled()
    expect(service.deliveries).not.toHaveBeenCalled()
    expect(service.test).not.toHaveBeenCalled()
  })

  it("accepts only the four fixed provider IDs for component reads", async () => {
    const service = mockService()
    const f = await httpFixture(service)
    for (const provider of ["github", "openai", "claude", "cloudflare"]) {
      expect((await f.call(`${route}/components?provider=${provider}`)).status).toBe(200)
      expect(service.components).toHaveBeenLastCalledWith(provider, expect.any(AbortSignal))
    }
    expect(service.test).not.toHaveBeenCalled()
    expect(f.send).not.toHaveBeenCalled()
  })

  it.each([
    "",
    "provider=",
    "provider=test",
    "provider=GitHub",
    "provider=https%3A%2F%2Fwww.githubstatus.com",
    "provider=http%3A%2F%2F127.0.0.1",
    "provider=github%0A",
    "provider=github&url=https%3A%2F%2Fother.example.test",
    "provider=github&extra=1",
    "provider=github&provider=github",
    "provider=github&provider=openai",
    "provider=github&__proto__=ignored",
  ])("rejects unsupported, extra, or duplicate component filters: %s", async (query) => {
    const service = mockService()
    const f = await httpFixture(service)
    expect((await f.call(`${route}/components?${query}`)).status).toBe(400)
    expect(service.components).not.toHaveBeenCalled()
  })

  it("passes bounded pagination, canonical signed chat IDs, and the separate test provider", async () => {
    const service = mockService()
    const f = await httpFixture(service)
    expect((await f.call(`${route}/deliveries`)).status).toBe(200)
    expect(service.deliveries).toHaveBeenLastCalledWith({ offset: 0, limit: 100 })
    for (const id of ["101", "-202", "9007199254740991", "-9007199254740991"]) {
      expect(
        (await f.call(`${route}/deliveries?offset=10000&limit=100&chatId=${id}&provider=test`))
          .status,
      ).toBe(200)
      expect(service.deliveries).toHaveBeenLastCalledWith({
        offset: 10000,
        limit: 100,
        chatId: Number(id),
        provider: "test",
      })
    }
    expect((await f.call(`${route}/deliveries?offset=1&limit=1&provider=github`)).status).toBe(200)
    expect(service.deliveries).toHaveBeenLastCalledWith({ offset: 1, limit: 1, provider: "github" })
    expect(service.test).not.toHaveBeenCalled()
    expect(f.send).not.toHaveBeenCalled()
  })

  it.each([
    "limit=101",
    "limit=0",
    "limit=1.5",
    "limit=NaN",
    "offset=-1",
    "offset=10001",
    "offset=0.5",
    "chatId=0",
    "chatId=-0",
    "chatId=0101",
    "chatId=-0202",
    "chatId=101%0A",
    "chatId=101%0D%0A",
    "chatId=%20101",
    "chatId=%2B101",
    "chatId=1e2",
    "chatId=1.0",
    "chatId=9007199254740992",
    "provider=unknown",
    "provider=https%3A%2F%2Fstatus.openai.com",
    "extra=1",
    "limit=1&limit=1",
    "chatId=101&chatId=101",
    "provider=test&provider=github",
  ])("rejects invalid recent-result filters before a read: %s", async (query) => {
    const service = mockService()
    const f = await httpFixture(service)
    expect((await f.call(`${route}/deliveries?${query}`)).status).toBe(400)
    expect(service.deliveries).not.toHaveBeenCalled()
  })

  it.each([
    {},
    { chatId: 101, revision: 2 },
    { chatId: 101, revision: 2, confirm: false },
    { chatId: 101, revision: 2, confirm: "true" },
    { chatId: "101", revision: 2, confirm: true },
    { chatId: 0, revision: 2, confirm: true },
    { chatId: 1.5, revision: 2, confirm: true },
    { chatId: 9007199254740992, revision: 2, confirm: true },
    { chatId: 101, revision: "2", confirm: true },
    { chatId: 101, revision: 0, confirm: true },
    { chatId: 101, revision: 1.5, confirm: true },
    { chatId: 101, revision: 9007199254740992, confirm: true },
    { chatId: 101, revision: 2, confirm: true, message: "Draft message" },
    { chatId: 101, revision: 2, confirm: true, policy: {} },
  ])("requires a strict, explicitly confirmed manual-test body: %j", async (body) => {
    const service = mockService()
    const f = await httpFixture(service)
    expect((await f.call(`${route}/test`, "POST", body)).status).toBe(400)
    expect(service.test).not.toHaveBeenCalled()
  })

  it("rejects test query strings, malformed JSON, wrong media types, and oversized bodies", async () => {
    const service = mockService()
    const f = await httpFixture(service)
    for (const query of ["provider=test", "confirm=true", "extra=1&extra=1"]) {
      expect((await f.call(`${route}/test?${query}`, "POST", f.input())).status).toBe(400)
    }
    expect(
      (await f.call(`${route}/test`, "POST", '{"secret":"synthetic-private-value"')).status,
    ).toBe(400)
    expect(
      (
        await f.call(`${route}/test`, "POST", f.input(), {
          ...f.auth(),
          "content-type": "text/plain",
        })
      ).status,
    ).toBe(415)
    expect(
      (await f.call(`${route}/test`, "POST", JSON.stringify({ padding: "x".repeat(4096) }))).status,
    ).toBe(413)
    expect(service.test).not.toHaveBeenCalled()
  })

  it.each(["revoked", "expired"] as const)(
    "rejects a completed manual-test response after the administrator session is %s",
    async (condition) => {
      const service = mockService()
      const f = await httpFixture(service)
      const entered = deferred<void>()
      const held = deferred<void>()
      service.test.mockImplementationOnce(async () => {
        entered.resolve()
        await held.promise
        return { chatId: 101, success: true, code: null, attemptedAt: epoch }
      })
      const pending = f.call(`${route}/test`, "POST", f.input())
      try {
        await entered.promise
        if (condition === "revoked") f.store.revoke(f.session.value)
        else {
          f.store.db
            .prepare("UPDATE sessions SET created=? WHERE hash=?")
            .run(Date.now() - sessionMaxAgeMs - 1, digest(f.session.value))
        }
        held.resolve()
        const response = await pending
        expect(response.status).toBe(401)
        expect(response.body).not.toContain('"success":true')
        expect(f.send).not.toHaveBeenCalled()
      } finally {
        held.resolve()
        await pending
      }
    },
  )

  it("passes the current actor, cancellation signal, and session guard without saving settings", async () => {
    const service = mockService()
    const f = await httpFixture(service)
    const before = f.store.snapshot()
    const response = await f.call(`${route}/test`, "POST", f.input())
    expect(response.status).toBe(200)
    expect(service.test).toHaveBeenCalledExactlyOnceWith(f.input(), {
      actor: "42",
      signal: expect.any(AbortSignal),
      authorize: expect.any(Function),
    })
    const context = service.test.mock.calls[0]?.[1]
    expect(context?.signal.aborted).toBe(false)
    expect(() => context?.authorize()).not.toThrow()
    f.store.revoke(f.session.value)
    expect(() => context?.authorize()).toThrow(AdminError)
    expect(f.store.snapshot()).toEqual(before)
    expect(f.apply).not.toHaveBeenCalled()
    expect(service.wake).not.toHaveBeenCalled()
  })
})

describe("real service status manual tests and recent results", () => {
  it("sends only to an applied saved destination while automatic delivery and Pi access remain disabled", async () => {
    const f = await httpFixture(undefined, {
      enabled: false,
      quietHours: { timeZone: "UTC", start: "11:00", end: "13:00" },
      batchWindowSeconds: 900,
    })
    const snapshot = f.store.snapshot()
    const readIncidentState = incidentState(f)
    const before = readIncidentState()
    expect(f.store.allows(101)).toBe(false)
    f.store.observe(999, "private", "Draft-only destination")
    expect((await f.call(`${route}/test`, "POST", f.input(999))).status).toBe(400)
    expect(f.send).not.toHaveBeenCalled()
    const response = await f.call(`${route}/test`, "POST", f.input())
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({
      chatId: 101,
      success: true,
      code: null,
      attemptedAt: epoch,
    })
    expect(f.send).toHaveBeenCalledExactlyOnceWith(101, testText, expect.any(AbortSignal))
    expect(readIncidentState()).toEqual(before)
    expect(f.store.snapshot()).toEqual(snapshot)
    expect(f.store.allows(101)).toBe(false)
    expect(snapshot.policy.privateUsers).toEqual([])
    expect(snapshot.policy.groups).toEqual([])
    expect(f.apply).not.toHaveBeenCalled()
    expect(f.readSummary).not.toHaveBeenCalled()
    expect(f.readIncident).not.toHaveBeenCalled()
    expect(testAudit(f.store)).toEqual(
      ["started", "accepted"].map((outcome) => ({
        actor: "42",
        operation: "status.test",
        revision: snapshot.revision,
        outcome,
        target: "chat:101",
      })),
    )
    const recent = await f.call(`${route}/deliveries?chatId=101&provider=test`)
    expect(recent.status).toBe(200)
    expect(JSON.parse(recent.body).items).toEqual([
      {
        chatId: 101,
        provider: "test",
        lastAttemptAt: epoch,
        lastSuccessAt: epoch,
        lastFailureAt: null,
        lastError: null,
        pendingCount: 0,
        nextDueAt: null,
      },
    ])
    expect(f.send).toHaveBeenCalledOnce()
    expect(readIncidentState()).toEqual(before)
  })

  it("rejects stale, pending, and failed settings without applying or sending them", async () => {
    const f = await httpFixture()
    const old = f.input()
    f.configure({ batchWindowSeconds: 60 }, false)
    expect((await f.call(`${route}/test`, "POST", f.input())).status).toBe(409)
    f.store.applied(f.store.snapshot().revision, false)
    expect((await f.call(`${route}/test`, "POST", f.input())).status).toBe(409)
    f.store.applied(f.store.snapshot().revision, true)
    expect((await f.call(`${route}/test`, "POST", old)).status).toBe(409)
    f.configure({ chatIds: [-202] })
    expect((await f.call(`${route}/test`, "POST", f.input(101))).status).toBe(400)
    expect(f.send).not.toHaveBeenCalled()
    expect(f.apply).not.toHaveBeenCalled()
    expect(testAudit(f.store)).toEqual([])
    expect(results(f, "test").items).toEqual([])
  })

  it("uses the original fixed plain Telegram message without consuming incident or pending state", async () => {
    const f = fixture()
    const sendMessage = vi.fn<Api["sendMessage"]>().mockResolvedValue({
      message_id: 1,
      date: 0,
      chat: { id: 101, type: "private", first_name: "Fixture" },
      text: testText,
    })
    const transport = createStatusNotificationWorker(f.store, { sendMessage }, f.logger)
    cleanup.push(() => transport.close())
    const readIncidentState = incidentState(f)
    const before = readIncidentState()
    const policy = f.store.snapshot()
    expect(await transport.test(f.input(), f.context())).toMatchObject({
      success: true,
      code: null,
    })
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(
      101,
      testText,
      { link_preview_options: { is_disabled: true } },
      expect.any(AbortSignal),
    )
    expect(readIncidentState()).toEqual(before)
    expect(f.store.snapshot()).toEqual(policy)
    expect(f.store.allows(101)).toBe(false)
  })

  it("persists the one-minute destination cooldown across a database reopen", async () => {
    const f = fixture()
    expect(await f.worker.test(f.input(), f.context())).toMatchObject({ success: true })
    f.time.advance(59_999)
    await expect(f.worker.test(f.input(), f.context())).rejects.toMatchObject({ status: 429 })
    await f.reopen()
    await expect(f.worker.test(f.input(), f.context())).rejects.toMatchObject({ status: 429 })
    expect(f.send).toHaveBeenCalledOnce()
    expect(results(f, "test").items[0]?.lastSuccessAt).toBe(epoch)
    f.time.advance(1)
    expect(await f.worker.test(f.input(), f.context())).toMatchObject({
      success: true,
      attemptedAt: epoch + 60_000,
    })
    expect(f.send).toHaveBeenCalledTimes(2)
    expect(testAudit(f.store).map((entry) => entry.outcome)).toEqual([
      "started",
      "accepted",
      "started",
      "accepted",
    ])
  })

  it("blocks overlapping tests for the same chat even after the clock passes the cooldown", async () => {
    const f = fixture()
    const entered = deferred<void>()
    const held = deferred<void>()
    f.send.mockImplementationOnce(() => {
      entered.resolve()
      return held.promise
    })
    const pending = f.worker.test(f.input(), f.context())
    try {
      await entered.promise
      f.time.advance(60_000)
      await expect(f.worker.test(f.input(), f.context())).rejects.toMatchObject({ status: 429 })
      expect(f.send).toHaveBeenCalledOnce()
      expect(testAudit(f.store).map((entry) => entry.outcome)).toEqual(["started"])
    } finally {
      held.resolve()
      await pending
    }
    expect(await pending).toMatchObject({ success: true })
  })

  it.each([
    {
      error: { error_code: 403, description: "synthetic-private-transport-token" },
      code: "forbidden",
    },
    {
      error: {
        error_code: 429,
        parameters: { retry_after: 30 },
        description: "synthetic-private-transport-token",
      },
      code: "rate_limited",
    },
    {
      error: { error_code: 400, description: "synthetic-private-transport-token" },
      code: "chat_unavailable",
    },
    {
      error: new DOMException("synthetic-private-transport-token", "TimeoutError"),
      code: "timeout",
    },
    {
      error: new Error("403 429 timeout synthetic-private-transport-token"),
      code: "delivery_failed",
    },
  ])(
    "returns only the structured $code diagnostic and preserves independent result timestamps",
    async ({ error, code }) => {
      const f = await httpFixture()
      expect((await f.call(`${route}/test`, "POST", f.input())).status).toBe(200)
      f.time.advance(60_000)
      f.send.mockRejectedValueOnce(error)
      const failure = await f.call(`${route}/test`, "POST", f.input())
      expect(failure.status).toBe(200)
      expect(JSON.parse(failure.body)).toEqual({
        chatId: 101,
        success: false,
        code,
        attemptedAt: epoch + 60_000,
      })
      const failed = await f.call(`${route}/deliveries?provider=test&chatId=101&limit=1&offset=0`)
      expect(failed.status).toBe(200)
      expect(JSON.parse(failed.body).items).toEqual([
        {
          chatId: 101,
          provider: "test",
          lastAttemptAt: epoch + 60_000,
          lastSuccessAt: epoch,
          lastFailureAt: epoch + 60_000,
          lastError: code,
          pendingCount: 0,
          nextDueAt: null,
        },
      ])
      f.time.advance(60_000)
      const success = await f.call(`${route}/test`, "POST", f.input())
      expect(JSON.parse(success.body)).toMatchObject({ success: true, code: null })
      const restored = results(f, "test")
      expect(restored.items[0]).toMatchObject({
        lastAttemptAt: epoch + 120_000,
        lastSuccessAt: epoch + 120_000,
        lastFailureAt: epoch + 60_000,
        lastError: code,
      })
      expect(testAudit(f.store).map((entry) => entry.outcome)).toEqual([
        "started",
        "accepted",
        "started",
        "failed",
        "started",
        "accepted",
      ])
      const publicValues = JSON.stringify({
        failure,
        failed,
        restored,
        audit: f.store.listAudit(0),
      })
      for (const secret of [
        "synthetic-private-transport-token",
        f.session.value,
        f.session.csrf,
        "retry_after",
        "description",
      ]) {
        expect(publicValues).not.toContain(secret)
      }
      expect(f.send).toHaveBeenCalledTimes(3)
    },
  )

  it("keeps independent source and manual-delivery success and failure results across reopen", async () => {
    const f = fixture()
    await f.worker.test(f.input(), f.context())
    await f.worker.components("github", new AbortController().signal)
    f.time.advance(60_000)
    f.send.mockRejectedValueOnce({ error_code: 403, description: "synthetic-private-token" })
    f.readSummary.mockRejectedValueOnce(new Error("synthetic-private-provider-body"))
    expect(await f.worker.test(f.input(), f.context())).toMatchObject({
      success: false,
      code: "forbidden",
    })
    await f.worker.components("github", new AbortController().signal)
    const before = results(f)
    expect(before.items[0]).toMatchObject({
      provider: "test",
      lastSuccessAt: epoch,
      lastFailureAt: epoch + 60_000,
      lastError: "forbidden",
    })
    expect(before.sources[0]).toMatchObject({
      provider: "github",
      lastSuccessAt: epoch,
      lastFailureAt: epoch + 60_000,
      lastError: "source_unavailable",
    })
    await f.reopen()
    expect(results(f)).toEqual(before)
    await expect(f.worker.test(f.input(), f.context())).rejects.toMatchObject({ status: 429 })
    expect(f.send).toHaveBeenCalledTimes(2)
    expect(f.readSummary).toHaveBeenCalledTimes(2)
    expect(testAudit(f.store)).toEqual(
      ["started", "accepted", "started", "failed"].map((outcome) => ({
        actor: "42",
        operation: "status.test",
        revision: f.store.snapshot().revision,
        outcome,
        target: "chat:101",
      })),
    )
  })

  it("caps an actual results page at 100 rows and reads the next page without sending", async () => {
    const f = await httpFixture()
    const ids = Array.from({ length: 105 }, (_, index) => index + 1)
    f.configure({ chatIds: ids })
    const state = f.state()
    f.store.db.exec("BEGIN")
    try {
      for (const id of ids) state.recordAttempt(id, "test", epoch)
      f.store.db.exec("COMMIT")
    } catch (error) {
      f.store.db.exec("ROLLBACK")
      throw error
    }
    const before = f.store.snapshot()
    const first = await f.call(`${route}/deliveries?provider=test`)
    const firstPage = JSON.parse(first.body) as ServiceStatusDeliveryResponse
    expect(first.status).toBe(200)
    expect(firstPage).toMatchObject({ total: 105, offset: 0, limit: 100 })
    expect(firstPage.items.map((item) => item.chatId)).toEqual(ids.slice(0, 100))
    const next = await f.call(`${route}/deliveries?provider=test&offset=100&limit=100`)
    expect(next.status).toBe(200)
    expect(
      (JSON.parse(next.body) as ServiceStatusDeliveryResponse).items.map((item) => item.chatId),
    ).toEqual(ids.slice(100))
    expect((await f.call(`${route}/deliveries?limit=101`)).status).toBe(400)
    expect(f.store.snapshot()).toEqual(before)
    expect(f.send).not.toHaveBeenCalled()
    expect(f.readSummary).not.toHaveBeenCalled()
    expect(testAudit(f.store)).toEqual([])
  })

  it("paginates real results and reports pending counts without starting delivery", async () => {
    const f = await httpFixture()
    const readIncidentState = incidentState(f)
    const before = readIncidentState()
    await f.worker.test(f.input(), f.context())
    f.time.advance(100)
    await f.worker.test(f.input(-202), f.context())
    const page = await f.call(`${route}/deliveries?offset=1&limit=1`)
    expect(page.status).toBe(200)
    const data = JSON.parse(page.body) as ServiceStatusDeliveryResponse
    expect(data).toMatchObject({ total: 3, offset: 1, limit: 1 })
    expect(data.items).toEqual([
      {
        chatId: 101,
        provider: "github",
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastError: null,
        pendingCount: 1,
        nextDueAt: epoch + 3600_000,
      },
    ])
    const filtered = await f.call(`${route}/deliveries?chatId=-202&provider=test`)
    expect(JSON.parse(filtered.body)).toMatchObject({
      total: 1,
      items: [{ chatId: -202, provider: "test" }],
    })
    expect(f.send).toHaveBeenCalledTimes(2)
    expect(readIncidentState()).toEqual(before)
  })
})

describe("real service status component catalog", () => {
  it("coalesces refreshes and caches component metadata for exactly 60 seconds", async () => {
    const f = fixture()
    const held = deferred<StatusSummary>()
    f.readSummary.mockReturnValueOnce(held.promise)
    const first = f.worker.components("github", new AbortController().signal)
    const second = f.worker.components("github", new AbortController().signal)
    expect(f.readSummary).toHaveBeenCalledOnce()
    held.resolve(summary("github"))
    const [one, two] = await Promise.all([first, second])
    expect(one).toEqual(two)
    expect(one).toEqual({
      provider: "github",
      components: summary("github").components,
      fetchedAt: epoch,
      stale: false,
      error: null,
    })
    f.time.advance(59_999)
    expect(await f.worker.components("github", new AbortController().signal)).toEqual(one)
    expect(f.readSummary).toHaveBeenCalledOnce()
    f.time.advance(1)
    const refreshed = summary("github", {
      components: [{ id: "new-api", name: "New API", status: "operational" }],
    })
    f.readSummary.mockResolvedValueOnce(refreshed)
    expect(await f.worker.components("github", new AbortController().signal)).toEqual({
      provider: "github",
      components: refreshed.components,
      fetchedAt: epoch + 60_000,
      stale: false,
      error: null,
    })
    expect(f.readSummary).toHaveBeenCalledTimes(2)
    expect(results(f).sources).toEqual([
      {
        provider: "github",
        lastAttemptAt: epoch + 60_000,
        lastSuccessAt: epoch + 60_000,
        lastFailureAt: null,
        lastError: null,
      },
    ])
    expect(f.send).not.toHaveBeenCalled()
  })

  it("retains stale metadata after a failed refresh without using it to send an automatic notice", async () => {
    const f = fixture()
    const degraded = summary("github", {
      indicator: "major",
      components: [{ id: "api", name: "Old API", status: "partial_outage" }],
    })
    f.readSummary.mockResolvedValueOnce(degraded)
    await f.worker.components("github", new AbortController().signal)
    f.time.advance(60_000)
    f.readSummary.mockRejectedValue(new Error("synthetic-private-provider-body"))
    const stale = await f.worker.components("github", new AbortController().signal)
    expect(stale).toEqual({
      provider: "github",
      components: degraded.components,
      fetchedAt: epoch,
      stale: true,
      error: "source_unavailable",
    })
    expect(await f.worker.components("github", new AbortController().signal)).toEqual(stale)
    expect(f.readSummary).toHaveBeenCalledTimes(2)
    f.configure({ enabled: true })
    await f.worker.poll()
    expect(f.readSummary).toHaveBeenCalledTimes(3)
    expect(f.send).not.toHaveBeenCalled()
    expect(f.state().pending()).toEqual([])
    expect(f.state().active("github")).toEqual([])
    expect(results(f).sources).toEqual([
      {
        provider: "github",
        lastAttemptAt: epoch + 60_000,
        lastSuccessAt: epoch,
        lastFailureAt: epoch + 60_000,
        lastError: "source_unavailable",
      },
    ])
    expect(JSON.stringify({ stale, results: results(f) })).not.toContain(
      "synthetic-private-provider-body",
    )
  })

  it("returns bounded failure metadata when the first catalog read fails", async () => {
    const f = fixture()
    f.readSummary.mockRejectedValueOnce(new Error("synthetic-private-provider-body"))
    expect(await f.worker.components("openai", new AbortController().signal)).toEqual({
      provider: "openai",
      components: [],
      fetchedAt: null,
      stale: true,
      error: "source_unavailable",
    })
    expect(results(f, "openai").sources).toEqual([
      {
        provider: "openai",
        lastAttemptAt: epoch,
        lastSuccessAt: null,
        lastFailureAt: epoch,
        lastError: "source_unavailable",
      },
    ])
    expect(f.send).not.toHaveBeenCalled()
  })

  it("serves catalog and delivery reads while disabled without sending or changing settings", async () => {
    const f = await httpFixture()
    const readIncidentState = incidentState(f)
    const before = readIncidentState()
    const settings = f.store.snapshot()
    f.readSummary.mockResolvedValueOnce(summary("github", { indicator: "critical" }))
    expect((await f.call(`${route}/components?provider=github`)).status).toBe(200)
    expect((await f.call(`${route}/components?provider=github`)).status).toBe(200)
    expect((await f.call(`${route}/deliveries`)).status).toBe(200)
    expect(f.readSummary).toHaveBeenCalledOnce()
    expect(f.send).not.toHaveBeenCalled()
    expect(f.readIncident).not.toHaveBeenCalled()
    expect(f.store.snapshot()).toEqual(settings)
    expect(readIncidentState()).toEqual(before)
    expect(f.apply).not.toHaveBeenCalled()
  })
})

describe("manual status test cancellation and shutdown", () => {
  it.each(["revoked", "expired", "pending revision", "applied revision", "shutdown"] as const)(
    "cancels a held send and prevents the next transport operation after %s",
    async (condition) => {
      // Only the worker's authorization interval is controlled. No HTTP deadline or Date is faked.
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
      const f = fixture()
      const session = f.store.createSession("42")
      const authorize = () => {
        if (!f.store.sessionDeadline(digest(session.value)))
          throw new AdminError(401, "Administrator session expired")
      }
      const context = { actor: "42", signal: new AbortController().signal, authorize }
      const entered = deferred<void>()
      const held = deferred<void>()
      let signal: AbortSignal | undefined
      f.send.mockImplementationOnce((_chatId, _text, current) => {
        signal = current
        entered.resolve()
        return held.promise
      })
      const first = f.worker.test(f.input(), context).then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      )
      await entered.promise
      const second = f.worker.test(f.input(-202), context).then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      )
      try {
        if (condition === "revoked") f.store.revoke(session.value)
        else if (condition === "expired") {
          f.store.db
            .prepare("UPDATE sessions SET created=? WHERE hash=?")
            .run(Date.now() - sessionMaxAgeMs - 1, digest(session.value))
        } else if (condition === "pending revision") f.configure({ batchWindowSeconds: 60 }, false)
        else if (condition === "applied revision") f.configure({ batchWindowSeconds: 60 })
        else await f.worker.close()
        await vi.advanceTimersByTimeAsync(1000)
        const outcomes = await Promise.all([first, second])
        expect(signal?.aborted).toBe(true)
        expect(
          outcomes.every((outcome) => outcome.value === undefined && outcome.error !== undefined),
        ).toBe(true)
        expect(f.send).toHaveBeenCalledOnce()
        expect(testAudit(f.store).some((entry) => entry.outcome === "accepted")).toBe(false)
        await f.worker.close()
        const input = f.input()
        const prepare = vi.spyOn(f.store.db, "prepare")
        f.closeStore()
        prepare.mockClear()
        held.resolve()
        await Promise.resolve()
        await Promise.resolve()
        expect(prepare).not.toHaveBeenCalled()
        await expect(f.worker.test(input, context)).rejects.toMatchObject({ status: 503 })
      } finally {
        held.resolve()
        await Promise.all([first, second])
      }
    },
  )

  it("cancels a manual operation with a real AbortController and does not permit an immediate retry", async () => {
    const f = fixture()
    const controller = new AbortController()
    const entered = deferred<void>()
    const held = deferred<void>()
    let signal: AbortSignal | undefined
    f.send.mockImplementationOnce((_chatId, _text, current) => {
      signal = current
      entered.resolve()
      return held.promise
    })
    const pending = f.worker.test(f.input(), f.context(controller.signal))
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" })
    try {
      await entered.promise
      controller.abort()
      await rejected
      expect(signal?.aborted).toBe(true)
      expect(results(f, "test").items[0]).toMatchObject({
        lastSuccessAt: null,
        lastFailureAt: epoch,
        lastError: "cancelled",
      })
      await expect(f.worker.test(f.input(), f.context())).rejects.toMatchObject({ status: 429 })
      expect(f.send).toHaveBeenCalledOnce()
      expect(testAudit(f.store).map((entry) => entry.outcome)).toEqual(["started", "failed"])
    } finally {
      held.resolve()
      await pending.catch(() => {})
    }
  })

  it("cancels an actual held HTTP send at session expiry without a five-second wait", async () => {
    const f = await httpFixture()
    const deadline = new AbortController()
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal)
    const entered = deferred<void>()
    const held = deferred<void>()
    let signal: AbortSignal | undefined
    f.send.mockImplementationOnce((_chatId, _text, current) => {
      signal = current
      entered.resolve()
      return held.promise
    })
    const pending = f.call(`${route}/test`, "POST", f.input())
    try {
      await entered.promise
      expect(timeout).toHaveBeenCalledWith(5000)
      f.store.db
        .prepare("UPDATE sessions SET created=? WHERE hash=?")
        .run(Date.now() - sessionMaxAgeMs - 1, digest(f.session.value))
      // Fire the real request signal without changing Date or the injected worker clock.
      deadline.abort(new DOMException("Request deadline expired", "TimeoutError"))
      const response = await pending
      expect(response.status).toBe(401)
      expect(response.body).not.toContain('"success":true')
      expect(signal?.aborted).toBe(true)
      expect(f.send).toHaveBeenCalledOnce()
      expect(results(f, "test").items[0]?.lastSuccessAt).toBeNull()
      expect(testAudit(f.store).map((entry) => entry.outcome)).toEqual(["started", "failed"])
    } finally {
      held.resolve()
      await pending
    }
  })

  it("cancels the actual manual-test transport when the HTTP client disconnects", async () => {
    const f = await httpFixture()
    const entered = deferred<void>()
    const held = deferred<void>()
    let signal: AbortSignal | undefined
    f.send.mockImplementationOnce((_chatId, _text, current) => {
      signal = current
      entered.resolve()
      return held.promise
    })
    const pending = f.request(`${route}/test`, "POST", f.input())
    const disconnected = pending.promise.catch(() => undefined)
    try {
      await entered.promise
      pending.destroy()
      await disconnected
      await vi.waitFor(() => expect(signal?.aborted).toBe(true))
      await vi.waitFor(() => expect(results(f, "test").items[0]?.lastError).toBe("cancelled"))
      expect(f.send).toHaveBeenCalledOnce()
      expect((await f.call(`${route}/test`, "POST", f.input())).status).toBe(429)
      expect(testAudit(f.store).map((entry) => entry.outcome)).toEqual(["started", "failed"])
    } finally {
      held.resolve()
      await disconnected
    }
  })

  it("returns no HTTP success on server shutdown and drains before the database closes", async () => {
    const f = await httpFixture()
    const entered = deferred<void>()
    const held = deferred<void>()
    let signal: AbortSignal | undefined
    f.send.mockImplementationOnce((_chatId, _text, current) => {
      signal = current
      entered.resolve()
      return held.promise
    })
    const pending = f.call(`${route}/test`, "POST", f.input())
    try {
      await entered.promise
      const stopping = f.server.stop()
      const response = await pending
      expect(response.status).toBe(503)
      expect(response.body).not.toContain('"success":true')
      expect(signal?.aborted).toBe(true)
      await stopping
      await f.worker.close()
      const prepare = vi.spyOn(f.store.db, "prepare")
      f.closeStore()
      prepare.mockClear()
      held.resolve()
      await Promise.resolve()
      await Promise.resolve()
      expect(prepare).not.toHaveBeenCalled()
    } finally {
      held.resolve()
      await pending
    }
  })

  it("drains a cancelled catalog refresh without writing to SQLite after close", async () => {
    const f = fixture()
    const held = deferred<StatusSummary>()
    const entered = deferred<void>()
    let signal: AbortSignal | undefined
    f.readSummary.mockImplementationOnce((_provider, options) => {
      signal = options?.signal
      entered.resolve()
      return held.promise
    })
    const pending = f.worker.components("github", new AbortController().signal)
    const rejected = expect(pending).rejects.toMatchObject({ status: 503 })
    await entered.promise
    await f.worker.close()
    await rejected
    expect(signal?.aborted).toBe(true)
    const prepare = vi.spyOn(f.store.db, "prepare")
    f.closeStore()
    prepare.mockClear()
    held.resolve(summary("github"))
    await Promise.resolve()
    await Promise.resolve()
    expect(prepare).not.toHaveBeenCalled()
    await expect(f.worker.components("github", new AbortController().signal)).rejects.toMatchObject(
      { status: 503 },
    )
    expect(() => f.worker.deliveries({ offset: 0, limit: 100 })).toThrow(AdminError)
  })
})
