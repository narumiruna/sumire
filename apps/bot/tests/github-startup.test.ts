import { afterEach, expect, it, vi } from "vitest"

const f = vi.hoisted(() => ({
  events: [] as string[],
  modelRuntime: {},
  closeFailure: false,
  authCloseFailure: false,
  factoryFailure: false,
  transportFailure: true,
  error: vi.fn((_message: string, _details?: unknown) => {}),
  githubAuth: {
    close: vi.fn(async () => {
      f.events.push("github-auth-close")
      if (f.authCloseFailure) throw new Error("fixture auth close failure")
    }),
  },
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
    error: f.error,
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
vi.mock("../src/admin/github-auth.js", () => ({
  GitHubAuth: class {
    close = f.githubAuth.close
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
  createPiSessionFactory: async (_settings: unknown, _logger: unknown, control: unknown) => {
    expect(control).toHaveProperty("github.close", f.githubAuth.close)
    f.events.push("factory")
    if (f.factoryFailure) throw new Error("fixture factory failure")
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
  startAdmin: async (_settings: unknown, control: unknown) => {
    expect(control).toHaveProperty("github.close", f.githubAuth.close)
    f.events.push("admin-applied")
    return {
      stop() {
        f.events.push("admin-close")
      },
    }
  },
}))
vi.mock("../src/github/runtime.js", () => ({
  startGithubMentionWorker: vi.fn((_settings, _logger, control, runtime) => {
    expect(control).toHaveProperty("github.close", f.githubAuth.close)
    expect(runtime).toBe(f.modelRuntime)
    f.events.push("github-start")
    return { close: f.close }
  }),
}))
vi.mock("../src/telegram/bot.js", () => ({
  createTelegramAgentBot: () => ({
    async start() {
      f.events.push("telegram-start")
      if (f.transportFailure) throw new Error("fixture transport failure")
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
  f.authCloseFailure = false
  f.factoryFailure = false
  f.transportFailure = true
  f.error.mockClear()
  f.close.mockClear()
  f.githubAuth.close.mockClear()
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
  expect(f.events.lastIndexOf("github-close")).toBeLessThan(f.events.indexOf("github-auth-close"))
  expect(f.events.lastIndexOf("sessions-close")).toBeLessThan(f.events.indexOf("github-auth-close"))
  expect(f.events.slice(-4)).toEqual([
    "github-auth-close",
    "mcp-close",
    "store-close",
    "logger-close",
  ])
  expect(f.githubAuth.close).toHaveBeenCalledOnce()
})

it("closes transport, sessions, and stores even if the GitHub worker close fails", async () => {
  f.transportFailure = false
  f.closeFailure = true
  await expect(startApplication()).rejects.toThrow("Application cleanup failed")
  expect(f.events).toContain("telegram-close")
  expect(f.events).toContain("sessions-close")
  expect(f.events).toContain("github-auth-close")
  expect(f.events).toContain("mcp-close")
  expect(f.events).toContain("store-close")
  expect(f.close).toHaveBeenCalledOnce()
  expect(f.error).toHaveBeenCalledWith("Application resource cleanup failed", {
    "event.name": "application.resource.failed",
    "application.resource": "github_worker",
    error: expect.any(Error),
  })
})

it("preserves the transport failure when GitHub cleanup also fails", async () => {
  f.closeFailure = true
  await expect(startApplication()).rejects.toThrow("fixture transport failure")
  expect(f.error).toHaveBeenNthCalledWith(1, "Application failed", {
    "event.name": "application.failed",
    error: expect.objectContaining({ message: "fixture transport failure" }),
  })
  expect(f.error).toHaveBeenCalledWith("Application cleanup failed", {
    "event.name": "application.cleanup.failed",
    error: expect.any(AggregateError),
  })
  expect(f.events.at(-1)).toBe("logger-close")
  expect(f.close).toHaveBeenCalledOnce()
})

it("closes GitHub authentication when startup fails before the mention worker starts", async () => {
  f.factoryFailure = true
  await expect(startApplication()).rejects.toThrow("fixture factory failure")
  expect(f.events).toEqual([
    "factory",
    "github-auth-close",
    "mcp-close",
    "store-close",
    "logger-close",
  ])
  expect(f.close).not.toHaveBeenCalled()
  expect(f.githubAuth.close).toHaveBeenCalledOnce()
})

it("closes stores and logging even if GitHub authentication close fails", async () => {
  f.transportFailure = false
  f.authCloseFailure = true
  await expect(startApplication()).rejects.toThrow("Application cleanup failed")
  expect(f.events.slice(-4)).toEqual([
    "github-auth-close",
    "mcp-close",
    "store-close",
    "logger-close",
  ])
})
