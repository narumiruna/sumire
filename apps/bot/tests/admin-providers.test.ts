import { mkdtempSync, rmSync } from "node:fs"
import { stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { chatModelRuntime, ProviderAdmin, providerFetch } from "../src/admin/providers.js"
import { TestAdminStore as AdminStore } from "./helpers/admin-store.js"

const directories: string[] = []
const stores: AdminStore[] = []
function setup() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sumire-providers-"))
  directories.push(directory)
  const store = new AdminStore(path.join(directory, "admin.sqlite"), new Set([42]), 42)
  stores.push(store)
  const model = {
    id: "test",
    provider: "fixture",
    reasoning: false,
    input: ["text"],
    api: "openai-completions",
  }
  const runtime = {
    getProviders: () => [
      { id: "fixture", name: "Fixture", auth: { oauth: {}, apiKey: { login: true } } },
    ],
    getProvider: () => ({ auth: { oauth: true } }),
    getModels: () => [model],
    getModel: () => model,
    getPhysicalModel: () => model,
    getAvailable: async () => [model],
    hasConfiguredAuth: () => false,
    checkAuth: vi.fn(async () => ({ type: "api_key", source: "fixture" })),
    streamSimple: vi.fn(() => ({ result: async () => "compacted" })),
    logout: vi.fn(async () => {}),
    login: vi.fn(async () => ({})),
  } as unknown as ModelRuntime
  const policy = store.snapshot().policy
  policy.models = ["fixture/test"]
  policy.defaults.models = [...policy.models]
  policy.defaults.model = "fixture/test"
  store.save(policy, 1, "42")
  store.applied(2, true)
  return { store, runtime, model, admin: new ProviderAdmin(runtime, store) }
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe("Pi model administration contracts", () => {
  it("persists literal API keys only through Pi and restores them on restart", async () => {
    const { store } = setup()
    const authPath = path.join(path.dirname(store.file), "auth.json")
    const runtime = await ModelRuntime.create({
      authPath,
      modelsPath: null,
      refreshOnCreate: false,
    })
    const admin = new ProviderAdmin(runtime, store)
    await admin.credential("openai", "literal-fixture-api-key")
    const restored = await ModelRuntime.create({
      authPath,
      modelsPath: null,
      refreshOnCreate: false,
    })
    const restoredInventory = await new ProviderAdmin(restored, store).inventory()
    expect(restoredInventory.find((p) => p.id === "openai")?.configured).toBe(true)
    expect(JSON.stringify(restoredInventory)).not.toContain("literal-fixture-api-key")
    expect(await restored.getAuth("openai")).toMatchObject({
      auth: { apiKey: "literal-fixture-api-key" },
    })
    expect((await stat(authPath)).mode & 0o077).toBe(0)
    expect(JSON.stringify(await admin.inventory())).not.toContain("literal-fixture-api-key")
    expect(JSON.stringify(store.snapshot())).not.toContain("literal-fixture-api-key")
  })

  it("registers compatible providers through Pi and restores models and credentials", async () => {
    const { store } = setup()
    const authPath = path.join(path.dirname(store.file), "custom-auth.json")
    const runtime = await ModelRuntime.create({
      authPath,
      modelsPath: null,
      refreshOnCreate: false,
    })
    const admin = new ProviderAdmin(runtime, store)
    const policy = store.snapshot().policy
    policy.providers = [
      {
        id: "compatible",
        enabled: true,
        api: "openai-completions",
        baseUrl: "https://1.1.1.1/v1",
        models: [
          {
            id: "custom/model",
            name: "Compatible",
            reasoning: true,
            image: true,
            contextWindow: 64000,
            maxTokens: 4000,
          },
        ],
      },
    ]
    policy.models = ["compatible/custom/model"]
    policy.defaults.models = [...policy.models]
    policy.defaults.model = policy.models[0] as string
    await admin.validate(policy)
    store.save(policy, 2, "42")
    admin.install(policy.providers)
    await admin.credential("compatible", "compatible-key-fixture")
    expect(runtime.getPhysicalModel("compatible", "custom/model")).toMatchObject({
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 64000,
    })
    expect((await admin.inventory()).find((p) => p.id === "compatible")?.models).toEqual([
      expect.objectContaining({ id: "custom/model", reasoning: true, image: true }),
    ])
    const restored = await ModelRuntime.create({
      authPath,
      modelsPath: null,
      refreshOnCreate: false,
    })
    const restoredAdmin = new ProviderAdmin(restored, store)
    restoredAdmin.install(store.snapshot().policy.providers)
    expect((await restoredAdmin.inventory()).find((p) => p.id === "compatible")?.configured).toBe(
      true,
    )
    expect(await restored.getAuth("compatible")).toMatchObject({
      auth: { apiKey: "compatible-key-fixture" },
    })
    expect(restored.getPhysicalModel("compatible", "custom/model")).toMatchObject({
      maxTokens: 4000,
    })
    expect(JSON.stringify(store.snapshot())).not.toContain("compatible-key-fixture")
  })
  it("validates new custom model metadata rather than the old runtime snapshot", async () => {
    const { store, admin } = setup()
    const policy = store.snapshot().policy
    policy.providers = [
      {
        id: "fixture",
        enabled: true,
        baseUrl: "https://1.1.1.1/v1",
        api: "openai-completions",
        models: [
          {
            id: "test",
            name: "Test",
            reasoning: false,
            image: false,
            contextWindow: 32000,
            maxTokens: 1000,
          },
        ],
      },
    ]
    policy.defaults.thinking = "high"
    await expect(admin.validate(policy)).rejects.toThrow("Unsupported thinking")
    policy.defaults.thinking = "off"
    policy.providers[0]?.models.splice(0, 1)
    await expect(admin.validate(policy)).rejects.toThrow("Unknown model")
  })
  it("uses the same authorization for normal generation and compaction", async () => {
    const { store, runtime, model } = setup()
    const scoped = chatModelRuntime(runtime, store, 42)
    scoped.streamSimple(model as never, { messages: [] })
    expect(await scoped.completeSimple(model as never, { messages: [] })).toBe("compacted")
    expect(runtime.streamSimple).toHaveBeenCalledTimes(2)
    const policy = store.snapshot().policy
    policy.privateUsers = []
    store.save(policy, 2, "42")
    store.applied(3, true)
    expect(() => scoped.streamSimple(model as never, { messages: [] })).toThrow("policy")
    await expect(async () =>
      scoped.completeSimple(model as never, { messages: [] }),
    ).rejects.toThrow()
    expect(() => scoped.stream(model as never, { messages: [] })).toThrow("not available")
  })
  it("blocks credential removal while any model reference remains", async () => {
    const { admin, runtime } = setup()
    await expect(admin.credential("fixture", null)).rejects.toThrow("referenced")
    expect(runtime.logout).not.toHaveBeenCalled()
    for (const key of ["!execute-command", "$ENV_KEY", "a\nb"])
      await expect(admin.credential("fixture", key)).rejects.toThrow("literal")
  })
  it("returns current non-secret authentication and supported thinking levels", async () => {
    const { admin, runtime } = setup()
    const inventory = await admin.inventory()
    expect(inventory[0]).toMatchObject({
      id: "fixture",
      configured: true,
      models: [{ id: "test", thinking: ["off"], reasoning: false, image: false }],
    })
    expect(JSON.stringify(inventory)).not.toContain("credential")
    expect(runtime.checkAuth).toHaveBeenCalledWith("fixture", { signal: expect.any(AbortSignal) })
  })
  it("reports missing authentication from the current check", async () => {
    const { admin, runtime } = setup()
    runtime.hasConfiguredAuth = () => true
    vi.mocked(runtime.checkAuth).mockResolvedValue(undefined)
    expect((await admin.inventory())[0]?.configured).toBe(false)
  })
  it("does not report a failed authentication check as missing credentials", async () => {
    const { admin, runtime } = setup()
    vi.mocked(runtime.checkAuth).mockRejectedValue(new Error("Credential store unavailable"))
    await expect(admin.inventory()).rejects.toThrow("Credential store unavailable")
  })
  it("binds OAuth to its initiating session and supports cancellation", async () => {
    const { admin, runtime } = setup()
    vi.mocked(runtime.login).mockImplementation(async (_id, _type, interaction) => {
      await interaction.prompt({ type: "manual_code", message: "Enter code" })
      return { type: "oauth", access: "fixture", refresh: "fixture", expires: 0 }
    })
    const id = admin.startLogin("fixture", "owner")
    expect(() => admin.loginState(id, "other")).toThrow("not found")
    expect(admin.loginState(id, "owner").prompt?.type).toBe("manual_code")
    await admin.cancelOwner("owner")
    expect(admin.loginState(id, "owner").status).toBe("cancelled")
    expect(admin.loginState(id, "owner").prompt).toBeUndefined()
  })
  it("applies completed OAuth credentials without exposing returned tokens", async () => {
    const { store, runtime } = setup()
    const apply = vi.fn(async () => {})
    const admin = new ProviderAdmin(runtime, store, apply)
    vi.mocked(runtime.login).mockImplementation(async (_id, _type, interaction) => {
      const code = await interaction.prompt({ type: "manual_code", message: "Enter code" })
      if (code !== "approved") throw new Error("Denied")
      return {
        type: "oauth",
        access: "provider-token-fixture",
        refresh: "refresh-fixture",
        expires: 0,
      }
    })
    const id = admin.startLogin("fixture", "owner")
    admin.loginState(id, "owner").answer?.("approved")
    await admin.loginState(id, "owner").done
    expect(admin.loginState(id, "owner").status).toBe("completed")
    expect(apply).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(admin.loginState(id, "owner"))).not.toContain("provider-token-fixture")
    expect(() => new ProviderAdmin(runtime, store).loginState(id, "owner")).toThrow("not found")
    const denied = admin.startLogin("fixture", "owner")
    admin.loginState(denied, "owner").answer?.("denied")
    await admin.loginState(denied, "owner").done
    expect(admin.loginState(denied, "owner").status).toBe("failed")
    expect(apply).toHaveBeenCalledTimes(1)
  })
  it("expires an unanswered OAuth interaction and clears its prompt", async () => {
    const { admin, runtime } = setup()
    vi.mocked(runtime.login).mockImplementation(async (_id, _type, interaction) => {
      await interaction.prompt({ type: "manual_code", message: "Enter code" })
      return { type: "oauth", access: "unused", refresh: "unused", expires: 0 }
    })
    const id = admin.startLogin("fixture", "owner", Date.now() + 1)
    await admin.loginState(id, "owner").done
    expect(admin.loginState(id, "owner").status).toBe("failed")
    expect(admin.loginState(id, "owner").prompt).toBeUndefined()
  })
  it.each([
    "http://127.0.0.1",
    "http://[::1]",
    "http://169.254.169.254/latest/meta-data",
    "http://10.0.0.1",
    "http://user:pass@example.com",
  ])("rejects unsafe custom request %s", async (url) => {
    await expect(providerFetch(url)).rejects.toThrow()
  })
})
