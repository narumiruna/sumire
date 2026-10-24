import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import type { Credential, OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ProviderAdmin } from "../src/admin/providers.js"
import { createBotModelRuntime } from "../src/agent/model-runtime.js"
import { loadSettings } from "../src/config/settings.js"
import { closeTestStores, TestAdminStore } from "./helpers/admin-store.js"

async function setup(environment: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "sumire-oauth-model-"))
  const settings = loadSettings({ BOT_ADMIN_ID: "7", ...environment }, root)
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

function providerAdmin(
  agentDir: string,
  runtime: Awaited<ReturnType<typeof createBotModelRuntime>>["modelRuntime"],
) {
  return new ProviderAdmin(
    runtime,
    new TestAdminStore(path.join(agentDir, "admin.sqlite"), new Set([7]), 7),
  )
}

async function login(admin: ProviderAdmin) {
  const id = admin.startLogin("openai", "7")
  const state = admin.loginState(id, "7")
  await state.done
  return state
}

describe("bot model authentication", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "")
    vi.stubEnv("HF_TOKEN", "")
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    closeTestStores()
  })

  it("allows local WebUI bootstrap without a key and uses the native Responses model", async () => {
    const { settings, agentDir } = await setup()
    expect(settings.admin?.origin).toBe("http://localhost:17465")
    const { modelRuntime, model } = await createBotModelRuntime(agentDir)
    expect(model).toMatchObject({ provider: "openai", api: "openai-responses", id: "gpt-6.1-sol" })
    expect(await modelRuntime.checkAuth("openai")).toBeUndefined()
    expect(modelRuntime.getProvider("openai")?.auth.apiKey).toBeDefined()
    expect(modelRuntime.getProvider("openai")?.auth.oauth).toBeDefined()
  })

  it("leaves credential resolution to Pi instead of applying bot OpenAI settings", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fixture-env-key")
    const { agentDir } = await setup({
      OPENAI_API_KEY: "ignored-settings-key",
      OPENAI_BASE_URL: "not-a-url",
      OPENAI_MODEL: "not-a-real-model",
    })
    const { modelRuntime, model } = await createBotModelRuntime(agentDir)
    expect(model).toMatchObject({ provider: "openai", api: "openai-responses", id: "gpt-6.1-sol" })
    expect(modelRuntime.getRegisteredProviderConfig("openai")).toBeUndefined()
    expect(modelRuntime.getProvider("telegramagent-openai")).toBeUndefined()
    expect(await modelRuntime.checkAuth("openai")).toMatchObject({ type: "api_key" })
    expect(await modelRuntime.getAuth("openai")).toMatchObject({
      auth: { apiKey: "fixture-env-key" },
      source: "OPENAI_API_KEY",
    })
    expect(process.env.OPENAI_API_KEY).toBe("fixture-env-key")
  })

  it("retains Pi's environment API-key authentication", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fixture-env-key")
    const { agentDir } = await setup()
    const { modelRuntime } = await createBotModelRuntime(agentDir)
    expect(await modelRuntime.getAuth("openai")).toMatchObject({
      auth: { apiKey: "fixture-env-key" },
      source: "OPENAI_API_KEY",
    })
  })

  it.each([
    ["stored API key", { type: "api_key", key: "fixture-stored-key" }, "", true],
    ["stored OAuth", credential, "", true],
    ["expired stored OAuth", { ...credential, expires: 0 }, "", true],
    ["environment API key", undefined, "fixture-env-key", true],
    ["no credentials", undefined, "", false],
  ] as const)(
    "reports %s in WebUI inventory on cold startup without remote requests",
    async (_name, stored, environment, configured) => {
      vi.stubEnv("OPENAI_API_KEY", environment)
      const { agentDir } = await setup()
      if (stored) await storeCredential(agentDir, stored)
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("Unexpected remote authentication request"))
      try {
        const { modelRuntime } = await createBotModelRuntime(agentDir)
        const inventory = await providerAdmin(agentDir, modelRuntime).inventory()
        expect(inventory.find((provider) => provider.id === "openai")?.configured).toBe(configured)
        expect(JSON.stringify(inventory)).not.toMatch(
          /fixture-(?:stored-key|env-key|access|refresh)/,
        )
        expect(fetch).not.toHaveBeenCalled()
      } finally {
        fetch.mockRestore()
      }
    },
  )

  it.each(["8", "-100", ""])(
    "ignores obsolete access values during model setup: %j",
    async (value) => {
      const { agentDir } = await setup({ BOT_WHITELIST: value })
      await expect(createBotModelRuntime(agentDir)).resolves.toHaveProperty("modelRuntime")
    },
  )

  it("uses stored native credentials with required administrator setup", async () => {
    const { agentDir } = await setup()
    await storeCredential(agentDir, credential)
    const { modelRuntime } = await createBotModelRuntime(agentDir)
    expect(await modelRuntime.getAuth("openai")).toMatchObject({
      auth: { apiKey: "fixture-access" },
      source: "OAuth",
    })
  })

  it("leaves stored credential priority over ambient keys to Pi", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fixture-key")
    const { agentDir } = await setup()
    await storeCredential(agentDir, { type: "api_key", key: "fixture-stored-key" })
    const { modelRuntime } = await createBotModelRuntime(agentDir)
    expect(await modelRuntime.getAuth("openai")).toMatchObject({
      auth: { apiKey: "fixture-stored-key" },
    })
  })

  it("keeps WebUI authentication and stored Pi credentials independent of ignored endpoint settings", async () => {
    const { agentDir } = await setup({
      OPENAI_API_KEY: "ignored-key",
      OPENAI_BASE_URL: "https://proxy.example.test/v1",
      OPENAI_MODEL: "custom-model",
    })
    await storeCredential(agentDir, credential)
    const runtime = await createBotModelRuntime(agentDir)
    expect(runtime.model).toMatchObject({
      provider: "openai",
      api: "openai-responses",
      id: "gpt-6.1-sol",
    })
    expect(runtime.modelRuntime.getProvider("telegramagent-openai")).toBeUndefined()
    expect(await runtime.modelRuntime.getAuth(runtime.model)).toMatchObject({
      auth: { apiKey: "fixture-access" },
      source: "OAuth",
    })
  })

  it("lets Pi prefer OAuth after login and restart, then return to ambient credentials after logout", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fixture-key")
    const { agentDir } = await setup()
    const { modelRuntime, model } = await createBotModelRuntime(agentDir)
    const provider = modelRuntime.getProvider("openai")
    if (!provider?.auth.oauth) throw new Error("Missing OAuth provider")
    modelRuntime.registerNativeProvider({
      ...provider,
      auth: {
        ...provider.auth,
        oauth: { ...provider.auth.oauth, login: async () => credential },
      },
    })
    expect(await modelRuntime.getAuth(model)).toMatchObject({ auth: { apiKey: "fixture-key" } })
    expect((await login(providerAdmin(agentDir, modelRuntime))).status).toBe("completed")
    expect(await modelRuntime.checkAuth("openai")).toMatchObject({ type: "oauth" })
    expect(await modelRuntime.getAuth(model)).toMatchObject({
      auth: { apiKey: "fixture-access" },
      source: "OAuth",
    })

    const restarted = await createBotModelRuntime(agentDir)
    expect(await restarted.modelRuntime.getAuth(restarted.model)).toMatchObject({
      auth: { apiKey: "fixture-access" },
    })
    await providerAdmin(agentDir, restarted.modelRuntime).credential("openai", null)
    expect(await restarted.modelRuntime.getAuth(restarted.model)).toMatchObject({
      auth: { apiKey: "fixture-key" },
    })
  })

  it("does not fall back to a key when stored OAuth refresh fails", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fixture-env-key")
    const { agentDir } = await setup()
    await storeCredential(agentDir, { ...credential, expires: 0 })
    const { modelRuntime, model } = await createBotModelRuntime(agentDir)
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

  it("persists administrator API-key changes across restarts and removes them on logout", async () => {
    const { agentDir } = await setup()
    const runtime = await createBotModelRuntime(agentDir)
    const admin = providerAdmin(agentDir, runtime.modelRuntime)
    await admin.credential("openai", "fixture-admin-key")
    expect(await admin.test("openai")).toMatchObject({ configured: true, generatedTokens: false })
    expect(JSON.parse(await readFile(path.join(agentDir, "auth.json"), "utf8")).openai).toEqual({
      type: "api_key",
      key: "fixture-admin-key",
    })
    const restarted = await createBotModelRuntime(agentDir)
    expect(await restarted.modelRuntime.getAuth("openai")).toMatchObject({
      auth: { apiKey: "fixture-admin-key" },
    })
    await providerAdmin(agentDir, restarted.modelRuntime).credential("openai", null)
    const loggedOut = await createBotModelRuntime(agentDir)
    expect(await loggedOut.modelRuntime.checkAuth("openai")).toBeUndefined()
  })

  it("preserves the existing credential when re-login fails", async () => {
    const { agentDir } = await setup()
    const { modelRuntime } = await createBotModelRuntime(agentDir)
    const provider = modelRuntime.getProvider("openai")
    if (!provider?.auth.oauth) throw new Error("Missing OAuth provider")
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
    expect((await login(providerAdmin(agentDir, modelRuntime))).status).toBe("completed")
    expect((await login(providerAdmin(agentDir, modelRuntime))).status).toBe("failed")
    expect(await modelRuntime.getAuth("openai")).toMatchObject({
      auth: { apiKey: "fixture-access" },
    })
  })

  it("leaves token refresh and concurrent rotation to Pi", async () => {
    const { agentDir } = await setup()
    const { modelRuntime } = await createBotModelRuntime(agentDir)
    const provider = modelRuntime.getProvider("openai")
    if (!provider?.auth.oauth) throw new Error("Missing OAuth provider")
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
    expect((await login(providerAdmin(agentDir, modelRuntime))).status).toBe("completed")
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
