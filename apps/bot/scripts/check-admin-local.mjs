import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { chromium } from "playwright"
import { createPasskeySetup } from "../dist/admin/auth.js"
import { McpAdmin } from "../dist/admin/mcp.js"
import { ProviderAdmin } from "../dist/admin/providers.js"
import { createAdminServer } from "../dist/admin/server.js"
import { AdminStore } from "../dist/admin/store.js"
import { loadSettings } from "../dist/config/settings.js"

// Use a real local HTTP server and browser. No Telegram or provider requests are made.
const directory = await mkdtemp(path.join(os.tmpdir(), "sumire-admin-local-"))
let store
let admin
let browser
try {
  const config = loadSettings(
    { BOT_ADMIN_ID: "42" },
    path.resolve(import.meta.dirname, "../../.."),
  ).admin
  assert.equal(config.origin, "http://localhost:17465")
  config.port = 0
  store = new AdminStore(path.join(directory, "admin.sqlite"), new Set(), 42)
  store.applied(1, true)
  const runtime = { getProviders: () => [], getModels: () => [] }
  admin = createAdminServer(config, {
    store,
    mcp: new McpAdmin(store, directory),
    providers: new ProviderAdmin(runtime, store),
    tools: () => [],
    apply: async () => store.applied(store.snapshot().revision, true),
  })
  await admin.start()
  config.origin = `http://localhost:${admin.server.address().port}`
  const setup = createPasskeySetup(store, config.origin)
  assert.ok(setup)
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  const page = await context.newPage()
  const client = await context.newCDPSession(page)
  await client.send("WebAuthn.enable")
  await client.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  await page.goto(setup)
  await page.getByRole("button", { name: "Register passkey" }).click()
  await page.getByRole("button", { name: "Sign out" }).waitFor()
  const session = (await context.cookies()).find((item) => item.name === "__Host-sumire-session")
  assert.ok(session)
  assert.equal(session.secure, true)
  assert.equal(session.httpOnly, true)
  assert.equal(session.sameSite, "Strict")
  assert.equal(await page.evaluate(async () => (await fetch("/api/session")).status), 200)
  assert.equal(
    await page.evaluate(async () => (await fetch("/api/apply", { method: "POST" })).status),
    403,
  )
  await page.getByRole("button", { name: "Sign out" }).click()
  await page.getByRole("button", { name: "Sign in with passkey" }).waitFor()
  assert.equal(await page.evaluate(async () => (await fetch("/api/session")).status), 401)
  await page.getByRole("button", { name: "Sign in with passkey" }).click()
  await page.getByRole("button", { name: "Sign out" }).waitFor()
  await page.reload()
  await page.getByRole("button", { name: "Sign out" }).waitFor()
  console.log(
    "Local HTTP browser smoke passed: passkey registration, Secure cookies, CSRF enforcement, logout, sign-in, and reload. No live Telegram or provider requests were made.",
  )
} finally {
  await browser?.close()
  await admin?.stop()
  store?.close()
  await rm(directory, { recursive: true, force: true })
}
