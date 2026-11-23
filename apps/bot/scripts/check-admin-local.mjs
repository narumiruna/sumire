import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { chromium } from "playwright"
import { ChatAccess } from "../dist/admin/access.js"
import { createPasskeySetup } from "../dist/admin/auth.js"
import { McpAdmin } from "../dist/admin/mcp.js"
import { ProviderAdmin } from "../dist/admin/providers.js"
import { createAdminServer } from "../dist/admin/server.js"
import { AdminStore } from "../dist/admin/store.js"
import { loadSettings } from "../dist/config/settings.js"

async function checkLocalizedSignIn(browser, origin) {
  for (const [locale, label] of [
    ["en", "Sign in with passkey"],
    ["zh-TW", "使用 Passkey 登入"],
    ["ja", "Passkey でサインイン"],
  ]) {
    const context = await browser.newContext({
      locale,
      colorScheme: "dark",
      serviceWorkers: "block",
    })
    try {
      const external = []
      await context.route("**/*", (route) => {
        const url = new URL(route.request().url())
        if (url.origin === origin) return route.continue()
        external.push(url.origin)
        return route.abort()
      })
      const page = await context.newPage()
      await page.addInitScript(() => {
        window.violations = []
        document.addEventListener("securitypolicyviolation", (event) => {
          window.violations.push({
            directive: event.violatedDirective,
            resource: event.blockedURI,
            source: event.sourceFile,
            line: event.lineNumber,
            column: event.columnNumber,
          })
        })
      })
      const response = await page.goto(origin)
      assert.match(
        response.headers()["content-security-policy"],
        /default-src 'self'; script-src 'self'/,
      )
      await page.getByRole("button", { name: label, exact: true }).waitFor()
      const rendered = await page.evaluate(async () => {
        await document.fonts.ready
        return {
          language: document.documentElement.lang,
          colorScheme: getComputedStyle(document.documentElement).colorScheme,
          violations: window.violations,
        }
      })
      assert.deepEqual(rendered, { language: locale, colorScheme: "light", violations: [] })
      assert.deepEqual(external, [])
    } finally {
      await context.close()
    }
  }
}

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
  store = new AdminStore(path.join(directory, "admin.sqlite"), 42)
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
  await checkLocalizedSignIn(browser, config.origin)
  const context = await browser.newContext({ locale: "en" })
  const page = await context.newPage()
  const account = page.getByRole("button", { name: "Account", exact: true })
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
  await account.waitFor()
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
  await account.click()
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click()
  await page.getByRole("button", { name: "Sign in with passkey" }).waitFor()
  assert.equal(await page.evaluate(async () => (await fetch("/api/session")).status), 401)
  const link = new ChatAccess(store).issue(
    { id: -100, type: "supergroup", name: "Approval fixture" },
    config.origin,
  )
  assert.equal(link.approved, false)
  await page.goto(link.url)
  await page.getByRole("button", { name: "Sign in with passkey" }).waitFor()
  assert.equal(new URL(page.url()).hash, "")
  await page.reload()
  await page.getByRole("button", { name: "Sign in with passkey" }).click()
  const approve = page.getByRole("button", { name: "Approve chat", exact: true })
  await approve.waitFor()
  assert.equal(store.allows(-100), false)
  const approved = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/access/approve",
  )
  await approve.click()
  assert.equal((await approved).ok(), true)
  await approve.waitFor({ state: "hidden" })
  const { revision, applied, status } = store.snapshot()
  assert.deepEqual({ revision, applied, status }, { revision: 2, applied: 2, status: "applied" })
  assert.equal(store.allows(-100), true)
  assert.equal(store.allowsTool(-100, "bash"), false)
  assert.equal(await page.evaluate(() => sessionStorage.length), 0)
  await page.reload()
  await account.waitFor()
  assert.equal(store.allows(-100), true)
  await page.getByRole("link", { name: "Chats", exact: true }).click()
  assert.equal(await page.getByRole("button", { name: "Confirm environment review" }).count(), 0)
  console.log(
    "Local HTTP browser smoke passed: same-origin sign-in in three locales, passkey registration, Secure cookies, CSRF enforcement, logout, sign-in, chat approval after reload, and database-only access. No live Telegram or provider requests were made.",
  )
} finally {
  await browser?.close()
  await admin?.stop()
  store?.close()
  await rm(directory, { recursive: true, force: true })
}
