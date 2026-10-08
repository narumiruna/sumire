import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import { constants, readFileSync } from "node:fs"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { loadMcpConfig } from "../src/agent/mcp-config.js"

const { access, executablePath, launch, spawn, killChild } = vi.hoisted(() => ({
  access: vi.fn(),
  executablePath: vi.fn(),
  launch: vi.fn(),
  spawn: vi.fn(),
  killChild: vi.fn(),
}))
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  access,
}))
vi.mock("playwright", () => ({ chromium: { executablePath, launch } }))
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn,
}))

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  executablePath.mockReturnValue("/locked browser/chrome")
  access.mockResolvedValue(undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
})
const launcher = () => import(new URL("../scripts/chrome-devtools.mjs", import.meta.url).href)

it("resolves the locked browser using Playwright, preserving spaced paths as one argument", async () => {
  const { chromeArgs } = await launcher()
  expect(await chromeArgs()).toEqual([
    "-y",
    "chrome-devtools-mcp@latest",
    "--headless",
    "--isolated",
    "--executablePath",
    "/locked browser/chrome",
    "--no-page-id-routing",
    "--no-usage-statistics",
    "--no-performance-crux",
  ])
  expect(access).toHaveBeenCalledWith("/locked browser/chrome", constants.X_OK)
})

it.each(["ENOENT", "EACCES"])(
  "fails closed before spawn when the browser check fails: %s",
  async (code) => {
    const error = Object.assign(new Error("browser unavailable"), { code })
    access.mockRejectedValue(error)
    const { launchChromeMcp } = await launcher()
    await expect(launchChromeMcp()).rejects.toBe(error)
    expect(spawn).not.toHaveBeenCalled()
  },
)

it("inherits protocol stdio and process group, forwards termination, and propagates exit status", async () => {
  const child = Object.assign(new EventEmitter(), { kill: killChild })
  spawn.mockReturnValue(child)
  const previous = process.listenerCount("SIGTERM")
  const { launchChromeMcp } = await launcher()
  await launchChromeMcp()
  expect(spawn).toHaveBeenCalledWith("npx", expect.any(Array), { stdio: "inherit" })
  const listener = process.listeners("SIGTERM").at(-1)
  expect(listener).toBeDefined()
  listener?.("SIGTERM")
  expect(killChild).toHaveBeenCalledWith("SIGTERM")
  child.emit("exit", 7, null)
  expect(process.exitCode).toBe(7)
  expect(process.listenerCount("SIGTERM")).toBe(previous)
})

it("removes signal handlers and reports a bounded diagnostic on spawn failure", async () => {
  const child = Object.assign(new EventEmitter(), { kill: killChild })
  spawn.mockReturnValue(child)
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {})
  const previous = process.listenerCount("SIGINT")
  const { launchChromeMcp } = await launcher()
  await launchChromeMcp()
  child.emit("error", new Error("private upstream detail"))
  expect(diagnostic).toHaveBeenCalledWith("Chrome MCP subprocess could not start")
  expect(process.exitCode).toBe(1)
  expect(process.listenerCount("SIGINT")).toBe(previous)
})

it("propagates child signal exits without leaving signal handlers", async () => {
  const child = Object.assign(new EventEmitter(), { kill: killChild })
  spawn.mockReturnValue(child)
  const kill = vi.spyOn(process, "kill").mockReturnValue(true)
  const previous = process.listenerCount("SIGTERM")
  const { launchChromeMcp } = await launcher()
  await launchChromeMcp()
  child.emit("exit", null, "SIGTERM")
  expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM")
  expect(process.listenerCount("SIGTERM")).toBe(previous)
})

it("closes the offline verification browser after page verification fails", async () => {
  const error = new Error("page failed")
  const close = vi.fn().mockResolvedValue(undefined)
  launch.mockResolvedValue({
    newPage: vi.fn().mockResolvedValue({ setContent: vi.fn().mockRejectedValue(error) }),
    close,
  })
  await expect(import(new URL("../scripts/check-browser.mjs", import.meta.url).href)).rejects.toBe(
    error,
  )
  expect(launch).toHaveBeenCalledWith({ headless: true, timeout: 30_000 })
  expect(close).toHaveBeenCalledOnce()
})

it("verifies full Chromium with its sandbox explicitly enabled when requested", async () => {
  const close = vi.fn().mockResolvedValue(undefined)
  launch.mockResolvedValue({
    newPage: vi.fn().mockResolvedValue({
      setContent: vi.fn().mockResolvedValue(undefined),
      title: vi.fn().mockResolvedValue("Browser verification"),
    }),
    close,
  })
  vi.spyOn(console, "log").mockImplementation(() => {})
  const argv = process.argv
  process.argv = [...argv, "--sandbox"]
  try {
    await import(new URL("../scripts/check-browser.mjs", import.meta.url).href)
  } finally {
    process.argv = argv
  }
  expect(launch).toHaveBeenCalledWith({
    headless: true,
    timeout: 30_000,
    executablePath: "/locked browser/chrome",
    chromiumSandbox: true,
  })
  expect(close).toHaveBeenCalledOnce()
})

it("selects the pinned official Playwright policy without privileged mode or added capabilities", () => {
  const root = new URL("../../../", import.meta.url)
  const profile = JSON.parse(
    readFileSync(new URL("apps/bot/resources/chromium/seccomp-profile.json", root), "utf8"),
  )
  expect(createHash("sha256").update(JSON.stringify(profile)).digest("hex")).toBe(
    "8e3abd795acf8d96f90d4f2103f2b9665c21ab645df244d4eedcc5c95ceac3a2",
  )
  expect(profile.defaultAction).toBe("SCMP_ACT_ERRNO")
  expect(profile.syscalls[0]).toMatchObject({
    names: ["clone", "setns", "unshare"],
    action: "SCMP_ACT_ALLOW",
  })
  const compose = readFileSync(new URL("compose.yaml", root), "utf8")
  expect(compose).toContain("seccomp=./apps/bot/resources/chromium/seccomp-profile.json")
  expect(compose).not.toMatch(/privileged:|cap_add:|seccomp=unconfined/)
})

it("rejects unexpected launcher arguments without writing protocol stdout", () => {
  const result = spawnSync(
    process.execPath,
    [new URL("../scripts/chrome-devtools.mjs", import.meta.url).pathname, "--no-sandbox"],
    { encoding: "utf8", timeout: 5_000 },
  )
  expect(result.status).toBe(1)
  expect(result.stdout).toBe("")
  expect(result.stderr).toContain("Chrome MCP launcher failed")
})

it("keeps desktop config unchanged and explicitly selects the Docker launcher in Compose", async () => {
  const root = new URL("../../../", import.meta.url)
  const read = (file: string) => readFileSync(new URL(file, root), "utf8")
  const desktop = JSON.parse(read("mcp.json"))
  const docker = JSON.parse(read("mcp.docker.json"))
  expect(desktop.mcpServers["chrome-devtools"]).toEqual({
    command: "npx",
    args: ["-y", "chrome-devtools-mcp@latest"],
  })
  expect(docker.mcpServers.firecrawl).toEqual(desktop.mcpServers.firecrawl)
  expect(read("compose.yaml")).toContain("./mcp.docker.json:/app/mcp.json:ro")
  const config = await loadMcpConfig(
    { botMcpConfigPath: new URL("mcp.docker.json", root).pathname },
    { warn: vi.fn() },
    { FIRECRAWL_API_KEY: "test-only-key" },
  )
  expect(config.servers[0]).toMatchObject({
    command: "node",
    args: ["/app/apps/bot/scripts/chrome-devtools.mjs"],
    env: { PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright" },
  })
  expect(config.servers[1]?.headers).toEqual({ Authorization: "Bearer test-only-key" })
})

it("uses the same npm-ci Playwright CLI for Docker browser and OS dependency installation", () => {
  const dockerfile = readFileSync(new URL("../../../Dockerfile", import.meta.url), "utf8")
  const bot = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  const content = JSON.parse(
    readFileSync(new URL("../../../packages/url-content/package.json", import.meta.url), "utf8"),
  )
  const lock = JSON.parse(
    readFileSync(new URL("../../../package-lock.json", import.meta.url), "utf8"),
  )
  expect(bot.dependencies.playwright).toBe(content.dependencies.playwright)
  expect(lock.packages["node_modules/playwright"].version).toBe(bot.dependencies.playwright)
  expect(dockerfile).not.toContain("PLAYWRIGHT_VERSION")
  expect(dockerfile).toContain("FROM dependencies AS browser-download")
  expect(dockerfile).toContain("node node_modules/playwright/cli.js install chromium")
  expect(dockerfile).toContain(
    "from=dependencies,source=/build/node_modules,target=/build/node_modules",
  )
  expect(dockerfile).toContain("node /build/node_modules/playwright/cli.js install-deps chromium")
  expect(dockerfile).toContain("RUN --network=none node /app/apps/bot/scripts/check-browser.mjs")
})

it("does not patch browser arguments or resolve revisions in the MCP smoke", () => {
  const smoke = readFileSync(new URL("../scripts/check-mcp.mjs", import.meta.url), "utf8")
  expect(smoke).not.toContain("--executablePath")
  expect(smoke).not.toContain("readdir")
  expect(smoke).toContain("mcp__chrome_devtools__list_pages")
})

it("fails as an executable with a missing browser without starting npx", () => {
  const result = spawnSync(
    process.execPath,
    [new URL("../scripts/chrome-devtools.mjs", import.meta.url).pathname],
    {
      env: { PATH: "/nonexistent", PLAYWRIGHT_BROWSERS_PATH: "/nonexistent-browser-installation" },
      encoding: "utf8",
      timeout: 5_000,
    },
  )
  expect(result.status).toBe(1)
  expect(result.stdout).toBe("")
  expect(result.stderr).toContain("verify the locked Playwright browser installation")
  expect(result.stderr).not.toContain("ENOENT")
})
