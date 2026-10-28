import type { JsonObject } from "@earendil-works/pi-ai"
import { expect, it, vi } from "vitest"
import { adminShellEnvironment } from "../src/admin/shell.js"
import { createGithubNotificationsTool } from "../src/agent/github-notifications.js"
import { callDurableTool } from "./helpers/durable-session.js"
import { createPiFixture } from "./helpers/pi-fixture.js"

it.each([123, -100])(
  "blocks non-allowlisted or group chat %s before a network request",
  async (chatId) => {
    const fetcher = vi.fn<typeof fetch>()
    const readSecret = vi.fn(() => "synthetic-token")
    const tool = createGithubNotificationsTool(
      chatId,
      { readSecret, readVariable: () => "[7]" },
      fetcher,
    )
    await expect(tool.execute("id", {}, undefined, undefined, undefined as never)).rejects.toThrow(
      "restricted",
    )
    expect(readSecret).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  },
)
it("never makes the dedicated notification credential available to bash", () => {
  const readSecret = vi.fn((name: string) =>
    name === "GITHUB_NOTIFICATIONS_TOKEN" ? "private-notification-token" : undefined,
  )
  expect(
    JSON.stringify(adminShellEnvironment({}, { readSecret, readVariable: () => undefined })),
  ).not.toContain("private-notification-token")
  expect(readSecret).not.toHaveBeenCalledWith("GITHUB_NOTIFICATIONS_TOKEN")
})
it.each(["read_github_notifications", "codemode"])(
  "enforces the whitelist through the real durable %s path",
  async (name) => {
    const fixture = await createPiFixture()
    try {
      const { runtime, control } = fixture.factory
      if (!runtime) throw new Error("Missing runtime fixture")
      const session = await fixture.createSession()
      const args: JsonObject =
        name === "codemode" ? { code: "await tools.read_github_notifications({})" } : {}
      const denied = await callDurableTool(session, name, args)
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied)).toContain("restricted")
      // No secret is configured: after allowlisting the private chat, the next gate is auth.
      runtime.save(
        "GITHUB_NOTIFICATIONS_ALLOWED_USER_IDS",
        { revision: control.snapshot().revision, kind: "variable", value: "[123]" },
        "7",
      )
      control.applied(control.snapshot().revision, true)
      const noToken = await callDurableTool(session, name, args)
      expect(noToken.isError).toBe(true)
      expect(JSON.stringify(noToken)).toContain("GITHUB_NOTIFICATIONS_TOKEN")
    } finally {
      await fixture.cleanup()
    }
  },
)
it("returns sanitized metadata only to an allowed private chat and rechecks revocation", async () => {
  let ids = "[123]"
  const readSecret = vi.fn(() => "synthetic-token")
  const fetcher = vi.fn<typeof fetch>(async () => new Response("[]"))
  const tool = createGithubNotificationsTool(123, { readSecret, readVariable: () => ids }, fetcher)
  expect(
    (await tool.execute("id", {}, undefined, undefined, undefined as never)).details,
  ).toMatchObject({ notifications: [] })
  ids = "[]"
  await expect(tool.execute("id", {}, undefined, undefined, undefined as never)).rejects.toThrow(
    "restricted",
  )
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it("does not grant the administrator an allowlist bypass", async () => {
  const tool = createGithubNotificationsTool(
    7,
    { readSecret: () => "fixture-token", readVariable: () => "[]" },
    vi.fn<typeof fetch>(),
  )
  await expect(tool.execute("id", {}, undefined, undefined, undefined as never)).rejects.toThrow(
    "restricted",
  )
})
it("rejects group access even when the caller's private ID is allowed", async () => {
  const tool = createGithubNotificationsTool(
    -100,
    { readSecret: () => "fixture-token", readVariable: () => "[7,123]" },
    vi.fn<typeof fetch>(),
  )
  await expect(tool.execute("id", {}, undefined, undefined, undefined as never)).rejects.toThrow(
    "restricted",
  )
})
it("honors normal tool denial for direct and nested catalogs", async () => {
  const fixture = await createPiFixture()
  try {
    const { control } = fixture.factory
    const policy = control.snapshot().policy
    policy.tools = policy.tools.filter((name) => name !== "read_github_notifications")
    policy.defaults.tools =
      policy.defaults.tools?.filter((name) => name !== "read_github_notifications") ?? []
    control.save(policy, control.snapshot().revision, "7")
    control.applied(control.snapshot().revision, true)
    const session = await fixture.createSession()
    expect(session.getActiveToolNames()).not.toContain("read_github_notifications")
    const nested = await callDurableTool(session, "codemode", {
      code: "await tools.read_github_notifications({})",
    })
    expect(nested.isError).toBe(true)
  } finally {
    await fixture.cleanup()
  }
})

it.each(["read_github_notifications", "codemode"])(
  "reads only after both allowlist and credential are applied through %s",
  async (name) => {
    const fixture = await createPiFixture()
    const fetcher = vi.fn<typeof fetch>(async () => new Response("[]"))
    try {
      const { runtime, control } = fixture.factory
      if (!runtime) throw new Error("Missing runtime fixture")
      runtime.save(
        "GITHUB_NOTIFICATIONS_ALLOWED_USER_IDS",
        { revision: control.snapshot().revision, kind: "variable", value: "[123]" },
        "7",
      )
      runtime.save(
        "GITHUB_NOTIFICATIONS_TOKEN",
        {
          revision: control.snapshot().revision,
          kind: "secret",
          value: "synthetic-notification-token",
        },
        "7",
      )
      control.applied(control.snapshot().revision, true)
      const session = await fixture.createSession()
      vi.stubGlobal("fetch", fetcher)
      const args: JsonObject =
        name === "codemode" ? { code: "text(await tools.read_github_notifications({}))" } : {}
      const result = await callDurableTool(session, name, args)
      expect(result.isError).toBeFalsy()
      expect(JSON.stringify(result)).toContain("notifications")
      expect(JSON.stringify(result)).not.toContain("synthetic-notification-token")
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(String(fetcher.mock.calls[0]?.[0])).toContain("https://api.github.com/notifications")
      runtime.remove("GITHUB_NOTIFICATIONS_ALLOWED_USER_IDS", control.snapshot().revision, "7")
      control.applied(control.snapshot().revision, true)
      const denied = await callDurableTool(session, name, args)
      expect(denied.isError).toBe(true)
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
      await fixture.cleanup()
    }
  },
)

it("rechecks applied policy when a response arrives during a settings change", async () => {
  let applied = true
  const fetcher = vi.fn<typeof fetch>(async () => {
    applied = false
    return new Response("[]")
  })
  const tool = createGithubNotificationsTool(
    123,
    {
      readSecret: () => "synthetic-token",
      readVariable: () => "[123]",
    },
    fetcher,
    () => {
      if (!applied) throw new Error("Policy unavailable")
    },
  )
  await expect(tool.execute("id", {}, undefined, undefined, undefined as never)).rejects.toThrow(
    "Policy unavailable",
  )
  expect(fetcher).toHaveBeenCalledTimes(1)
})
