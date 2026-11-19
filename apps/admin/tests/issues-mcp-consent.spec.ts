import { generateKeyPairSync } from "node:crypto"
import { expect, type Page, test } from "@playwright/test"
import {
  adminFixture,
  navigate,
  openChatAccess,
  openDisclosure,
  openProviderDetail,
} from "./admin-fixture.js"

const requestId = `${"R_-".repeat(14)}R`
const clientName = "Client <img src=x onerror=alert(1)>"
const callback = "http://127.0.0.1:8787/oauth/callback"
const requestUrl = `/#issues-mcp=${requestId}`

async function fixture(
  page: Page,
  options: { signedIn?: boolean; status?: number; redirect?: string } = {},
) {
  const state = {
    signedIn: options.signedIn ?? true,
    ops: [] as string[],
    decisions: [] as boolean[],
  }
  await page.route("**/api/**", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()
    state.ops.push(`${method} ${url.pathname}`)
    if (url.pathname === "/api/session") {
      await route.fulfill(
        state.signedIn
          ? { json: { csrf: "consent-csrf", actor: "42" } }
          : { status: 401, json: { error: "Sign in with a passkey" } },
      )
      return
    }
    expect(url.pathname).toBe("/api/issues-mcp/consent")
    expect(state.signedIn).toBe(true)
    if (method === "GET") {
      expect(url.searchParams.get("requestId")).toBe(requestId)
      if (options.status)
        await route.fulfill({ status: options.status, json: { error: "Not found" } })
      else
        await route.fulfill({ json: { clientName, redirectUri: callback, scope: "issues:write" } })
      return
    }
    expect(method).toBe("POST")
    expect(request.headers()["x-csrf-token"]).toBe("consent-csrf")
    const input = request.postDataJSON()
    expect(input).toEqual({ requestId, approve: expect.any(Boolean) })
    state.decisions.push(input.approve)
    const redirect = new URL(callback)
    redirect.searchParams.set("iss", url.origin)
    redirect.searchParams.set("state", "fixture-state")
    if (input.approve) redirect.searchParams.set("code", "C".repeat(43))
    else redirect.searchParams.set("error", "access_denied")
    await route.fulfill({ json: { redirect: options.redirect ?? redirect.href } })
  })
  await page.route(`${callback}**`, (route) => route.fulfill({ body: "Returned to MCP client" }))
  return state
}

test("keeps consent in the hash across reload and passkey sign-in, then explicitly approves", async ({
  page,
  context,
  baseURL,
}) => {
  const admin = new URL("/", baseURL)
  admin.hostname = "localhost"
  const state = await fixture(page, { signedIn: false })
  const browser = await context.newCDPSession(page)
  await browser.send("WebAuthn.enable")
  const { authenticatorId } = await browser.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({
    type: "pkcs8",
    format: "der",
  })
  await browser.send("WebAuthn.addCredential", {
    authenticatorId,
    credential: {
      credentialId: Buffer.from("issues-consent-credential").toString("base64"),
      isResidentCredential: true,
      rpId: "localhost",
      privateKey: key.toString("base64"),
      userHandle: Buffer.from("42").toString("base64"),
      signCount: 0,
    },
  })
  await page.route("**/auth/passkey/**", async (route) => {
    const request = route.request()
    expect(request.method()).toBe("POST")
    const { pathname } = new URL(request.url())
    if (pathname === "/auth/passkey/authenticate/options") {
      expect(request.postDataJSON()).toEqual({})
      await route.fulfill({
        json: {
          challenge: Buffer.from("issues-mcp-challenge").toString("base64url"),
          rpId: "localhost",
          userVerification: "required",
        },
      })
    } else {
      expect(pathname).toBe("/auth/passkey/authenticate/verify")
      expect(request.postDataJSON().response.response.signature).toBeTruthy()
      state.signedIn = true
      await route.fulfill({ json: { csrf: "consent-csrf", actor: "42" } })
    }
  })
  await page.setViewportSize({ width: 390, height: 820 })
  const url = `${admin.origin}${requestUrl}`
  await page.goto(url)
  const signIn = page.getByRole("button", { name: "Sign in with passkey" })
  await expect(signIn).toBeVisible()
  await expect(page).toHaveURL(url)
  expect(state.ops).toEqual(["GET /api/session"])
  await page.reload()
  await signIn.click()
  const consent = page.getByRole("main")
  const approve = consent.getByRole("button", { name: "Approve access" })
  await expect(approve).toBeEnabled()
  await expect(page).toHaveURL(url)
  await expect(consent.getByText(clientName, { exact: true })).toBeVisible()
  await expect(consent.locator("dl img")).toHaveCount(0)
  await expect(consent.getByText(callback, { exact: true })).toBeVisible()
  await expect(consent.getByText("issues:write", { exact: true })).toBeVisible()
  await expect(consent.getByText(/Sumire does not verify it/)).toBeVisible()
  await expect(consent.getByText(/permanently delete issues/)).toBeVisible()
  await expect(page.getByRole("complementary")).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(
    await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })),
  ).toEqual({ local: {}, session: {} })
  expect(state.ops).toEqual(["GET /api/session", "GET /api/session", "GET /api/issues-mcp/consent"])
  expect(state.decisions).toEqual([])
  const deny = consent.getByRole("button", { name: "Deny access" })
  await deny.focus()
  await page.keyboard.press("Tab")
  await expect(approve).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(new RegExp(`^${callback}\\?.*code=${"C".repeat(43)}$`))
  expect(state.decisions).toEqual([true])
  await page.route("**/api/session", (route) => route.fulfill({ status: 401, json: {} }))
  await page.goBack()
  await expect(page).toHaveURL(`${admin.origin}/`)
})

for (const dirty of [true, false]) {
  test(`leaving same-tab consent ${dirty ? "keeps unsaved policy edits" : "reloads clean settings"}`, async ({
    page,
  }) => {
    const requests = await adminFixture(page)
    const settingsReads = () => requests.filter((request) => request === "GET /api/settings").length
    await page.route("**/api/issues-mcp/consent?*", (route) =>
      route.fulfill({ json: { clientName, redirectUri: callback, scope: "issues:write" } }),
    )
    await openChatAccess(page)
    const review = page.getByRole("button", { name: "Review and save changes", exact: true })
    if (dirty) {
      await page.getByRole("button", { name: "Revoke access for ID 42", exact: true }).click()
      await expect(review).toBeEnabled()
    }
    const settingsUrl = page.url()
    await page.evaluate((id) => {
      window.location.hash = `issues-mcp=${id}`
    }, requestId)
    await expect(page.getByRole("button", { name: "Approve access" })).toBeEnabled()
    await expect(page.getByRole("complementary")).toHaveCount(0)
    expect(settingsReads()).toBe(1)

    await page.goBack()
    await expect(page).toHaveURL(settingsUrl)
    await openDisclosure(page, "Access management")
    if (dirty) {
      await expect(page.getByRole("button", { name: "Undo revocation for 42" })).toBeVisible()
      await expect(review).toBeEnabled()
      expect(settingsReads()).toBe(1)
    } else {
      await expect.poll(settingsReads).toBe(2)
      await expect(page.getByRole("button", { name: "Revoke access for ID 42" })).toBeEnabled()
      await expect(review).toHaveCount(0)
    }
  })
}

test("canceling same-tab consent keeps the endpoint and staged policy drafts", async ({ page }) => {
  await adminFixture(page)
  let consentReads = 0
  await page.route("**/api/issues-mcp/consent?*", (route) => {
    consentReads++
    return route.fulfill({ json: { clientName, redirectUri: callback, scope: "issues:write" } })
  })
  await openChatAccess(page)
  await page.getByRole("button", { name: "Revoke access for ID 42", exact: true }).click()
  const chatsUrl = page.url()
  await navigate(page, "Model Providers")
  await openProviderDetail(page)
  await openDisclosure(page, "Custom endpoint")
  const endpoint = page.getByLabel("Provider ID", { exact: true })
  await endpoint.fill("unfinished-endpoint")
  await page.getByLabel("API base URL", { exact: true }).fill("https://endpoint.example.test/v1")
  const settingsUrl = await page.evaluate(() => {
    window.history.replaceState(window.history.state, "", "#model-availability")
    return window.location.href
  })
  const historyLength = await page.evaluate(() => window.history.length)
  const dialogs: string[] = []
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message())
    return dialog.dismiss()
  })

  await page.evaluate((id) => {
    window.location.hash = `issues-mcp=${id}`
  }, requestId)

  await expect.poll(() => dialogs).toEqual(["Discard unfinished custom endpoint edits?"])
  await expect(page).toHaveURL(settingsUrl)
  await expect(endpoint).toHaveValue("unfinished-endpoint")
  await expect(page.getByLabel("API base URL", { exact: true })).toHaveValue(
    "https://endpoint.example.test/v1",
  )
  await expect(
    page.getByRole("button", { name: "Continue editing: Providers & models — Custom endpoint" }),
  ).toBeVisible()
  expect(consentReads).toBe(0)
  // Restoring the URL must not push another entry or remove the earlier workspace entries.
  expect(await page.evaluate(() => window.history.length)).toBe(historyLength + 1)
  await page.evaluate(() => window.history.go(-2))
  await expect(page).toHaveURL(chatsUrl)
  await expect(page.getByRole("button", { name: "Undo revocation for 42" })).toBeVisible()
})

test("confirming same-tab consent clears discarded local flags only", async ({ page }) => {
  const requests = await adminFixture(page)
  await page.route("**/api/issues-mcp/consent?*", (route) =>
    route.fulfill({ json: { clientName, redirectUri: callback, scope: "issues:write" } }),
  )
  await openChatAccess(page)
  await page.getByRole("button", { name: "Revoke access for ID 42", exact: true }).click()
  await page.getByLabel("Telegram ID to approve", { exact: true }).fill("8001")
  await navigate(page, "Tool permissions")
  await openDisclosure(page, "Approve an exact tool name")
  await page.getByLabel("Additional approved tool name", { exact: true }).fill("unfinished_tool")
  await navigate(page, "Model Providers")
  await openProviderDetail(page)
  await openDisclosure(page, "Custom endpoint")
  await page.getByLabel("Provider ID", { exact: true }).fill("unfinished-endpoint")
  const settingsUrl = page.url()
  const resumeEndpoint = page.getByRole("button", {
    name: "Continue editing: Providers & models — Custom endpoint",
  })
  const resumeAccess = page.getByRole("button", {
    name: "Continue editing: Chat access — Telegram ID to approve",
  })
  await expect(resumeEndpoint).toBeVisible()
  await expect(resumeAccess).toBeVisible()
  const dialogs: string[] = []
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message())
    return dialog.accept()
  })

  await page.evaluate((id) => {
    window.location.hash = `issues-mcp=${id}`
  }, requestId)
  await expect(page.getByRole("button", { name: "Approve access" })).toBeEnabled()
  expect(dialogs).toEqual([
    "Discard unfinished editor drafts and open OAuth consent? Policy changes and exact tool input will be kept.",
  ])
  await page.goBack()
  await expect(page).toHaveURL(settingsUrl)
  await openProviderDetail(page)
  await openDisclosure(page, "Custom endpoint")
  await expect(page.getByLabel("Provider ID", { exact: true })).toHaveValue("")
  await expect(resumeEndpoint).toHaveCount(0)
  await expect(resumeAccess).toHaveCount(0)
  await page
    .getByRole("button", {
      name: "Continue editing: Tool permissions — Additional approved tool name",
    })
    .click()
  await expect(page.getByLabel("Additional approved tool name", { exact: true })).toHaveValue(
    "unfinished_tool",
  )
  await openChatAccess(page)
  await expect(page.getByLabel("Telegram ID to approve", { exact: true })).toHaveValue("")
  await expect(page.getByRole("button", { name: "Undo revocation for 42" })).toBeVisible()
  expect(requests.filter((request) => request === "GET /api/settings")).toHaveLength(1)
})

test("explicitly denies access and returns an OAuth denial to the local client", async ({
  page,
}) => {
  const state = await fixture(page)
  await page.goto(requestUrl)
  const deny = page.getByRole("button", { name: "Deny access" })
  await expect(deny).toBeVisible()
  expect(state.decisions).toEqual([])
  await deny.click()
  await expect(page).toHaveURL(new RegExp(`^${callback}\\?.*error=access_denied$`))
  expect(state.decisions).toEqual([false])
})

test("rejects invalid IDs and requests not bound to this browser", async ({ page }) => {
  const state = await fixture(page, { status: 404 })
  await page.goto("/#issues-mcp=short")
  await expect(page.getByRole("alert")).toContainText("This request is invalid or expired")
  expect(state.ops.every((op) => op === "GET /api/session")).toBe(true)
  await page.goto(requestUrl)
  await expect(page.getByRole("alert")).toContainText("it belongs to a different browser")
  expect(state.ops).toContain("GET /api/issues-mcp/consent")
  await expect(page.getByRole("button", { name: /^(Approve|Deny) access$/ })).toHaveCount(0)
  expect(state.decisions).toEqual([])
})

test("does not navigate or offer Continue if the decision callback differs from the reviewed address", async ({
  page,
  baseURL,
}) => {
  const forged = new URL("http://127.0.0.1:8787/other")
  forged.searchParams.set("iss", new URL("/", baseURL).origin)
  forged.searchParams.set("state", "fixture-state")
  forged.searchParams.set("code", "C".repeat(43))
  let attempted = false
  await page.route(`${forged.origin}/other**`, async (route) => {
    attempted = true
    await route.abort()
  })
  const state = await fixture(page, { redirect: forged.href })
  await page.goto(requestUrl)
  await page.getByRole("button", { name: "Approve access" }).click()
  await expect(page.getByRole("alert")).toContainText(
    "The return address did not match the request",
  )
  await expect(page).toHaveURL(new URL("/", baseURL).href)
  await expect(page.getByRole("link", { name: "Continue to MCP client" })).toHaveCount(0)
  expect(state.decisions).toEqual([true])
  expect(attempted).toBe(false)
})
