import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Harness } from "@earendil-works/pi-durable"
import { createPolymarketTools, publicPolymarketToolNames } from "@narumitw/sumire-pi-polymarket"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { McpAdmin } from "../src/admin/mcp.js"
import type { AdminStore } from "../src/admin/store.js"
import type { DurableSession } from "../src/agent/durable-session.js"
import { adaptTool, type NativeTool } from "../src/agent/durable-tools.js"
import { loadSettings } from "../src/config/settings.js"
import type { Logger } from "../src/logging.js"
import { createTestSessionFactory } from "./helpers/session-factory.js"

vi.mock("@narumitw/sumire-pi-polymarket", { spy: true })

const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const roots: string[] = []
const sessions: DurableSession[] = []
const stores: AdminStore[] = []
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url))

beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "fixture-key")
  vi.stubEnv("HF_TOKEN", "")
})
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.dispose()))
  for (const store of stores.splice(0)) store.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "sumire-polymarket-"))
  roots.push(root)
  await cp(path.join(repositoryRoot, "instructions"), path.join(root, "instructions"), {
    recursive: true,
  })
  await writeFile(path.join(root, "mcp.json"), JSON.stringify({ mcpServers: {} }))
  const settings = loadSettings({ BOT_ADMIN_ID: "7" }, root)
  const factory = await createTestSessionFactory(settings, logger)
  stores.push(factory.control)
  return { ...factory, settings }
}

function findTool(session: DurableSession, name: string) {
  const tool = session.nativeTools.find((item) => item.name === name)
  if (!tool) throw new Error(`Missing tool: ${name}`)
  return tool
}

async function call(tool: NativeTool, params: Record<string, unknown>) {
  const response = await tool.execute("fixture", params, undefined, undefined, undefined as never)
  const content = response.content[0]
  if (content?.type !== "text") throw new Error("Missing tool text result")
  return JSON.parse(content.text)
}

describe("bot Polymarket integration", () => {
  it.each([true, false])(
    "enables only first-seen Polymarket tools on upgrade (new: %s)",
    async (isNew) => {
      const factory = await setup()
      const store = factory.control
      const state = store.snapshot()
      state.policy.tools = state.policy.tools.filter(
        (name) => !publicPolymarketToolNames.includes(name),
      )
      state.policy.defaults.tools = [...state.policy.tools]
      const saved = store.save(state.policy, state.revision, "7")
      store.applied(saved.revision, true)
      if (isNew)
        for (const name of publicPolymarketToolNames)
          store.db.prepare("DELETE FROM known_tools WHERE name=?").run(name)
      const before = store.snapshot()
      const upgraded = await createTestSessionFactory(
        factory.settings,
        logger,
        undefined,
        factory.modelRuntime,
        { store, mcp: new McpAdmin(store, factory.settings.botWorkdir) },
      )
      if (isNew) {
        const after = store.snapshot()
        expect(after.policy.tools).toEqual(expect.arrayContaining([...publicPolymarketToolNames]))
        expect(after.policy.defaults.tools).toEqual(
          expect.arrayContaining([...publicPolymarketToolNames]),
        )
        expect(after.status).toBe("applied")
        expect(after.applied).toBe(after.revision)
      } else expect(store.snapshot()).toEqual(before)
      const session = await upgraded.create(7)
      sessions.push(session)
      for (const name of publicPolymarketToolNames) {
        expect(upgraded.toolNames).toContain(name)
        expect(store.allowsTool(7, name)).toBe(isNew)
        expect(session.getActiveToolNames().includes(name)).toBe(isNew)
        expect(session.nativeTools.some((tool) => tool.name === name)).toBe(isNew)
      }
    },
  )

  it("registers only public capabilities with normal policy guards and unsafe replay", async () => {
    const factory = await setup()
    expect(factory.toolNames).toEqual(expect.arrayContaining([...publicPolymarketToolNames]))
    const session = await factory.create(7)
    sessions.push(session)
    expect(session.getActiveToolNames()).toEqual(
      expect.arrayContaining([...publicPolymarketToolNames]),
    )
    expect(session.nativeTools.some((tool) => tool.name.endsWith("_execute"))).toBe(false)
    for (const name of publicPolymarketToolNames)
      expect(adaptTool(findTool(session, name)).replay).toBe("unsafe")
    const api = findTool(session, "polymarket_api")
    expect(await call(api, { method: "fetchOrderBook" })).toMatchObject([
      { tool: "polymarket_market_data_query" },
    ])
    expect(await call(api, { method: "placeLimitOrder" })).toEqual([])

    const state = factory.control.snapshot()
    state.policy.defaults.tools = (state.policy.defaults.tools ?? state.policy.tools).filter(
      (name) => name !== "polymarket_api",
    )
    const saved = factory.control.save(state.policy, state.revision, "7")
    factory.control.applied(saved.revision, true)
    expect(() => api.execute("revoked", {}, undefined, undefined, undefined as never)).toThrow(
      "not allowed",
    )
    const restricted = await factory.create(8)
    sessions.push(restricted)
    expect(restricted.getActiveToolNames()).not.toContain("polymarket_api")
  })

  it("isolates lazy pagination handles per chat and disposes each runtime", async () => {
    const factory = await setup()
    const first = await factory.create(7)
    const firstRuntime = vi.mocked(createPolymarketTools).mock.results.at(-1)?.value
    const second = await factory.create(8)
    const secondRuntime = vi.mocked(createPolymarketTools).mock.results.at(-1)?.value
    sessions.push(first, second)
    expect(firstRuntime).not.toBe(secondRuntime)
    const firstDispose = vi.spyOn(firstRuntime, "dispose")
    const secondDispose = vi.spyOn(secondRuntime, "dispose")
    const handle = await call(findTool(first, "polymarket_discovery_query"), {
      action: "listMarkets",
      args: [{ pageSize: 1 }],
    })
    expect(handle.methods).toEqual(expect.arrayContaining(["firstPage", "from"]))
    await expect(
      call(findTool(second, "polymarket_handle"), { operation: "close", handle: handle.handle }),
    ).rejects.toThrow("expired")
    expect(
      await call(findTool(first, "polymarket_handle"), {
        operation: "close",
        handle: handle.handle,
      }),
    ).toEqual({ closed: true })
    await first.dispose()
    await second.dispose()
    expect(firstDispose).toHaveBeenCalledOnce()
    expect(secondDispose).toHaveBeenCalledOnce()
  })

  it("disposes the client runtime if durable startup fails", async () => {
    const factory = await setup()
    const actual = await vi.importActual<typeof import("@narumitw/sumire-pi-polymarket")>(
      "@narumitw/sumire-pi-polymarket",
    )
    const runtime = actual.createPolymarketTools()
    const dispose = vi.spyOn(runtime, "dispose")
    vi.mocked(createPolymarketTools).mockReturnValueOnce(runtime)
    vi.spyOn(Harness, "open").mockRejectedValueOnce(new Error("fixture startup failure"))
    await expect(factory.create(7)).rejects.toThrow("fixture startup failure")
    expect(dispose).toHaveBeenCalledOnce()
  })

  it("copies the package manifest and compiled JSON catalogs into the production image", async () => {
    const dockerfile = await readFile(path.join(repositoryRoot, "Dockerfile"), "utf8")
    expect(dockerfile).toContain(
      "COPY packages/pi-polymarket/package.json packages/pi-polymarket/package.json",
    )
    expect(dockerfile).toContain("FROM dependencies AS polymarket-build")
    expect(dockerfile).toContain("COPY packages/pi-polymarket/src/ packages/pi-polymarket/src/")
    expect(dockerfile).toContain(
      "COPY --from=polymarket-build /build/packages/pi-polymarket/dist /build/packages/pi-polymarket/dist",
    )
    expect(dockerfile).toContain(
      "COPY --from=polymarket-build --chown=app:app /build/packages/pi-polymarket/dist /app/packages/pi-polymarket/dist",
    )
    expect(dockerfile).toContain(
      "/build/packages/pi-polymarket/package.json /app/packages/pi-polymarket/package.json",
    )
  })
})
