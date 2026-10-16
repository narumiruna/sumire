import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { effectivePolicy, inherited, initialPolicy } from "@narumitw/sumire-policy"
import { afterEach, expect, it, vi } from "vitest"
import { ChatAccess } from "../src/admin/access.js"
import { AdminStore } from "../src/admin/store.js"
import { createPiSessionFactory } from "../src/agent/pi-session-factory.js"
import { ChatSessionRegistry } from "../src/agent/session-registry.js"
import { loadSettings } from "../src/config/settings.js"
import { createTelegramAgentBot } from "../src/telegram/bot.js"

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
})
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "sumire-database-access-"))
  const file = path.join(root, "admin.sqlite")
  const store = new AdminStore(file, 7)
  cleanup.push(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { root, file, store }
}

it.each(["7,-100", "", "invalid,not-a-number"])(
  "ignores obsolete access values and starts with no chat grants: %j",
  (value) => {
    const { root, store } = fixture()
    const settings = loadSettings({ BOT_ADMIN_ID: "7", BOT_WHITELIST: value }, root)
    expect(settings).not.toHaveProperty("botWhitelist")
    expect(initialPolicy()).toMatchObject({ privateUsers: [], groups: [] })
    store.applied(1, true)
    expect(store.allows(7)).toBe(false)
    expect(store.allows(-100)).toBe(false)
    expect(store.allowsTool(7, "bash")).toBe(false)
    expect(settings.admin.origin).toBe("http://localhost:17465")
  },
)

it.each([2, 3])(
  "preserves version %i policies, revocations, credentials, reports, and sessions on reopen",
  (version) => {
    const { file, store } = fixture()
    const policy = store.snapshot().policy
    policy.privateUsers = [7]
    policy.groups = [-100]
    policy.chats["-100"] = { ...inherited, enabled: false }
    store.save(policy, 1, "7")
    store.applied(2, true)
    const session = store.createSession("7")
    store.db
      .prepare("INSERT INTO passkeys VALUES (?,?,?,?,?,?,?)")
      .run("7", "credential-fixture", Buffer.from("public-key"), 0, "handle", "singleDevice", 0)
    store.db
      .prepare("INSERT INTO access_reviews VALUES (?,?,?,?,?)")
      .run("fixture-review", 2, "7", 1, JSON.stringify([{ id: -100, decision: "retain-denial" }]))
    store.db.prepare("INSERT INTO imports VALUES (?,?)").run("fixture-import", '{"accepted":1}')
    store.db.exec(`PRAGMA user_version=${version}`)
    const before = store.snapshot()
    const audit = store.listAudit(0)
    const reopened = new AdminStore(file, 7)
    try {
      expect(reopened.snapshot()).toEqual(before)
      expect(reopened.listAudit(0)).toEqual(audit)
      expect(reopened.session(session.value)).toBeDefined()
      expect(reopened.db.prepare("SELECT id FROM passkeys").get()).toMatchObject({
        id: "credential-fixture",
      })
      expect(reopened.db.prepare("SELECT COUNT(*) AS n FROM access_reviews").get()).toMatchObject({
        n: 1,
      })
      expect(
        reopened.db.prepare("SELECT report FROM imports WHERE name='fixture-import'").get(),
      ).toMatchObject({ report: '{"accepted":1}' })
      expect(reopened.allows(7)).toBe(true)
      expect(reopened.allows(-100)).toBe(false)
      expect(reopened.allows(-200)).toBe(false)
    } finally {
      reopened.close()
    }
  },
)

it("denies new and restored sessions before resource loading for absent, pending, failed, or revoked policy", async () => {
  const { root, store } = fixture()
  const create = vi.fn()
  const registry = new ChatSessionRegistry(create, root, logger, { control: store })
  try {
    for (const success of [false, true]) {
      store.applied(1, success)
      await expect(registry.submit(7, "denied")).rejects.toThrow("Chat policy")
      await registry.recover([7, -100], vi.fn())
      expect(create).not.toHaveBeenCalled()
    }
    const p = store.snapshot().policy
    p.privateUsers = [7]
    store.save(p, 1, "7")
    await expect(registry.submit(7, "pending")).rejects.toThrow("Chat policy")
    expect(create).not.toHaveBeenCalled()
    p.privateUsers = []
    store.save(p, 2, "7")
    store.applied(3, true)
    await expect(registry.submit(7, "revoked")).rejects.toThrow("Chat policy")
    expect(create).not.toHaveBeenCalled()
  } finally {
    await registry.dispose()
  }
})

it("disposes a session if access is revoked while its creation is pending", async () => {
  const { root, store } = fixture()
  const state = store.snapshot()
  state.policy.privateUsers = [7]
  store.save(state.policy, 1, "7")
  store.applied(2, true)
  let resolve!: (session: never) => void
  const creating = new Promise<never>((done) => {
    resolve = done
  })
  const create = vi.fn(() => creating)
  const registry = new ChatSessionRegistry(create, root, logger, { control: store })
  const pending = registry.submit(7, "before revocation")
  await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
  const dispose = vi.fn(async () => {})
  store.applied(2, false)
  resolve({ dispose } as never)
  await expect(pending).rejects.toThrow("Chat policy")
  expect(dispose).toHaveBeenCalledOnce()
  await registry.dispose()
})

it("has no store-optional transport, registry, or factory entry path", async () => {
  const { root } = fixture()
  const settings = loadSettings({ BOT_ADMIN_ID: "7" }, root)
  expect(() => new ChatSessionRegistry(vi.fn(), root, logger, undefined as never)).toThrow(
    "Database authorization is required",
  )
  expect(() => createTelegramAgentBot(settings, {} as never, logger, undefined as never)).toThrow(
    "Database authorization is required",
  )
  await expect(createPiSessionFactory(settings, logger, undefined as never)).rejects.toThrow(
    "Database authorization is required",
  )
})

it("approves only the link's chat without expanding capability ceilings or sender-based group access", () => {
  const { store } = fixture()
  const access = new ChatAccess(store)
  const result = access.issue({ id: 7, type: "private", name: "Fixture" }, "http://localhost:17465")
  if (result.approved) throw new Error("Unexpected approval")
  const token = new URLSearchParams(new URL(result.url).hash.slice(1)).get("allow") as string
  access.approve(token, "http://localhost:17465", 1, "7")
  store.applied(2, true)
  expect(store.allows(7)).toBe(true)
  expect(store.allows(-100)).toBe(false)
  expect(effectivePolicy(store.snapshot().policy, 7).tools).toEqual([])
  expect(() => access.approve(token, "http://localhost:17465", 2, "7")).toThrow("no longer valid")
})
