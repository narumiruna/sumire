import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

it("loads comparison fixtures with native Node before checking CLI arguments", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/capture-durable-comparison.ts", import.meta.url))],
    { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 },
  )
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(
    "Usage: node apps/admin/scripts/capture-durable-comparison.ts <base-ref> <output-directory>",
  )
})
