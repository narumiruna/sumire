import assert from "node:assert/strict"
import { constants } from "node:fs"
import { access } from "node:fs/promises"
import { createRequire } from "node:module"
import { chromium } from "playwright"

const require = createRequire(import.meta.url)
const version = require("playwright/package.json").version
await access(chromium.executablePath(), constants.X_OK)
const sandbox = process.argv.includes("--sandbox")
const browser = await chromium.launch({
  headless: true,
  timeout: 30_000,
  ...(sandbox ? { executablePath: chromium.executablePath(), chromiumSandbox: true } : {}),
})
try {
  const page = await browser.newPage()
  await page.setContent("<title>Browser verification</title>")
  assert.equal(await page.title(), "Browser verification")
  console.log(
    `Playwright ${version}: full Chromium present; ${sandbox ? "sandbox-enabled full Chromium" : "headless shell"} launch passed; uid=${process.getuid()}`,
  )
} finally {
  await browser.close()
}
