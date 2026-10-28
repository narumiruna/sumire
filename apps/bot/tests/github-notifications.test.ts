import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { JsonObject } from "@earendil-works/pi-ai"
import { expect, it, vi } from "vitest"
import { AdminStore } from "../src/admin/store.js"
import { createGithubNotificationsTool } from "../src/agent/github-notifications.js"
import { callDurableTool } from "./helpers/durable-session.js"
import { createPiFixture } from "./helpers/pi-fixture.js"

const toolName = "read_github_notifications"
const execute = (tool: ReturnType<typeof createGithubNotificationsTool>) =>
  tool.execute("id", {}, undefined, undefined, undefined as never)
const setRecipients = (store: AdminStore, allowedUserIds: number[]) => {
  const state = store.snapshot()
  state.policy.githubNotifications.allowedUserIds = allowedUserIds
  store.save(state.policy, state.revision, "7")
}
const toolArgs = (name: string): JsonObject =>
  name === "codemode" ? { code: "text(await tools.read_github_notifications({}))" } : {}

it.each([123, -100, 7])(
  "blocks non-allowlisted private users, groups, and administrator chat %s before HTTP",
  async (chatId) => {
    const fetcher = vi.fn<typeof fetch>()
    const readSecret = vi.fn(() => "synthetic-token")
    const tool = createGithubNotificationsTool(chatId, {
      allowedUserIds: () => [42],
      assertAccess() {},
      runtime: { readSecret, readVariable: () => "[123,7]" },
      fetch: fetcher,
    })
    await expect(execute(tool)).rejects.toThrow("restricted")
    expect(readSecret).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  },
)
it("rejects groups even when the caller's private ID is allowed", async () => {
  const fetcher = vi.fn<typeof fetch>()
  const tool = createGithubNotificationsTool(-100, {
    allowedUserIds: () => [7, 123],
    assertAccess() {},
    runtime: { readSecret: () => "fixture-token", readVariable: () => undefined },
    fetch: fetcher,
  })
  await expect(execute(tool)).rejects.toThrow("restricted")
  expect(fetcher).not.toHaveBeenCalled()
})
it("uses only managed GH_TOKEN and never reads runtime variables or host credentials", async () => {
  vi.stubEnv("GH_TOKEN", "host-token")
  vi.stubEnv("GITHUB_TOKEN", "host-fallback-token")
  const readSecret = vi.fn((name: string) =>
    name === "GITHUB_NOTIFICATIONS_TOKEN" ? "legacy-token" : undefined,
  )
  const readVariable = vi.fn(() => "[123]")
  const fetcher = vi.fn<typeof fetch>()
  const tool = createGithubNotificationsTool(123, {
    allowedUserIds: () => [123],
    assertAccess() {},
    runtime: { readSecret, readVariable },
    fetch: fetcher,
  })
  try {
    await expect(execute(tool)).rejects.toThrow("applied GH_TOKEN secret is required")
    expect(readSecret).toHaveBeenCalledExactlyOnceWith("GH_TOKEN")
    expect(readVariable).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
    const withoutRuntime = createGithubNotificationsTool(123, {
      allowedUserIds: () => [123],
      assertAccess() {},
      fetch: fetcher,
    })
    await expect(execute(withoutRuntime)).rejects.toThrow("applied GH_TOKEN secret is required")
    expect(fetcher).not.toHaveBeenCalled()
  } finally {
    vi.unstubAllEnvs()
  }
})
it("returns metadata only to an allowed private chat and rechecks the latest recipients", async () => {
  let allowedUserIds = [123]
  const readSecret = vi.fn(() => "synthetic-token")
  const fetcher = vi.fn<typeof fetch>(async () => new Response("[]"))
  const tool = createGithubNotificationsTool(123, {
    allowedUserIds: () => allowedUserIds,
    assertAccess() {},
    runtime: { readSecret, readVariable: () => undefined },
    fetch: fetcher,
  })
  expect((await execute(tool)).details).toMatchObject({ notifications: [] })
  expect(readSecret).toHaveBeenCalledExactlyOnceWith("GH_TOKEN")
  allowedUserIds = []
  await expect(execute(tool)).rejects.toThrow("restricted")
  expect(fetcher).toHaveBeenCalledTimes(1)
})
it("checks host tool access before resolving recipients, credentials, or HTTP", async () => {
  const allowedUserIds = vi.fn(() => [123])
  const readSecret = vi.fn(() => "fixture-token")
  const fetcher = vi.fn<typeof fetch>()
  const tool = createGithubNotificationsTool(123, {
    allowedUserIds,
    assertAccess() {
      throw new Error("Tool is not allowed")
    },
    runtime: { readSecret, readVariable: () => undefined },
    fetch: fetcher,
  })
  await expect(execute(tool)).rejects.toThrow("Tool is not allowed")
  expect(allowedUserIds).not.toHaveBeenCalled()
  expect(readSecret).not.toHaveBeenCalled()
  expect(fetcher).not.toHaveBeenCalled()
})
it("defaults old persisted policies closed and persists recipient changes with revisions and audit", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sumire-notification-policy-"))
  const file = path.join(directory, "admin.sqlite")
  let store = new AdminStore(file, 7)
  try {
    const oldPolicy: Record<string, unknown> = { ...store.snapshot().policy }
    delete oldPolicy.githubNotifications
    store.db.prepare("UPDATE settings SET policy=? WHERE id=1").run(JSON.stringify(oldPolicy))
    expect(store.snapshot().policy.githubNotifications).toEqual({ allowedUserIds: [] })
    store.close()
    store = new AdminStore(file, 7)
    expect(store.snapshot().policy.githubNotifications.allowedUserIds).toEqual([])
    const original = store.snapshot()
    setRecipients(store, [123])
    expect(store.snapshot()).toMatchObject({
      revision: original.revision + 1,
      status: "pending",
      policy: { githubNotifications: { allowedUserIds: [123] } },
    })
    expect(() => store.save(original.policy, original.revision, "7")).toThrow("Settings changed")
    const invalid = store.snapshot()
    invalid.policy.githubNotifications.allowedUserIds = [123, 123]
    expect(() => store.save(invalid.policy, invalid.revision, "7")).toThrow()
    expect(store.snapshot().revision).toBe(original.revision + 1)
    store.applied(store.snapshot().revision, true)
    store.close()
    store = new AdminStore(file, 7)
    expect(store.snapshot().policy.githubNotifications.allowedUserIds).toEqual([123])
    setRecipients(store, [])
    store.applied(store.snapshot().revision, true)
    store.close()
    store = new AdminStore(file, 7)
    expect(store.snapshot().policy.githubNotifications.allowedUserIds).toEqual([])
    expect(
      store.listAudit(0).filter((entry) => entry.operation === "settings.update"),
    ).toHaveLength(2)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
it.each([toolName, "codemode"])(
  "enforces persisted recipient policy through the real durable %s path",
  async (name) => {
    const fixture = await createPiFixture()
    try {
      const { control } = fixture.factory
      const session = await fixture.createSession()
      const denied = await callDurableTool(session, name, toolArgs(name))
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied)).toContain("restricted")
      setRecipients(control, [123])
      control.applied(control.snapshot().revision, true)
      const noToken = await callDurableTool(session, name, toolArgs(name))
      expect(noToken.isError).toBe(true)
      expect(JSON.stringify(noToken)).toContain("GH_TOKEN")
    } finally {
      await fixture.cleanup()
    }
  },
)
it("honors normal tool denial for direct and nested catalogs", async () => {
  const fixture = await createPiFixture()
  try {
    const { control } = fixture.factory
    const policy = control.snapshot().policy
    policy.tools = policy.tools.filter((name) => name !== toolName)
    policy.defaults.tools = policy.defaults.tools?.filter((name) => name !== toolName) ?? []
    control.save(policy, control.snapshot().revision, "7")
    control.applied(control.snapshot().revision, true)
    const session = await fixture.createSession()
    expect(session.getActiveToolNames()).not.toContain(toolName)
    const nested = await callDurableTool(session, "codemode", {
      code: "await tools.read_github_notifications({})",
    })
    expect(nested.isError).toBe(true)
  } finally {
    await fixture.cleanup()
  }
})
it.each([toolName, "codemode"])(
  "requires applied policy and GH_TOKEN, and honors persisted removals through %s",
  async (name) => {
    const fixture = await createPiFixture()
    const fetcher = vi.fn<typeof fetch>(async () => new Response("[]"))
    try {
      const { runtime, control } = fixture.factory
      if (!runtime) throw new Error("Missing runtime fixture")
      const session = await fixture.createSession()
      setRecipients(control, [123])
      runtime.save(
        "GH_TOKEN",
        {
          revision: control.snapshot().revision,
          kind: "secret",
          value: "synthetic-notification-token",
        },
        "7",
      )
      vi.stubGlobal("fetch", fetcher)
      expect((await callDurableTool(session, name, toolArgs(name))).isError).toBe(true)
      control.applied(control.snapshot().revision, false)
      expect((await callDurableTool(session, name, toolArgs(name))).isError).toBe(true)
      expect(fetcher).not.toHaveBeenCalled()
      control.applied(control.snapshot().revision, true)
      const result = await callDurableTool(session, name, toolArgs(name))
      expect(result.isError).toBeFalsy()
      expect(JSON.stringify(result)).toContain("notifications")
      expect(JSON.stringify(result)).not.toContain("synthetic-notification-token")
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(String(fetcher.mock.calls[0]?.[0])).toContain("https://api.github.com/notifications")
      expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
        Authorization: "Bearer synthetic-notification-token",
      })
      setRecipients(control, [])
      control.applied(control.snapshot().revision, true)
      expect((await callDurableTool(session, name, toolArgs(name))).isError).toBe(true)
      setRecipients(control, [123])
      runtime.remove("GH_TOKEN", control.snapshot().revision, "7")
      control.applied(control.snapshot().revision, true)
      const noToken = await callDurableTool(session, name, toolArgs(name))
      expect(noToken.isError).toBe(true)
      expect(JSON.stringify(noToken)).toContain("GH_TOKEN")
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
      await fixture.cleanup()
    }
  },
)
it.each([
  [toolName, "recipients"],
  [toolName, "tool"],
  ["codemode", "recipients"],
  ["codemode", "tool"],
])("rechecks persisted %s access after in-flight %s revocation", async (name, gate) => {
  const fixture = await createPiFixture()
  try {
    const { control, runtime } = fixture.factory
    if (!runtime) throw new Error("Missing runtime fixture")
    setRecipients(control, [123])
    runtime.save(
      "GH_TOKEN",
      { revision: control.snapshot().revision, kind: "secret", value: "synthetic-token" },
      "7",
    )
    control.applied(control.snapshot().revision, true)
    const session = await fixture.createSession()
    const fetcher = vi.fn<typeof fetch>(async () => {
      const state = control.snapshot()
      if (gate === "recipients") state.policy.githubNotifications.allowedUserIds = []
      else
        state.policy.defaults.tools =
          state.policy.defaults.tools?.filter((n) => n !== toolName) ?? []
      control.save(state.policy, state.revision, "7")
      control.applied(control.snapshot().revision, true)
      return new Response("[]")
    })
    vi.stubGlobal("fetch", fetcher)
    const result = await callDurableTool(session, name, toolArgs(name))
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain(gate === "recipients" ? "restricted" : "not allowed")
    expect(JSON.stringify(result)).not.toContain('"notifications":[]')
    expect(fetcher).toHaveBeenCalledTimes(1)
  } finally {
    vi.unstubAllGlobals()
    await fixture.cleanup()
  }
})
