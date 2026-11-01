import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { expect, it } from "vitest"

const execute = promisify(execFile)
it("uses the installed client with pinned connections and closes every dispatcher", async () => {
  const result = await execute(
    process.execPath,
    [
      ...(process.versions.bun ? ["--no-env-file"] : []),
      fileURLToPath(new URL("../scripts/check-runtime.mjs", import.meta.url)),
    ],
    { env: { PATH: process.env.PATH }, timeout: 5000 },
  )
  expect(result.stdout).toContain("connection pinning, redirects, extraction, and cleanup passed")
  expect(result.stderr).toBe("")
})
