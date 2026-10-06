import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"

import { beforeEach, expect, it, vi } from "vitest"

const { impersonate, cleanup } = vi.hoisted(() => ({
  impersonate: vi.fn(),
  cleanup: vi.fn(),
}))

vi.mock("impers", () => ({
  Curl: class {
    impersonate = impersonate
    cleanup = cleanup
  },
  NATIVE_IMPERSONATE_TARGETS: [
    { browser: "Chrome", target_name: "chrome131" },
    { browser: "Firefox", target_name: "firefox147" },
    { browser: "Chrome", target_name: "chrome150" },
  ],
}))

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
})

function runCheck(): Promise<unknown> {
  return import(new URL("../scripts/check-curl-impersonate.mjs", import.meta.url).href)
}

it("checks every built-in Chrome fingerprint and releases the native handle", async () => {
  await runCheck()

  expect(impersonate.mock.calls).toEqual([["chrome131"], ["chrome150"]])
  expect(cleanup).toHaveBeenCalledOnce()
})

it("preserves a fingerprint failure and releases the native handle", async () => {
  const error = new Error("Unsupported Chrome fingerprint")
  impersonate.mockImplementationOnce(() => {
    throw error
  })

  await expect(runCheck()).rejects.toBe(error)

  expect(impersonate).toHaveBeenCalledOnce()
  expect(cleanup).toHaveBeenCalledOnce()
})

it.skipIf(process.platform === "win32")(
  "rejects unsupported image architectures before downloading an archive",
  () => {
    const dockerfile = readFileSync(new URL("../../../Dockerfile", import.meta.url), "utf8")
    const script = /^RUN (set -eu;[\s\S]*?)\n\n/mu.exec(dockerfile)?.[1]
    if (!script) throw new Error("Missing curl-impersonate archive installation step")

    const result = spawnSync("/bin/sh", ["-c", script], {
      env: { TARGETARCH: "unsupported", PATH: "/nonexistent" },
      encoding: "utf8",
      timeout: 5_000,
    })

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("Unsupported curl-impersonate architecture: unsupported")
  },
)
