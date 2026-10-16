import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { effectivePolicy } from "@narumitw/sumire-policy"
import { expect, it } from "vitest"
import { AdminStore } from "../src/admin/store.js"

it("enables first-seen tools without changing admission, overrides, or server gates", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sumire-tools-"))
  const file = path.join(directory, "admin.sqlite")
  let store = new AdminStore(file, 42)
  try {
    const policy = store.snapshot().policy
    policy.privateUsers = [42, 43]
    policy.chats["43"] = { ...policy.defaults, tools: [], enabled: true }
    store.save(policy, 1, "42")
    store.applied(2, true)
    const before = store.snapshot()
    store.registerTools(["read", "mcp__fixture__echo", "read"])
    const state = store.snapshot()
    expect(state).toMatchObject({ revision: 3, applied: 3, status: "applied", epoch: before.epoch })
    expect(state.policy.tools).toEqual(["read", "mcp__fixture__echo"])
    expect(state.policy.defaults.tools).toEqual(state.policy.tools)
    expect(effectivePolicy(state.policy, 42).tools).toEqual(state.policy.tools)
    expect(effectivePolicy(state.policy, 43).tools).toEqual([])
    expect(store.allowsTool(42, "read")).toBe(true)
    expect(store.allowsTool(99, "read")).toBe(false)
    expect(store.allowsTool(42, "mcp__fixture__echo", "fixture")).toBe(false)
    expect(state.policy.servers).toEqual(before.policy.servers)
    expect(state.policy.defaults.servers).toEqual(before.policy.defaults.servers)
    expect(state.policy.chats).toEqual(before.policy.chats)
    store.registerTools(["read", "mcp__fixture__echo"])
    expect(store.snapshot()).toEqual(state)

    state.policy.tools = []
    state.policy.defaults.tools = []
    store.save(state.policy, state.revision, "42")
    store.applied(4, true)
    store.close()
    store = new AdminStore(file, 42)
    store.registerTools(["read", "mcp__fixture__echo", "write"])
    expect(store.snapshot().policy.tools).toEqual(["write"])
    expect(store.snapshot().policy.defaults.tools).toEqual(["write"])
    expect(store.listAudit(0).filter((entry) => entry.operation === "tools.register")).toHaveLength(
      2,
    )
  } finally {
    store.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it.each(["pending", "failed"])(
  "does not apply a %s revision or change existing selections",
  async (status) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sumire-tools-"))
    const store = new AdminStore(path.join(directory, "admin.sqlite"), 42)
    try {
      const policy = store.snapshot().policy
      policy.tools = ["global_only"]
      policy.defaults.tools = []
      store.save(policy, 1, "42")
      if (status === "failed") store.applied(2, false)
      store.registerTools(["global_only", "new_tool"])
      expect(store.snapshot()).toMatchObject({ status, applied: 0 })
      expect(store.snapshot().policy.defaults.tools).toEqual(["new_tool"])
      expect(store.allowsTool(42, "new_tool")).toBe(false)
    } finally {
      store.close()
      await rm(directory, { recursive: true, force: true })
    }
  },
)

it.each([0, 511, 512])("keeps full policies available (default tools: %s)", async (defaults) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sumire-tools-full-"))
  const store = new AdminStore(path.join(directory, "admin.sqlite"), 42)
  try {
    const policy = store.snapshot().policy
    policy.privateUsers = [42]
    policy.tools = Array.from({ length: 512 }, (_, i) => `known_${i}`)
    policy.defaults.tools = policy.tools.slice(0, defaults)
    const saved = store.save(policy, 1, "42")
    store.applied(saved.revision, true)
    const before = store.snapshot()
    expect(() => store.registerTools(["new_a", "new_b"])).not.toThrow()
    expect(store.snapshot()).toEqual(before)
    expect(store.allows(42)).toBe(true)
    expect(
      store.db.prepare("SELECT name FROM known_tools WHERE name='new_a'").get(),
    ).toBeUndefined()

    // Free one slot. Only the first new name fits. A removed known name stays denied.
    policy.tools = policy.tools.slice(1)
    policy.defaults.tools = policy.defaults.tools.filter((name) => name !== "known_0")
    const freed = store.save(policy, before.revision, "42")
    store.applied(freed.revision, true)
    store.registerTools(["known_0", "new_a", "new_b"])
    const after = store.snapshot()
    expect(after.policy.tools).toHaveLength(512)
    expect(after.policy.tools).toContain("new_a")
    expect(after.policy.defaults.tools).toContain("new_a")
    expect(after.policy.tools).not.toContain("known_0")
    expect(after.policy.tools).not.toContain("new_b")
    expect(store.allows(42)).toBe(true)
  } finally {
    store.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it("rolls back first-seen records if policy validation fails", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sumire-tools-"))
  const store = new AdminStore(path.join(directory, "admin.sqlite"), 42)
  try {
    const before = store.snapshot()
    expect(() => store.registerTools([""])).toThrow()
    expect(store.snapshot()).toEqual(before)
    expect(store.db.prepare("SELECT * FROM known_tools").all()).toEqual([])
  } finally {
    store.close()
    await rm(directory, { recursive: true, force: true })
  }
})
