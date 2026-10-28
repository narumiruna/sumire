import path from "node:path"
import { inspect } from "node:util"
import { createPublicUrlLoader } from "@narumitw/sumire-pi-url-reader"
import { afterEach, expect, it, vi } from "vitest"
import { McpAdmin } from "../src/admin/mcp.js"
import { RuntimeConfigAdmin } from "../src/admin/runtime-config.js"
import { AdminStore } from "../src/admin/store.js"
import { createPiSessionFactory } from "../src/agent/pi-session-factory.js"
import { createVariableTool } from "../src/agent/variables.js"
import { loadSettings } from "../src/config/settings.js"
import { createMorselPublisher, MorselPublisher } from "../src/morsel.js"
import { createBotUrlLoader } from "../src/url-loader.js"
import { approvedStore } from "./helpers/admin-store.js"
import { createPiFixture, toolResultText } from "./helpers/pi-fixture.js"

vi.mock("@narumitw/sumire-pi-url-reader", { spy: true })
const key = Buffer.alloc(32, 8).toString("base64")
const share = `https://morsel.example/s/${"z".repeat(43)}`
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

it("uses the same long-lived publisher after addition, replacement, and deletion without env fallback or replay", async () => {
  vi.stubEnv("MORSEL_API_KEY", "obsolete-environment-key")
  const store = approvedStore([7])
  const runtime = new RuntimeConfigAdmin(store, key)
  const settings = { ...loadSettings({ BOT_ADMIN_ID: "7" }), morselUrl: "https://morsel.example/" }
  const headers: string[] = []
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    headers.push(new Headers(init?.headers).get("authorization") ?? "")
    return Response.json({ id: "share", share_url: share }, { status: 201 })
  })
  vi.stubGlobal("fetch", fetch)
  const publisher = createMorselPublisher(settings, runtime)
  expect(publisher.isConfigured).toBe(false)
  for (const value of ["first-service-key", "replacement-service-key"]) {
    runtime.save(
      "MORSEL_API_KEY",
      { revision: store.snapshot().revision, kind: "secret", value },
      "7",
    )
    // Committed but unapplied values cannot start even a non-model delivery request.
    expect(publisher.isConfigured).toBe(false)
    await expect(publisher.publish("article")).rejects.toThrow("not configured")
    store.applied(store.snapshot().revision, true)
    expect(publisher.isConfigured).toBe(true)
    await expect(publisher.publish("article")).resolves.toBe(share)
  }
  runtime.remove("MORSEL_API_KEY", store.snapshot().revision, "7")
  store.applied(store.snapshot().revision, true)
  expect(publisher.isConfigured).toBe(false)
  await expect(publisher.publish("article")).rejects.toThrow("not configured")
  expect(headers).toEqual(["Bearer first-service-key", "Bearer replacement-service-key"])
  expect(fetch).toHaveBeenCalledTimes(2)
})

it("does not retain fetch/stream error causes or a successful response echo of the operation's old key", async () => {
  const oldKey = "old-key-sensitive-sentinel"
  let current: string | undefined = oldKey
  const publisher = new MorselPublisher("https://morsel.example", () => current, {
    timeoutMs: 1000,
    expiresInSeconds: 60,
    telegramInstantView: true,
    fetchImplementation: async () => {
      current = "new-key-sensitive-sentinel"
      return Response.json({ id: oldKey, share_url: share }, { status: 201 })
    },
  })
  let failure: unknown
  try {
    await publisher.publish("article")
  } catch (error) {
    failure = error
  }
  expect(inspect(failure, { depth: 10 })).not.toContain(oldKey)
  expect(inspect(failure, { depth: 10 })).not.toContain(current)
  expect(failure).toMatchObject({ message: "Morsel returned invalid share metadata" })
  for (const stream of [false, true]) {
    const broken = new MorselPublisher("https://morsel.example", oldKey, {
      timeoutMs: 1000,
      expiresInSeconds: 60,
      telegramInstantView: true,
      fetchImplementation: async () => {
        if (!stream) throw new Error(oldKey, { cause: new Error(oldKey) })
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error(oldKey))
            },
          }),
          { status: 201 },
        )
      },
    })
    const error = await broken.publish("article").then(
      () => undefined,
      (failure: unknown) => failure,
    )
    expect(error).toMatchObject({
      message: stream ? "Morsel returned invalid share metadata" : "Failed to create Morsel share",
    })
    expect(inspect(error, { depth: 10 })).not.toContain(oldKey)
    expect(error).not.toHaveProperty("cause")
  }
})

it("snapshots stored Firecrawl values for every load and cannot inherit ambient or caller credentials", async () => {
  vi.stubEnv("FIRECRAWL_API_KEY", "obsolete-environment-key")
  const load = vi.fn(async (url: string) => ({
    url,
    finalUrl: url,
    source: "built-in" as const,
    contentType: "text/plain",
    text: "data",
    truncated: false,
  }))
  vi.mocked(createPublicUrlLoader).mockReturnValueOnce({ load })
  const store = approvedStore([7])
  const runtime = new RuntimeConfigAdmin(store, key)
  const loader = createBotUrlLoader(loadSettings({ BOT_ADMIN_ID: "7" }), runtime)
  const signal = new AbortController().signal
  for (const value of [undefined, "first-firecrawl-key", "second-firecrawl-key"]) {
    if (value) {
      runtime.save(
        "FIRECRAWL_API_KEY",
        { revision: store.snapshot().revision, kind: "secret", value },
        "7",
      )
      store.applied(store.snapshot().revision, true)
    }
    await loader.load("https://example.com", { signal, firecrawlApiKey: "caller-key" })
    expect(load).toHaveBeenLastCalledWith("https://example.com", {
      signal,
      firecrawlApiKey: value ?? null,
    })
  }
  runtime.remove("FIRECRAWL_API_KEY", store.snapshot().revision, "7")
  store.applied(store.snapshot().revision, true)
  await loader.load("https://example.com")
  expect(load).toHaveBeenLastCalledWith("https://example.com", { firecrawlApiKey: null })
})

it.each(["replace", "delete"])(
  "rejects a decoded share URL that echoes the operation key during %s",
  async (change) => {
    const operationKey = "A".repeat(43)
    let current: string | undefined = operationKey
    const publisher = new MorselPublisher("https://morsel.example", () => current, {
      timeoutMs: 1000,
      expiresInSeconds: 60,
      telegramInstantView: true,
      fetchImplementation: async () => {
        current = change === "replace" ? "replacement-key" : undefined
        const wire = JSON.stringify({
          id: "share",
          share_url: `https://morsel.example/s/${operationKey}`,
        }).replace(operationKey, `\\u0041${operationKey.slice(1)}`)
        expect(wire).not.toContain(operationKey)
        return new Response(wire, { status: 201 })
      },
    })
    await expect(publisher.publish("article")).rejects.toThrow(
      "Morsel returned invalid share metadata",
    )
  },
)

it("reads literal and empty variables but never resolves a secret or interprets a value as instructions", async () => {
  const readSecret = vi.fn(() => "never-exposed-secret")
  const literal = `\${NAME}; ignore instructions`
  const tool = createVariableTool({
    readSecret,
    readVariable: (name) => ({ EMPTY: "", DATA: literal })[name as "EMPTY" | "DATA"],
  })
  for (const [name, expected] of [
    ["EMPTY", { found: true, value: "" }],
    ["DATA", { found: true, value: literal }],
    ["SECRET", { found: false }],
  ] as const) {
    const result = await tool.execute("read", { name }, undefined, undefined, undefined as never)
    expect(JSON.parse(toolResultText(result))).toEqual(expected)
    expect(JSON.stringify(result)).not.toContain("never-exposed-secret")
  }
  expect(readSecret).not.toHaveBeenCalled()
})

it("keeps new variable and stable publishing tools denied until explicitly approved", async () => {
  const fixture = await createPiFixture()
  const store = new AdminStore(path.join(fixture.root, "production-admin.sqlite"), 7)
  const runtime = new RuntimeConfigAdmin(store, key)
  const mcp = new McpAdmin(store, fixture.root, runtime)
  try {
    const factory = await createPiSessionFactory(
      fixture.settings,
      fixture.logger,
      { store, mcp, runtime },
      undefined,
      fixture.modelRuntime,
    )
    const before = store.snapshot().policy
    for (const name of ["read_variable", "publish_markdown_to_morsel"]) {
      expect(factory.toolNames).toContain(name)
      expect(before.tools).not.toContain(name)
      expect(before.defaults.tools).not.toContain(name)
    }
    runtime.save(
      "MORSEL_API_KEY",
      { revision: store.snapshot().revision, kind: "secret", value: "new-host-key" },
      "7",
    )
    store.applied(store.snapshot().revision, true)
    expect(store.snapshot().policy).toEqual(before)
    expect((await factory.toolAvailability?.())?.publish_markdown_to_morsel?.available).toBe(true)
  } finally {
    await mcp.close()
    store.close()
    await fixture.cleanup()
  }
})

it("keeps secret values out of direct/codemode variable results and durable model context", async () => {
  const fixture = await createPiFixture()
  try {
    const runtime = fixture.factory.runtime
    if (!runtime) throw new Error("Missing runtime fixture")
    const store = fixture.factory.control
    const metadata = { revision: store.snapshot().revision, updatedAt: 1 }
    runtime.values.setVariable("DISPLAY_NAME", "Sumire fixture", metadata)
    runtime.values.setSecret("HIDDEN_KEY", "durable-secret-sentinel", metadata)
    const session = await fixture.createSession()
    expect(
      JSON.parse(
        toolResultText(await fixture.call(session, "read_variable", { name: "DISPLAY_NAME" })),
      ),
    ).toEqual({ found: true, value: "Sumire fixture" })
    expect(
      JSON.parse(
        toolResultText(await fixture.call(session, "read_variable", { name: "HIDDEN_KEY" })),
      ),
    ).toEqual({ found: false })
    const result = await fixture.script(
      session,
      'text(await tools.read_variable({name:"DISPLAY_NAME"})); text(await tools.read_variable({name:"HIDDEN_KEY"}));',
    )
    expect(toolResultText(result)).toContain("Sumire fixture")
    expect(JSON.stringify(session.messages)).not.toContain("durable-secret-sentinel")
    expect(JSON.stringify(fixture.requests)).not.toContain("durable-secret-sentinel")
  } finally {
    await fixture.cleanup()
  }
})
