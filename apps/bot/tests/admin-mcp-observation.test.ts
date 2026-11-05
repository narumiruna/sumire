import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { McpAdmin } from "../src/admin/mcp.js"
import type { NativeTool } from "../src/agent/durable/tools.js"
import { McpCapability } from "../src/agent/mcp-capability.js"
import { TestAdminStore as AdminStore } from "./helpers/admin-store.js"

let directory: string
let store: AdminStore
let mcp: McpAdmin
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "sumire-mcp-observation-"))
  store = new AdminStore(path.join(directory, "admin.sqlite"), new Set([42]), 42)
  mcp = new McpAdmin(store, directory)
  mcp.save("fixture", { command: process.execPath }, 1, "42")
  store.applied(2, true)
  vi.spyOn(McpCapability.prototype, "ready").mockResolvedValue()
  vi.spyOn(McpCapability.prototype, "discoveryOutcome").mockReturnValue({ state: "succeeded" })
})
afterEach(async () => {
  await mcp.close()
  store.close()
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("MCP observations", () => {
  it.each([{ names: [] }, { names: ["mcp__fixture__read"] }])(
    "reports successful publication of $names without grants",
    async ({ names }) => {
      vi.spyOn(McpCapability.prototype, "tools", "get").mockReturnValue(
        names.map((name) => ({ name }) as NativeTool),
      )
      const before = store.snapshot()
      const result = await mcp.discover("fixture")
      expect(result).toEqual({
        status: "connected",
        tools: names,
        observation: { state: "succeeded", revision: 2, completedAt: expect.any(Number) },
      })
      expect(mcp.inventory()[0]).toMatchObject({
        connection: result.status,
        tools: names,
        observation: result.observation,
      })
      expect(store.snapshot()).toEqual(before)
      expect(store.snapshot().policy.tools).toEqual([])
      expect(store.snapshot().policy.defaults.tools).toEqual([])
      expect(store.snapshot().policy.servers).toEqual([])
      expect(mcp.probes.size).toBe(0)
      expect(McpCapability.prototype.ready).toHaveBeenCalledTimes(1)
    },
  )

  it.each(["transport", "listing", "timeout", "cancelled"] as const)(
    "reports safe %s failure without registering names",
    async (reason) => {
      vi.spyOn(McpCapability.prototype, "tools", "get").mockReturnValue([
        { name: "mcp__fixture__unsafe" } as NativeTool,
      ])
      vi.mocked(McpCapability.prototype.discoveryOutcome).mockReturnValue({
        state: "failed",
        reason,
      })
      const register = vi.spyOn(store, "registerTools")
      const result = await mcp.discover("fixture")
      expect(result).toMatchObject({
        status: "unavailable",
        tools: [],
        observation: { state: "failed", reason, revision: 2, completedAt: expect.any(Number) },
      })
      expect(register).not.toHaveBeenCalled()
      expect(mcp.inventory()[0]?.observation).toEqual(result.observation)
      expect(mcp.probes.size).toBe(0)
    },
  )

  it("does not infer success when the startup budget expires before listing", async () => {
    vi.mocked(McpCapability.prototype.discoveryOutcome).mockReturnValue({ state: "checking" })
    expect(await mcp.discover("fixture")).toMatchObject({
      tools: [],
      observation: { state: "failed", reason: "timeout" },
    })
  })

  it("records a safe failure and closes after a rejected discovery wait", async () => {
    vi.mocked(McpCapability.prototype.ready).mockRejectedValue(new Error("private-url and secret"))
    const close = vi.spyOn(McpCapability.prototype, "close")
    const result = await mcp.discover("fixture")
    expect(result.observation).toMatchObject({ state: "failed", reason: "cancelled" })
    expect(JSON.stringify(result)).not.toContain("secret")
    expect(close).toHaveBeenCalledOnce()
    expect(mcp.probes.size).toBe(0)
  })

  it("publishes checking and rejects concurrent probes and connection writes", async () => {
    const pending = deferred()
    vi.mocked(McpCapability.prototype.ready).mockReturnValue(pending.promise)
    const probe = mcp.discover("fixture")
    expect(mcp.inventory()[0]).toMatchObject({
      tools: [],
      observation: { state: "checking", revision: 2, startedAt: expect.any(Number) },
    })
    await expect(mcp.discover("fixture")).rejects.toThrow("already running")
    expect(() => mcp.save("fixture", {}, 2, "42")).toThrow("Wait")
    expect(() => mcp.remove("fixture", 2, "42")).toThrow("Wait")
    pending.resolve()
    await probe
  })

  it.each(["apply", "revision", "epoch", "shutdown"])(
    "rejects stale completion after %s invalidation",
    async (invalidation) => {
      const pending = deferred()
      vi.mocked(McpCapability.prototype.ready).mockReturnValue(pending.promise)
      const register = vi.spyOn(store, "registerTools")
      const probe = mcp.discover("fixture")
      const rejected = expect(probe).rejects.toThrow("settings changed")
      if (invalidation === "apply") mcp.discovered.clear()
      if (invalidation === "revision") store.save(store.snapshot().policy, 2, "42")
      if (invalidation === "epoch") store.db.exec("UPDATE settings SET epoch=epoch+1 WHERE id=1")
      if (invalidation === "shutdown") await mcp.close()
      expect(mcp.inventory()[0]?.observation).toEqual({ state: "untested" })
      pending.resolve()
      await rejected
      expect(register).not.toHaveBeenCalled()
      expect(mcp.inventory()[0]?.observation).toEqual({ state: "untested" })
      expect(mcp.probes.size).toBe(0)
    },
  )

  it("invalidates completed observations after apply, save, and restart", async () => {
    expect(mcp.inventory()[0]?.observation).toEqual({ state: "untested" })
    await mcp.discover("fixture")
    mcp.discovered.clear()
    expect(mcp.inventory()[0]).toMatchObject({
      connection: "not tested",
      tools: [],
      observation: { state: "untested" },
    })
    await mcp.discover("fixture")
    mcp.save("fixture", { description: "changed" }, 2, "42")
    expect(mcp.inventory()[0]?.observation).toEqual({ state: "untested" })
    store.applied(3, true)
    await mcp.discover("fixture")
    const restarted = new McpAdmin(store, directory)
    expect(restarted.inventory()[0]?.observation).toEqual({ state: "untested" })
    await restarted.close()
  })

  it("rejects disabled, invalid, and unapplied entries before starting a probe", async () => {
    await expect(mcp.discover("missing")).rejects.toThrow("disabled or invalid")
    mcp.save("fixture", { enabled: false }, 2, "42")
    await expect(mcp.discover("fixture")).rejects.toThrow("Apply saved")
    store.applied(3, true)
    await expect(mcp.discover("fixture")).rejects.toThrow("disabled or invalid")
    expect(McpCapability.prototype.ready).not.toHaveBeenCalled()
    expect(mcp.probes.size).toBe(0)
  })
})
