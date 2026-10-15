import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { createPolicyApplier } from "../src/admin/application.js"
import { TestAdminStore as AdminStore } from "./helpers/admin-store.js"

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
