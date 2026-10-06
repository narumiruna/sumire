import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import type { Credential, OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createBotModelRuntime } from "../src/agent/model-runtime.js"
import { loadSettings } from "../src/config/settings.js"

async function setup(environment: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "sumire-oauth-model-"))
  const settings = loadSettings({ BOT_ADMIN_ID: "7", BOT_WHITELIST: "7", ...environment }, root)
  const agentDir = path.join(settings.botSessionLogDir, ".pi-agent")
  return { settings, agentDir }
}

const credential: OAuthCredential = {
  type: "oauth",
  access: "fixture-access",
  refresh: "fixture-refresh",
  expires: Date.now() + 3_600_000,
}

async function storeCredential(agentDir: string, credential: Credential) {
  await mkdir(agentDir, { recursive: true })
  await writeFile(path.join(agentDir, "auth.json"), JSON.stringify({ openai: credential }), {
    mode: 0o600,
  })
}

describe("bot model authentication", () => {
  beforeEach(() => vi.stubEnv("OPENAI_API_KEY", ""))
  afterEach(() => vi.unstubAllEnvs())

  it("allows OAuth bootstrap without a key and uses the native Responses model", async () => {
    const { settings, agentDir } = await setup()
    const { modelRuntime, model, login } = await createBotModelRuntime(settings, agentDir)
    expect(model).toMatchObject({ provider: "openai", api: "openai-responses", id: "gpt-5.6-luna" })
    expect(login).toBeDefined()
    expect(await modelRuntime.checkAuth("openai")).toBeUndefined()
    expect(modelRuntime.getProvider("openai")?.auth.apiKey).toBeDefined()
    expect(modelRuntime.getProvider("openai")?.auth.oauth).toBeDefined()
  })

  it("uses a configured API key before login without requiring an admin", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fixture-env-key")
    const { settings, agentDir } = await setup({
      OPENAI_API_KEY: "fixture-settings-key",
      BOT_ADMIN_ID: "",
    })
    const { modelRuntime, model, login } = await createBotModelRuntime(settings, agentDir)
    expect(model).toMatchObject({ provider: "openai", api: "openai-responses" })
    expect(login).toBeUndefined()
    expect(await modelRuntime.checkAuth("openai")).toMatchObject({ type: "api_key" })
    expect(await modelRuntime.getAuth("openai")).toMatchObject({
      auth: { apiKey: "fixture-settings-key" },
    })
  })

  it("retains Pi's environment API-key authentication", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fixture-env-key")
    const { settings, agentDir } = await setup({ BOT_ADMIN_ID: "" })
    const { modelRuntime } = await createBotModelRuntime(settings, agentDir)
    expect(await modelRuntime.getAuth("openai")).toMatchObject({
      auth: { apiKey: "fixture-env-key" },
      source: "OPENAI_API_KEY",
    })
  })

  it.each([{ BOT_ADMIN_ID: "" }, { BOT_WHITELIST: "8" }, { BOT_WHITELIST: "-100" }])(
    "requires an explicitly allowlisted admin to bootstrap without credentials: %j",
    async (environment) => {
      const { settings, agentDir } = await setup(environment)
      await expect(createBotModelRuntime(settings, agentDir)).rejects.toThrow(
        "BOT_ADMIN_ID explicitly listed",
      )
    },
  )

  it.each([{ BOT_ADMIN_ID: "" }, { BOT_WHITELIST: "8" }, { BOT_WHITELIST: "-100" }])(
    "disables login without blocking API-key requests: %j",
    async (environment) => {
      const { settings, agentDir } = await setup({ OPENAI_API_KEY: "fixture-key", ...environment })
      const { modelRuntime, login } = await createBotModelRuntime(settings, agentDir)
      expect(login).toBeUndefined()
      expect(await modelRuntime.checkAuth("openai")).toMatchObject({ type: "api_key" })
    },
  )

  it("uses stored native credentials without requiring a login admin", async () => {
    const { settings, agentDir } = await setup({ BOT_ADMIN_ID: "" })
    await storeCredential(agentDir, credential)
    const { modelRuntime, login } = await createBotModelRuntime(settings, agentDir)
    expect(login).toBeUndefined()
    expect(await modelRuntime.getAuth("openai")).toMatchObject({
      auth: { apiKey: "fixture-access" },
      source: "OAuth",
    })
  })

  it("preserves stored API-key priority over the configured key", async () => {
    const { settings, agentDir } = await setup({ OPENAI_API_KEY: "fixture-key" })
    await storeCredential(agentDir, { type: "api_key", key: "fixture-stored-key" })
    const { modelRuntime } = await createBotModelRuntime(settings, agentDir)
    expect(await modelRuntime.getAuth("openai")).toMatchObject({
      auth: { apiKey: "fixture-stored-key" },
    })
  })

  it("reports unsupported native models", async () => {
    const { settings, agentDir } = await setup({ OPENAI_MODEL: "not-a-real-model" })
    await expect(createBotModelRuntime(settings, agentDir)).rejects.toThrow(
      "Pi model not found: openai/not-a-real-model",
    )
  })

  it("keeps custom endpoints API-key-only even with stored native OAuth", async () => {
    const { settings, agentDir } = await setup({
      OPENAI_API_KEY: "fixture-key",
      OPENAI_BASE_URL: "https://proxy.example.test/v1",
      OPENAI_MODEL: "custom-model",
    })
    await storeCredential(agentDir, credential)
    const runtime = await createBotModelRuntime(settings, agentDir)
    expect(runtime.login).toBeUndefined()
    expect(runtime.model).toMatchObject({
      provider: "telegramagent-openai",
      api: "openai-completions",
      id: "custom-model",
    })
    expect(await runtime.modelRuntime.getAuth(runtime.model)).toMatchObject({
      auth: { apiKey: "fixture-key" },
    })
    expect(runtime.modelRuntime.getProvider(runtime.model.provider)?.auth.oauth).toBeUndefined()
    await expect(
      createBotModelRuntime({ ...settings, openaiApiKey: undefined }, agentDir),
    ).rejects.toThrow("OPENAI_API_KEY is required for a custom OPENAI_BASE_URL")
  })

  it("prefers OAuth after login and restart, then returns to the key after logout", async () => {
    const { settings, agentDir } = await setup({ OPENAI_API_KEY: "fixture-key" })
    const { modelRuntime, model, login } = await createBotModelRuntime(settings, agentDir)
    const provider = modelRuntime.getProvider("openai")
    if (!provider?.auth.oauth || !login) throw new Error("Missing OAuth provider")
    modelRuntime.registerNativeProvider({
      ...provider,
      auth: {
        ...provider.auth,
        oauth: { ...provider.auth.oauth, login: async () => credential },
      },
    })
    expect(await modelRuntime.getAuth(model)).toMatchObject({ auth: { apiKey: "fixture-key" } })
    await login.login({ prompt: vi.fn(), notify: vi.fn() })
    expect(await modelRuntime.checkAuth("openai")).toMatchObject({ type: "oauth" })
    expect(await modelRuntime.getAuth(model)).toMatchObject({
      auth: { apiKey: "fixture-access" },
      source: "OAuth",
    })

    const restarted = await createBotModelRuntime(settings, agentDir)
    expect(await restarted.modelRuntime.getAuth(restarted.model)).toMatchObject({
      auth: { apiKey: "fixture-access" },
    })
    await restarted.modelRuntime.logout("openai")
    expect(await restarted.modelRuntime.getAuth(restarted.model)).toMatchObject({
      auth: { apiKey: "fixture-key" },
    })
  })

  it("does not fall back to a key when stored OAuth refresh fails", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fixture-env-key")
    const { settings, agentDir } = await setup({ OPENAI_API_KEY: "fixture-key" })
    await storeCredential(agentDir, { ...credential, expires: 0 })
    const { modelRuntime, model } = await createBotModelRuntime(settings, agentDir)
    const provider = modelRuntime.getProvider("openai")
    if (!provider?.auth.oauth) throw new Error("Missing OAuth provider")
    const refresh = vi.fn(async () => {
      throw new Error("fixture-refresh-failure")
    })
    modelRuntime.registerNativeProvider({
      ...provider,
      auth: {
        ...provider.auth,
        oauth: { ...provider.auth.oauth, refresh },
      },
    })
    await expect(modelRuntime.getAuth(model)).rejects.toThrow("OAuth refresh failed")
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(await modelRuntime.checkAuth("openai")).toMatchObject({ type: "oauth" })
    expect(JSON.parse(await readFile(path.join(agentDir, "auth.json"), "utf8")).openai).toEqual({
      ...credential,
      expires: 0,
    })
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
