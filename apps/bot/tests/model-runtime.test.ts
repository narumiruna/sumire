import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import type { OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai"
import { describe, expect, it, vi } from "vitest"

import { createBotModelRuntime } from "../src/agent/model-runtime.js"
import { loadSettings } from "../src/config/settings.js"

async function setup(environment: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "sumire-oauth-model-"))
  const settings = loadSettings(
    { OPENAI_AUTH_MODE: "oauth", BOT_ADMIN_ID: "7", BOT_WHITELIST: "7", ...environment },
    root,
  )
  const agentDir = path.join(settings.botSessionLogDir, ".pi-agent")
  return { settings, agentDir }
}

const credential: OAuthCredential = {
  type: "oauth",
  access: "fixture-access",
  refresh: "fixture-refresh",
  expires: Date.now() + 3_600_000,
}

describe("bot model authentication", () => {
  it("allows OAuth bootstrap without a key and uses the native Responses model", async () => {
    const { settings, agentDir } = await setup()
    const { modelRuntime, model, login } = await createBotModelRuntime(settings, agentDir)
    expect(model).toMatchObject({ provider: "openai", api: "openai-responses", id: "gpt-5.6-luna" })
    expect(login).toBeDefined()
    expect(await modelRuntime.checkAuth("openai")).toBeUndefined()
    expect(modelRuntime.getProvider("openai")?.auth.apiKey).toBeUndefined()
  })

  it("does not fall back to an environment API key in OAuth mode", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fixture-env-key")
    try {
      const { settings, agentDir } = await setup({ OPENAI_API_KEY: "fixture-settings-key" })
      const { modelRuntime } = await createBotModelRuntime(settings, agentDir)
      expect(await modelRuntime.checkAuth("openai")).toBeUndefined()
      expect(await modelRuntime.getAuth("openai")).toBeUndefined()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it.each([{ BOT_ADMIN_ID: "" }, { BOT_WHITELIST: "8" }, { BOT_WHITELIST: "-100" }])(
    "requires an explicitly allowlisted admin: %j",
    async (environment) => {
      const { settings, agentDir } = await setup(environment)
      await expect(createBotModelRuntime(settings, agentDir)).rejects.toThrow(
        "BOT_ADMIN_ID explicitly listed",
      )
    },
  )

  it("rejects a custom endpoint in OAuth mode", async () => {
    const { settings, agentDir } = await setup({ OPENAI_BASE_URL: "https://proxy.example.test/v1" })
    await expect(createBotModelRuntime(settings, agentDir)).rejects.toThrow(
      "OAuth mode requires OPENAI_BASE_URL",
    )
  })

  it("reports unsupported native models", async () => {
    const { settings, agentDir } = await setup({ OPENAI_MODEL: "not-a-real-model" })
    await expect(createBotModelRuntime(settings, agentDir)).rejects.toThrow(
      "Pi model not found: openai/not-a-real-model",
    )
  })

  it("keeps API-key mode mandatory and compatible with custom endpoints", async () => {
    const { settings, agentDir } = await setup({
      OPENAI_AUTH_MODE: "api_key",
      OPENAI_API_KEY: "fixture-key",
      OPENAI_BASE_URL: "https://proxy.example.test/v1",
      OPENAI_MODEL: "custom-model",
    })
    const runtime = await createBotModelRuntime(settings, agentDir)
    expect(runtime.login).toBeUndefined()
    expect(runtime.model).toMatchObject({
      provider: "telegramagent-openai",
      api: "openai-completions",
      id: "custom-model",
    })
    await expect(
      createBotModelRuntime({ ...settings, openaiApiKey: undefined }, agentDir),
    ).rejects.toThrow("OPENAI_API_KEY is required")
  })

  it("persists Pi credentials and a stable device ID across bot restarts", async () => {
    const { settings, agentDir } = await setup()
    const runtime = await createBotModelRuntime(settings, agentDir)
    const provider = runtime.modelRuntime.getProvider("openai")
    if (!provider?.auth.oauth || !runtime.login) throw new Error("Missing OAuth provider")
    const deviceIds: Array<string | undefined> = []
    const auth: OAuthAuth = {
      ...provider.auth.oauth,
      login: vi.fn(async (_interaction, options) => {
        deviceIds.push(options?.getDeviceId?.())
        return credential
      }),
      refresh: vi.fn(async () => credential),
      toAuth: async (value) => ({ apiKey: value.access }),
    }
    runtime.modelRuntime.registerNativeProvider({ ...provider, auth: { oauth: auth } })
    await runtime.login.login({ prompt: vi.fn(), notify: vi.fn() })
    expect(JSON.parse(await readFile(path.join(agentDir, "auth.json"), "utf8")).openai.type).toBe(
      "oauth",
    )
    expect(await runtime.modelRuntime.getAuth("openai")).toMatchObject({
      auth: { apiKey: "fixture-access" },
    })

    const restarted = await createBotModelRuntime(settings, agentDir)
    expect(await restarted.modelRuntime.checkAuth("openai")).toMatchObject({ type: "oauth" })
    restarted.modelRuntime.registerNativeProvider({ ...provider, auth: { oauth: auth } })
    await restarted.login?.login({ prompt: vi.fn(), notify: vi.fn() })
    expect(deviceIds).toHaveLength(2)
    expect(deviceIds[0]).toMatch(/^[0-9a-f-]{36}$/u)
    expect(deviceIds[1]).toBe(deviceIds[0])
    expect(auth.refresh).not.toHaveBeenCalled()
  })

  it("preserves the existing credential when re-login fails", async () => {
    const { settings, agentDir } = await setup()
    const { modelRuntime, login } = await createBotModelRuntime(settings, agentDir)
    const provider = modelRuntime.getProvider("openai")
    if (!provider?.auth.oauth || !login) throw new Error("Missing OAuth provider")
    const authenticate = vi
      .fn<OAuthAuth["login"]>()
      .mockResolvedValueOnce(credential)
      .mockRejectedValueOnce(new Error("fixture-private-body"))
    modelRuntime.registerNativeProvider({
      ...provider,
      auth: {
        oauth: {
          ...provider.auth.oauth,
          login: authenticate,
          toAuth: async (value) => ({ apiKey: value.access }),
        },
      },
    })
    await login.login({ prompt: vi.fn(), notify: vi.fn() })
    await expect(login.login({ prompt: vi.fn(), notify: vi.fn() })).rejects.toMatchObject({
      kind: "failed",
    })
    expect(await modelRuntime.getAuth("openai")).toMatchObject({
      auth: { apiKey: "fixture-access" },
    })
  })

  it("leaves token refresh and concurrent rotation to Pi", async () => {
    const { settings, agentDir } = await setup()
    const { modelRuntime, login } = await createBotModelRuntime(settings, agentDir)
    const provider = modelRuntime.getProvider("openai")
    if (!provider?.auth.oauth || !login) throw new Error("Missing OAuth provider")
    const refresh = vi.fn(async () => ({
      ...credential,
      access: "rotated-access",
      refresh: "rotated-refresh",
    }))
    modelRuntime.registerNativeProvider({
      ...provider,
      auth: {
        oauth: {
          ...provider.auth.oauth,
          login: async () => ({ ...credential, expires: 0 }),
          refresh,
          toAuth: async (value) => ({ apiKey: value.access }),
        },
      },
    })
    await login.login({ prompt: vi.fn(), notify: vi.fn() })
    const results = await Promise.all([
      modelRuntime.getAuth("openai"),
      modelRuntime.getAuth("openai"),
    ])
    expect(results.every((value) => value?.auth.apiKey === "rotated-access")).toBe(true)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(
      JSON.parse(await readFile(path.join(agentDir, "auth.json"), "utf8")).openai.refresh,
    ).toBe("rotated-refresh")
  })
})
