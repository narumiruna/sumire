import { readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { expect, it, vi } from "vitest"
import { McpAdmin } from "../src/admin/mcp.js"
import type { DurableSession } from "../src/agent/durable-session.js"
import { ChatSessionRegistry } from "../src/agent/session-registry.js"
import { TestAdminStore as AdminStore } from "./helpers/admin-store.js"
import { createPiFixture, toolResultText } from "./helpers/pi-fixture.js"
import { createTestSessionFactory as createPiSessionFactory } from "./helpers/session-factory.js"

it("cancels an active Pi tool, denies new work, and does not replay it after restart", async () => {
  const fixture = await createPiFixture()
  const store = new AdminStore(path.join(fixture.root, "admin.sqlite"), new Set([123]), 123)
  const mcp = new McpAdmin(store, fixture.settings.botWorkdir)
  let session: DurableSession | undefined
  let reopened: DurableSession | undefined
  let registry: ChatSessionRegistry | undefined
  try {
    const policy = store.snapshot().policy
    policy.tools = ["bash"]
    policy.defaults.tools = ["bash"]
    policy.models = ["openai/gpt-6.1-sol"]
    policy.defaults.models = [...policy.models]
    policy.defaults.model = policy.models[0] as string
    store.save(policy, 1, "123")
    store.applied(2, true)
    const factory = await createPiSessionFactory(
      fixture.settings,
      fixture.logger,
      undefined,
      fixture.modelRuntime,
      { store, mcp },
    )
    const current = await factory.create(123)
    session = current
    registry = new ChatSessionRegistry(
      async () => current,
      fixture.settings.botSessionLogDir,
      fixture.logger,
      { control: store },
    )
    await registry.appendPassiveContext(123, "context")
    const marker = path.join(fixture.root, "marker.txt")
    fixture.enqueue(
      "bash",
      { command: `printf 'started\\n' >> ${JSON.stringify(marker)}; sleep 30` },
      false,
    )
    const pending = session.prompt("run once").catch(() => undefined)
    await vi.waitFor(async () => expect(await readFile(marker, "utf8")).toBe("started\n"))
    await expect(session.followUp("queued request must not run")).resolves.toBe("queued")
    policy.privateUsers = []
    store.save(policy, store.snapshot().revision, "123")
    await registry.invalidatePolicies()
    await pending
    store.applied(store.snapshot().revision, true)
    await expect(registry.appendPassiveContext(123, "context")).rejects.toThrow("policy")
    expect((await stat(session.sessionFile)).size).toBeGreaterThan(0)
    policy.privateUsers = [123]
    policy.tools = []
    policy.defaults.tools = []
    store.save(policy, store.snapshot().revision, "123")
    store.applied(store.snapshot().revision, true)
    reopened = await factory.create(123)
    const deliver = vi.fn(async () => {})
    await reopened.recoverPending(deliver)
    expect(deliver).not.toHaveBeenCalled()
    fixture.enqueueAnswer("New permitted turn")
    await reopened.prompt("continue without the withdrawn tool")
    expect(await readFile(marker, "utf8")).toBe("started\n")
    expect(fixture.requests).toHaveLength(2)
  } finally {
    await registry?.dispose()
    await session?.dispose()
    await reopened?.dispose()
    await mcp.close()
    store.close()
    await fixture.cleanup()
  }
})

it("cancels pre-change persisted work after an MCP edit even when chat permissions are unchanged", async () => {
  const fixture = await createPiFixture()
  const store = new AdminStore(path.join(fixture.root, "admin.sqlite"), new Set([123]), 123)
  const mcp = new McpAdmin(store, fixture.settings.botWorkdir)
  let session: DurableSession | undefined
  let reopened: DurableSession | undefined
  const release = fixture.pauseNextRequest()
  try {
    const policy = store.snapshot().policy
    policy.models = ["openai/gpt-6.1-sol"]
    policy.defaults.models = [...policy.models]
    policy.defaults.model = policy.models[0] as string
    store.save(policy, 1, "123")
    store.applied(2, true)
    const factory = await createPiSessionFactory(
      fixture.settings,
      fixture.logger,
      undefined,
      fixture.modelRuntime,
      { store, mcp },
    )
    session = await factory.create(123)
    fixture.enqueueAnswer("Offline response")
    const pending = session
      .prompt("old admitted turn", { delivery: { sourceMessageId: 71, mode: "default" } })
      .catch(() => undefined)
    await vi.waitFor(() => expect(fixture.requests).toHaveLength(1))
    const before = store.snapshot()
    mcp.save("unused", { command: process.execPath }, before.revision, "123")
    expect(store.snapshot().policy).toEqual(before.policy)
    expect(store.snapshot().epoch).toBe(before.epoch + 1)
    // Simulate shutdown before live policy application, then an empty-registry startup apply.
    await session.dispose()
    await pending
    await vi.waitFor(() => expect(fixture.disconnectedRequests).toBe(1))
    release()
    store.applied(store.snapshot().revision, true)
    reopened = await factory.create(123)
    const deliver = vi.fn(async () => {})
    await reopened.recoverPending(deliver)
    expect(deliver).not.toHaveBeenCalled()
    expect(fixture.requests).toHaveLength(1)
    await reopened.prompt("new admitted turn")
    expect(fixture.requests).toHaveLength(2)
  } finally {
    release()
    await session?.dispose()
    await reopened?.dispose()
    await mcp.close()
    store.close()
    await fixture.cleanup()
  }
})

it("denies stale direct and codemode calls in actual Pi turns without reading the target", async () => {
  const fixture = await createPiFixture()
  const store = new AdminStore(path.join(fixture.root, "admin.sqlite"), new Set([123]), 123)
  const mcp = new McpAdmin(store, fixture.settings.botWorkdir)
  let session: DurableSession | undefined
  try {
    const policy = store.snapshot().policy
    policy.tools = ["read", "codemode"]
    policy.defaults.tools = [...policy.tools]
    policy.models = ["openai/gpt-6.1-sol"]
    policy.defaults.models = [...policy.models]
    policy.defaults.model = policy.models[0] as string
    store.save(policy, 1, "123")
    store.applied(2, true)
    const factory = await createPiSessionFactory(
      fixture.settings,
      fixture.logger,
      undefined,
      fixture.modelRuntime,
      { store, mcp },
    )
    session = await factory.create(123)
    const file = path.join(fixture.root, "fixture.txt")
    await writeFile(file, "private-fixture-content")
    const code = `text(await tools.read(${JSON.stringify({ path: file })}))`
    expect(toolResultText(await fixture.script(session, code))).toContain("private-fixture-content")
    const checkpoint = session.sessionManager.getLeafId()
    if (!checkpoint) throw new Error("Missing fixture checkpoint")
    policy.tools = ["codemode"]
    policy.defaults.tools = ["codemode"]
    store.save(policy, store.snapshot().revision, "123")
    store.applied(store.snapshot().revision, true)
    expect(await session.navigateTree(checkpoint)).toEqual({ cancelled: false })
    const nested = await fixture.script(session, code)
    expect(nested.isError).toBe(true)
    expect(toolResultText(nested)).not.toContain("private-fixture-content")
    const direct = await fixture.call(session, "read", { path: file })
    expect(direct.isError).toBe(true)
    expect(toolResultText(direct)).not.toContain("private-fixture-content")
    policy.tools = []
    policy.defaults.tools = []
    store.save(policy, store.snapshot().revision, "123")
    store.applied(store.snapshot().revision, true)
    expect((await fixture.script(session, 'text("should not execute")')).isError).toBe(true)
  } finally {
    await session?.abort()
    await session?.dispose()
    await mcp.close()
    store.close()
    await fixture.cleanup()
  }
})
