import { mkdtemp, rm } from "node:fs/promises"
import { request } from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { createPolicyApplier, startAdmin } from "../src/admin/application.js"
import { McpAdmin } from "../src/admin/mcp.js"
import type { ChatSessionRegistry } from "../src/agent/session-registry.js"
import { TestAdminStore as AdminStore } from "./helpers/admin-store.js"
import { createPiFixture } from "./helpers/pi-fixture.js"
import { createTestSessionFactory } from "./helpers/session-factory.js"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sumire-admin-apply-"))
  const store = new AdminStore(path.join(directory, "admin.sqlite"), new Set([42]), 42)
  cleanups.push(async () => {
    store.close()
    await rm(directory, { recursive: true, force: true })
  })
  const sessions = { invalidatePolicies: vi.fn(async () => {}) }
  const providers = { validate: vi.fn(async () => {}), install: vi.fn() }
  const save = () => {
    const state = store.snapshot()
    store.save(state.policy, state.revision, "42")
  }
  return {
    store,
    sessions,
    providers,
    save,
    apply: createPolicyApplier(store, sessions, providers),
  }
}

it("preserves observed metadata across repeated actual administration startup", async () => {
  const fixture = await createPiFixture()
  // Keep the offline fixture provider registered while startup applies empty admin providers.
  const unregister = vi
    .spyOn(fixture.modelRuntime, "unregisterProvider")
    .mockImplementation(() => {})
  const file = path.join(path.dirname(fixture.settings.botSessionLogDir), "admin.sqlite")
  let store = new AdminStore(file, new Set([42]), 42)
  const policy = fixture.factory.control.snapshot().policy
  policy.models = ["openai/gpt-6.1-sol"]
  policy.defaults.models = [...policy.models]
  policy.defaults.thinking = "off"
  store.save(policy, store.snapshot().revision, "42")
  store.observe(-100, "supergroup", "Persistent group")
  store.db.prepare("INSERT INTO chats VALUES (?,?,?)").run(-200, "group", "-200")
  store.close()
  try {
    const initial = await fixture.createSession(-100)
    await initial.dispose()
    expect(await fixture.factory.listChats()).toContain(-100)
    for (let restart = 0; restart < 2; restart++) {
      store = new AdminStore(file, new Set([42]), 42)
      const mcp = new McpAdmin(store, fixture.root)
      const factory = await createTestSessionFactory(
        fixture.settings,
        fixture.logger,
        undefined,
        fixture.modelRuntime,
        { store, mcp },
      )
      const server = await startAdmin(
        { origin: "https://admin.example.test", host: "127.0.0.1", port: 0, assets: fixture.root },
        { store, mcp },
        factory,
        { invalidatePolicies: vi.fn(async () => {}) } as unknown as ChatSessionRegistry,
      )
      try {
        const expectedName = restart === 0 ? "Persistent group" : "Persisted rename"
        expect(store.listChats(0)).toContainEqual({
          id: -100,
          type: "supergroup",
          name: expectedName,
        })
        const { value } = store.createSession("42")
        const get = (route: string) =>
          new Promise<unknown>((resolve, reject) => {
            const req = request(
              {
                hostname: "127.0.0.1",
                port: (server.server.address() as AddressInfo).port,
                path: route,
                headers: { host: "admin.example.test", cookie: `__Host-sumire-session=${value}` },
              },
              (res) => {
                let body = ""
                res.on("data", (chunk) => {
                  body += chunk
                })
                res.on("end", () => {
                  try {
                    expect(res.statusCode).toBe(200)
                    resolve(JSON.parse(body))
                  } catch (error) {
                    reject(error)
                  }
                })
              },
            )
            req.on("error", reject)
            req.end()
          })
        const metadata = (id: number) => get(`/api/chats?id=${id}`)
        expect(await get("/api/inventory")).toMatchObject({ skills: factory.skills })
        expect(factory.skills).toContainEqual(expect.objectContaining({ name: "load-url-content" }))
        expect(await metadata(-100)).toEqual([
          expect.objectContaining({ name: expectedName, type: "supergroup" }),
        ])
        expect(await metadata(-200)).toEqual([
          expect.objectContaining({ name: "-200", type: "group" }),
        ])
        const before = store.snapshot()
        const recreate = await factory.create(-100)
        await recreate.dispose()
        expect(await metadata(-100)).toEqual([
          expect.objectContaining({ name: expectedName, type: "supergroup" }),
        ])
        expect(store.snapshot()).toEqual(before)
        if (restart === 0) {
          store.observe(-100, "supergroup", "Persisted rename")
          expect(await metadata(-100)).toEqual([
            expect.objectContaining({ name: "Persisted rename" }),
          ])
        }
        expect(fixture.requests).toEqual([])
      } finally {
        await server.stop()
        await mcp.close()
        store.close()
      }
    }
  } finally {
    unregister.mockRestore()
    await fixture.cleanup()
  }
})

it("coalesces concurrent applications and applies the latest saved revision", async () => {
  const { store, sessions, providers, save, apply } = await setup()
  let release!: () => void
  sessions.invalidatePolicies.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      }),
  )
  save()
  const first = apply()
  save()
  const second = apply()
  expect(second).toBe(first)
  expect(store.snapshot()).toMatchObject({ revision: 3, status: "pending", applied: 0 })
  expect(sessions.invalidatePolicies).toHaveBeenCalledTimes(1)
  release()
  await Promise.all([first, second])
  expect(sessions.invalidatePolicies).toHaveBeenCalledTimes(2)
  expect(providers.install).toHaveBeenCalledTimes(1)
  expect(store.snapshot()).toMatchObject({ revision: 3, status: "applied", applied: 3 })
  expect(store.listAudit(0).filter((row) => row.operation === "settings.apply")).toHaveLength(1)
})

it("retries a newer revision when superseded validation fails", async () => {
  const { store, providers, save, apply } = await setup()
  let reject!: (error: Error) => void
  providers.validate.mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail
      }),
  )
  const first = apply()
  await vi.waitFor(() => expect(providers.validate).toHaveBeenCalledTimes(1))
  save()
  const second = apply()
  reject(new Error("superseded"))
  await Promise.all([first, second])
  expect(providers.validate).toHaveBeenCalledTimes(2)
  expect(providers.install).toHaveBeenCalledTimes(1)
  expect(store.snapshot()).toMatchObject({ revision: 2, applied: 2, status: "applied" })
})

it("marks a current failure and allows an explicit retry", async () => {
  const { store, providers, apply } = await setup()
  providers.validate.mockRejectedValueOnce(new Error("private diagnostic"))
  await expect(apply()).rejects.toThrow("Settings could not be applied")
  expect(store.snapshot()).toMatchObject({ status: "failed", applied: 0 })
  expect(providers.install).not.toHaveBeenCalled()
  await apply()
  expect(store.snapshot()).toMatchObject({ status: "applied", applied: 1 })
})
