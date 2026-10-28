import { afterEach, expect, it, vi } from "vitest"

const f = vi.hoisted(() => ({
  events: [] as string[],
  modelRuntime: {},
  closeFailure: false,
  close: vi.fn(async () => {
    f.events.push("github-close")
    if (f.closeFailure) throw new Error("fixture close failure")
  }),
}))
vi.mock("../src/config/settings.js", () => ({
  loadSettings: () => ({
    botToken: "fixture-token",
    projectRoot: "/fixture",
    botSessionLogDir: "/fixture/sessions",
  }),
}))
vi.mock("../src/logging.js", () => ({
  createLogger: () => ({
    info() {},
    warn() {},
    shutdown() {
      f.events.push("logger-close")
    },
  }),
}))
vi.mock("../src/admin/store.js", () => ({
  AdminStore: class {
    close() {
      f.events.push("store-close")
    }
  },
}))
vi.mock("../src/admin/runtime-config.js", () => ({
  RuntimeConfigAdmin: class {
    importLegacy() {}
  },
}))
vi.mock("../src/admin/mcp.js", () => ({
  McpAdmin: class {
    async import() {}
    close() {
      f.events.push("mcp-close")
    }
  },
}))
vi.mock("../src/agent/pi-session-factory.js", () => ({
  createPiSessionFactory: async () => {
    f.events.push("factory")
    return { modelRuntime: f.modelRuntime }
  },
}))
vi.mock("../src/agent/session-registry.js", () => ({
  asSessionCreator: () => ({}),
  ChatSessionRegistry: class {
    dispose() {
      f.events.push("sessions-close")
    }
  },
}))
vi.mock("../src/telegram/channel-images.js", () => ({ ChannelImageIndex: class {} }))
vi.mock("../src/admin/application.js", () => ({
  startAdmin: async () => {
    f.events.push("admin-applied")
    return {
      stop() {
        f.events.push("admin-close")
      },
    }
  },
}))
vi.mock("../src/github/runtime.js", () => ({
  startGithubMentionWorker: vi.fn((_settings, _logger, _control, runtime) => {
    expect(runtime).toBe(f.modelRuntime)
    f.events.push("github-start")
    return { close: f.close }
  }),
}))
vi.mock("../src/telegram/bot.js", () => ({
  createTelegramAgentBot: () => ({
    async start() {
      f.events.push("telegram-start")
      throw new Error("fixture transport failure")
    },
    async stop() {
      f.events.push("telegram-close")
    },
  }),
}))

import { startApplication } from "../src/startup.js"

afterEach(() => {
  f.events.length = 0
  f.closeFailure = false
  f.close.mockClear()
})

it("starts GitHub after applied provider setup and closes it before sessions and the admin store", async () => {
  await expect(startApplication()).rejects.toThrow("fixture transport failure")
  expect(f.events.slice(0, 4)).toEqual([
    "factory",
    "admin-applied",
    "github-start",
    "telegram-start",
  ])
  expect(f.events.indexOf("github-close")).toBeLessThan(f.events.indexOf("sessions-close"))
  expect(f.events.lastIndexOf("github-close")).toBeLessThan(f.events.indexOf("store-close"))
  expect(f.events.at(-1)).toBe("logger-close")
})

it("closes transport, sessions, and stores even if the GitHub worker close fails", async () => {
  f.closeFailure = true
  await expect(startApplication()).rejects.toThrow("Application cleanup failed")
  expect(f.events).toContain("telegram-close")
  expect(f.events).toContain("sessions-close")
  expect(f.events).toContain("mcp-close")
  expect(f.events).toContain("store-close")
})
