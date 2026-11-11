import { HttpError } from "grammy"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { startApplication } from "../src/startup.js"

vi.mock("../src/startup.js", () => ({ startApplication: vi.fn() }))

const originalExitCode = process.exitCode

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  process.exitCode = originalExitCode
  vi.restoreAllMocks()
})

describe("application entrypoint", () => {
  it("sets a failing exit code without logging a second startup exception", async () => {
    const token = "123456:fake-test-token"
    vi.mocked(startApplication).mockRejectedValueOnce(
      new HttpError(
        "Network request failed",
        new Error(`request to https://api.telegram.org/bot${token}/getUpdates failed`),
      ),
    )
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

    await import("../src/index.js")

    expect(process.exitCode).toBe(1)
    expect(stderr).not.toHaveBeenCalled()
  })

  it("preserves the exit code on a clean shutdown", async () => {
    vi.mocked(startApplication).mockResolvedValueOnce(undefined)
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

    await import("../src/index.js")

    expect(process.exitCode).toBe(originalExitCode)
    expect(stderr).not.toHaveBeenCalled()
  })
})
