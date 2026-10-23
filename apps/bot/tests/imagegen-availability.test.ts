import type { Credential, CredentialStore } from "@earendil-works/pi-ai"
import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { afterEach, expect, it, vi } from "vitest"
import { getImagegenAvailability, hasCodexImageAuth } from "../src/agent/imagegen.js"

const oauth: Credential = {
  type: "oauth",
  access: "synthetic-access",
  refresh: "synthetic-refresh",
  expires: Date.now() + 3_600_000,
}

async function runtimeWith(entries: [string, Credential][]) {
  const values = new Map(entries)
  const credentials: CredentialStore = {
    async read(id) {
      return values.get(id)
    },
    async list() {
      return [...values].map(([providerId, value]) => ({ providerId, type: value.type }))
    },
    async modify(id, update) {
      const next = await update(values.get(id))
      if (next) values.set(id, next)
      return values.get(id)
    },
    async delete(id) {
      values.delete(id)
    },
  }
  return ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false })
}

afterEach(() => vi.restoreAllMocks())

it("recognizes stored Codex OAuth at cold start without refreshing the runtime or resolving secrets", async () => {
  const runtime = await runtimeWith([["openai-codex", oauth]])
  expect(runtime.isUsingOAuth("openai-codex")).toBe(false)
  expect(runtime.getProviderAuthStatus("openai-codex").configured).toBe(false)
  expect(await runtime.checkAuth("openai-codex")).toMatchObject({ type: "oauth" })
  const probes = [
    vi.spyOn(runtime, "checkAuth"),
    vi.spyOn(runtime, "getAuth"),
    vi.spyOn(runtime, "getAvailable"),
    vi.spyOn(runtime, "refresh"),
    vi.spyOn(globalThis, "fetch"),
  ]
  expect(await hasCodexImageAuth(runtime)).toBe(true)
  for (const probe of probes) expect(probe).not.toHaveBeenCalled()
  // Availability must not depend on warming or mutating Pi's snapshot.
  expect(runtime.isUsingOAuth("openai-codex")).toBe(false)
})

it.each<{ name: string; entries: [string, Credential][] }>([
  { name: "missing", entries: [] },
  { name: "separate OpenAI OAuth", entries: [["openai", oauth]] },
  { name: "API key", entries: [["openai-codex", { type: "api_key", key: "synthetic-key" }]] },
])("does not treat $name credentials as Codex OAuth", async ({ entries }) => {
  expect(await hasCodexImageAuth(await runtimeWith(entries))).toBe(false)
})

it("fails closed with a fixed diagnostic when credential metadata cannot be read", async () => {
  const runtime = await runtimeWith([["openai-codex", oauth]])
  vi.spyOn(runtime, "listCredentials").mockRejectedValue(new Error("private-path synthetic-access"))
  expect(await getImagegenAvailability(runtime)).toEqual({
    available: false,
    reason: "Codex credential metadata is unavailable.",
  })
})

it("rechecks provider compatibility after asynchronous credential metadata reads", async () => {
  const runtime = await runtimeWith([["openai-codex", oauth]])
  const provider = runtime.getProvider("openai-codex")
  if (!provider) throw new Error("Missing fixture provider")
  vi.spyOn(runtime, "listCredentials").mockImplementation(async () => {
    vi.spyOn(runtime, "getProvider").mockReturnValue({
      ...provider,
      baseUrl: "https://example.com",
    })
    return [{ providerId: "openai-codex", type: "oauth" }]
  })
  expect(await hasCodexImageAuth(runtime)).toBe(false)
})

it("honors cancellation before and after credential metadata reads", async () => {
  const runtime = await runtimeWith([["openai-codex", oauth]])
  const controller = new AbortController()
  const list = vi.spyOn(runtime, "listCredentials")
  controller.abort()
  await expect(hasCodexImageAuth(runtime, controller.signal)).rejects.toThrow()
  expect(list).not.toHaveBeenCalled()
  const next = new AbortController()
  list.mockImplementation(async () => {
    next.abort()
    return [{ providerId: "openai-codex", type: "oauth" }]
  })
  await expect(hasCodexImageAuth(runtime, next.signal)).rejects.toThrow()
})

it("tracks runtime API-key replacement and logout through public credential metadata", async () => {
  const runtime = await runtimeWith([["openai-codex", oauth]])
  expect(await hasCodexImageAuth(runtime)).toBe(true)
  await runtime.setRuntimeApiKey("openai-codex", "synthetic-key")
  expect(await hasCodexImageAuth(runtime)).toBe(false)
  await runtime.removeRuntimeApiKey("openai-codex")
  expect(await hasCodexImageAuth(runtime)).toBe(true)
  await runtime.logout("openai-codex")
  expect(await hasCodexImageAuth(runtime)).toBe(false)
})
