import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { createPiSessionFactory } from "../src/agent/pi-session-factory.js"
import { loadSettings } from "../src/config/settings.js"
import { createLogger } from "../src/logging.js"
import { startApplication } from "../src/startup.js"
import { createTelegramAgentBot } from "../src/telegram/bot.js"

vi.mock("../src/config/settings.js", { spy: true })
vi.mock("../src/logging.js", { spy: true })
vi.mock("../src/agent/pi-session-factory.js", { spy: true })
vi.mock("../src/telegram/bot.js", { spy: true })
afterEach(() => vi.restoreAllMocks())

it("stops before creating sessions or polling when administration storage is unavailable", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sumire-startup-access-"))
  const settings = loadSettings({ BOT_TOKEN: "fixture", BOT_ADMIN_ID: "7" }, root)
  writeFileSync(path.join(root, ".telegramagent"), "not a directory")
  vi.mocked(loadSettings).mockReturnValueOnce(settings)
  const shutdown = vi.fn(async () => {})
  vi.mocked(createLogger).mockReturnValueOnce({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    shutdown,
  })
  try {
    await expect(startApplication()).rejects.toThrow()
    expect(createPiSessionFactory).not.toHaveBeenCalled()
    expect(createTelegramAgentBot).not.toHaveBeenCalled()
    expect(shutdown).toHaveBeenCalledOnce()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
