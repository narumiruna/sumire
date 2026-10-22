import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { effectivePolicy, inherited, POLICY_MAX_NAMES } from "@narumitw/sumire-policy"
import { afterEach, expect, it } from "vitest"
import { AdminStore } from "../src/admin/store.js"

const directories: string[] = []
const stores = new Set<AdminStore>()
function open(file?: string) {
  if (!file) {
    const directory = mkdtempSync(path.join(os.tmpdir(), "sumire-skills-"))
    directories.push(directory)
    file = path.join(directory, "admin.sqlite")
  }
  const store = new AdminStore(file, 42)
  stores.add(store)
  return store
}
function close(store: AdminStore) {
  stores.delete(store)
  store.close()
}
afterEach(() => {
  for (const store of stores) store.close()
  stores.clear()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

it("enables first-seen skills and preserves explicit overrides, admission, and other settings", () => {
  const store = open()
  const policy = store.snapshot().policy
  policy.privateUsers = [42, 43, 44]
  policy.chats["42"] = { ...inherited, enabled: true }
  policy.chats["43"] = { ...inherited, skills: [], enabled: true }
  policy.chats["44"] = { ...inherited, skills: ["manual"], enabled: true }
  policy.skills = ["manual"]
  store.save(policy, 1, "42")
  store.applied(2, true)
  const before = store.snapshot()
  store.registerSkills(["review", "release", "review", "manual"])
  const state = store.snapshot()
  expect(state).toMatchObject({ revision: 3, applied: 3, status: "applied", epoch: before.epoch })
  expect(state.policy).toEqual({
    ...before.policy,
    skills: ["manual", "review", "release"],
    defaults: { ...before.policy.defaults, skills: ["review", "release"] },
  })
  expect(effectivePolicy(state.policy, 42).skills).toEqual(["review", "release"])
  expect(effectivePolicy(state.policy, 43).skills).toEqual([])
  expect(effectivePolicy(state.policy, 44).skills).toEqual(["manual"])
  expect(store.allows(42)).toBe(true)
  expect(store.allows(99)).toBe(false)
  expect(store.listAudit(0)[0]).toMatchObject({
    actor: "system",
    operation: "skills.register",
    revision: 3,
    outcome: "enabled",
    target: "review, release",
  })
  store.registerSkills(["review", "release"])
  store.registerSkills([])
  expect(store.snapshot()).toEqual(state)
})

it("keeps manual removals after restart and only enables newly loaded skills", () => {
  let store = open()
  store.registerSkills(["review", "release"])
  const state = store.snapshot()
  state.policy.skills = ["release"]
  state.policy.defaults.skills = []
  store.save(state.policy, state.revision, "42")
  store.applied(3, true)
  const file = store.file
  close(store)
  store = open(file)
  store.registerSkills(["review", "release", "new"])
  expect(store.snapshot().policy.skills).toEqual(["release", "new"])
  expect(store.snapshot().policy.defaults.skills).toEqual(["new"])
  expect(store.snapshot()).toMatchObject({ revision: 4, applied: 4, status: "applied" })
  expect(store.db.prepare("SELECT name FROM known_skills ORDER BY name").all()).toEqual([
    { name: "new" },
    { name: "release" },
    { name: "review" },
  ])
})

it.each(["pending", "failed"])("does not apply a %s revision when registering skills", (status) => {
  const store = open()
  const policy = store.snapshot().policy
  policy.privateUsers = [42]
  policy.skills = ["global_only"]
  policy.defaults.skills = null
  store.save(policy, 1, "42")
  if (status === "failed") store.applied(2, false)
  const before = store.snapshot()
  store.registerSkills(["global_only", "new"])
  expect(store.snapshot()).toMatchObject({
    status,
    revision: 3,
    applied: 0,
    epoch: before.epoch,
  })
  expect(store.snapshot().policy.defaults.skills).toEqual(["new"])
  expect(store.allows(42)).toBe(false)
})

it.each([0, POLICY_MAX_NAMES - 1, POLICY_MAX_NAMES])(
  "defers overflow skills until capacity is free (default skills: %s)",
  (defaults) => {
    const store = open()
    const policy = store.snapshot().policy
    policy.privateUsers = [42]
    policy.skills = Array.from({ length: POLICY_MAX_NAMES }, (_, i) => `known_${i}`)
    policy.defaults.skills = policy.skills.slice(0, defaults)
    store.save(policy, 1, "42")
    store.applied(2, true)
    const before = store.snapshot()
    store.registerSkills(["new_a", "new_b"])
    expect(store.snapshot()).toEqual(before)
    expect(store.allows(42)).toBe(true)
    expect(
      store.db.prepare("SELECT name FROM known_skills WHERE name='new_a'").get(),
    ).toBeUndefined()
    policy.skills = policy.skills.slice(1)
    policy.defaults.skills = policy.defaults.skills.filter((name) => name !== "known_0")
    store.save(policy, before.revision, "42")
    store.applied(3, true)
    store.registerSkills(["known_0", "new_a", "new_b"])
    expect(store.snapshot().policy.skills).toHaveLength(POLICY_MAX_NAMES)
    expect(store.snapshot().policy.skills).toContain("new_a")
    expect(store.snapshot().policy.defaults.skills).toContain("new_a")
    expect(store.snapshot().policy.skills).not.toContain("known_0")
    expect(store.snapshot().policy.skills).not.toContain("new_b")
    expect(store.allows(42)).toBe(true)
  },
)

it("rolls back skill registration and rejects invalid skill references without changing state", () => {
  const store = open()
  const before = store.snapshot()
  expect(() => store.registerSkills(["review", ""])).toThrow()
  expect(store.snapshot()).toEqual(before)
  expect(store.db.prepare("SELECT * FROM known_skills").all()).toEqual([])
  expect(store.listAudit(0)).toEqual([])
  const policy = store.snapshot().policy
  policy.defaults.skills = ["unknown"]
  expect(() => store.save(policy, 1, "42")).toThrow(
    "Defaults: skills selection exceeds global availability: unknown",
  )
  policy.defaults.skills = null
  policy.chats["42"] = { ...inherited, skills: ["unknown"], enabled: true }
  expect(() => store.save(policy, 1, "42")).toThrow(
    "Chats → 42: skills selection exceeds global availability: unknown",
  )
  expect(store.snapshot()).toEqual(before)
  expect(store.listAudit(0)).toEqual([])
})

it("upgrades an old database and saved policy without losing persisted records", () => {
  let store = open()
  const policy = store.snapshot().policy
  policy.privateUsers = [42]
  policy.tools = ["read"]
  policy.defaults.tools = ["read"]
  policy.chats["42"] = { ...inherited, tools: [], enabled: true }
  store.save(policy, 1, "42")
  store.registerTools(["read"])
  store.applied(2, true)
  store.observe(42, "private", "Fixture")
  const session = store.createSession("42")
  const before = store.snapshot()
  const audit = store.listAudit(0)
  const old = JSON.parse(JSON.stringify(before.policy))
  delete old.skills
  delete old.defaults.skills
  delete old.chats["42"].skills
  store.db.prepare("UPDATE settings SET policy=? WHERE id=1").run(JSON.stringify(old))
  store.db.exec("DROP TABLE known_skills")
  const file = store.file
  close(store)
  store = open(file)
  expect(store.snapshot()).toEqual({
    ...before,
    policy: {
      ...before.policy,
      skills: [],
      defaults: { ...before.policy.defaults, skills: null },
    },
  })
  expect(store.listAudit(0)).toEqual(audit)
  expect(store.session(session.value)?.csrf).toBe(session.csrf)
  expect(store.listChats(0)).toEqual([{ id: 42, type: "private", name: "Fixture" }])
  expect(store.db.prepare("SELECT name FROM known_tools").all()).toEqual([{ name: "read" }])
  store.registerSkills(["review"])
  expect(store.snapshot()).toMatchObject({ revision: 3, applied: 3, status: "applied" })
  expect(store.snapshot().policy.skills).toEqual(["review"])
  expect(effectivePolicy(store.snapshot().policy, 42).skills).toEqual(["review"])
})
