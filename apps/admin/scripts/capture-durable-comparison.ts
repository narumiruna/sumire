import { execFileSync, spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { type Browser, chromium } from "@playwright/test"
import { durableFixture } from "../tests/durable-fixture.ts"

// Compare tracked base sources and working sources against the same synthetic API fixture.
// Run from the repository root after building workspace dependencies.
const [baseRef, output] = process.argv.slice(2)
if (!baseRef || !output)
  throw new Error(
    "Usage: node apps/admin/scripts/capture-durable-comparison.ts <base-ref> <output-directory>",
  )
const root = process.cwd()
const base = execFileSync(
  "git",
  ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`],
  { encoding: "utf8" },
).trim()
const temporary = await mkdtemp(path.join(os.tmpdir(), "sumire-durable-comparison-"))
let browser: Browser | undefined
try {
  browser = await chromium.launch({ headless: true })
  const archive = execFileSync("git", ["archive", base, "apps/admin"], {
    maxBuffer: 16 * 1024 * 1024,
  })
  execFileSync("tar", ["-x", "-C", temporary], { input: archive })
  await symlink(path.join(root, "node_modules"), path.join(temporary, "node_modules"), "dir")
  await mkdir(output, { recursive: true })
  for (const [phase, directory] of [
    ["before", temporary],
    ["after", root],
  ] as const) {
    const server = spawn(
      process.execPath,
      [
        path.join(root, "node_modules/vite/bin/vite.js"),
        "--host",
        "127.0.0.1",
        "--port",
        "17467",
        "--strictPort",
      ],
      { cwd: path.join(directory, "apps/admin"), stdio: ["ignore", "pipe", "pipe"] },
    )
    let logs = ""
    server.stdout.on("data", (data) => {
      logs = `${logs}${data}`.slice(-8192)
    })
    server.stderr.on("data", (data) => {
      logs = `${logs}${data}`.slice(-8192)
    })
    try {
      const deadline = Date.now() + 30_000
      for (;;) {
        if (server.exitCode !== null || Date.now() > deadline)
          throw new Error(`Screenshot server failed: ${logs}`)
        try {
          if ((await fetch("http://127.0.0.1:17467", { signal: AbortSignal.timeout(1000) })).ok)
            break
        } catch {
          /* Wait for Vite startup. */
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      for (const width of [1440, 390, 320]) {
        const page = await browser.newPage({
          baseURL: "http://127.0.0.1:17467",
          viewport: { width, height: 900 },
        })
        try {
          await durableFixture(page, "/?section=Durable&chat=42")
          const selected = page.getByRole("region", { name: "Selected item details", exact: true })
          await selected.waitFor()
          // Current layouts show this ID in the mobile navigator instead of repeating it here.
          await selected
            .getByText("conversation #7", { exact: true })
            .waitFor({ state: "attached" })
          await page.screenshot({
            path: path.join(output, `${phase}-${width}.png`),
            fullPage: true,
          })
        } finally {
          await page.close()
        }
      }
    } finally {
      if (server.exitCode === null) {
        const stopped = once(server, "exit")
        server.kill("SIGTERM")
        await stopped
      }
    }
  }
} finally {
  await browser?.close()
  await rm(temporary, { recursive: true, force: true })
}
