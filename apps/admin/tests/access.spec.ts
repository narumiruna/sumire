import { generateKeyPairSync } from "node:crypto"
import { expect, type Page, test } from "@playwright/test"

const token = "a".repeat(64)
const policy = {
  tools: [],
  servers: [],
  models: [],
  providers: [],
  defaults: { tools: [], servers: [], models: [], model: null, thinking: "off" },
  privateUsers: [42],
  groups: [],
  chats: {},
}
async function fixture(page: Page, signedIn = true) {
  let revision = 1
  let status = "applied"
  let approved = false
  let valid = true
  let conflict = false
  let failure = false
  let approvals = 0
  let resolutions = 0
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === "/api/session") {
      await route.fulfill({
        status: signedIn ? 200 : 401,
        json: signedIn ? { csrf: "csrf-fixture", actor: "42" } : { error: "Sign in" },
      })
      return
    }
    if (path === "/api/logout") signedIn = false
    if (path === "/api/access/resolve" || path === "/api/access/approve") {
      expect(route.request().method()).toBe("POST")
      expect(route.request().headers()["x-csrf-token"]).toBe("csrf-fixture")
      expect(route.request().postDataJSON().token).toBe(token)
      if (!signedIn || !valid) {
        await route.fulfill({
          status: signedIn ? 410 : 401,
          json: { error: "Approval link expired or is no longer valid" },
        })
        return
      }
      if (path.endsWith("resolve")) {
        resolutions++
        await route.fulfill({
          json: {
            id: -100,
            type: "supergroup",
            name: "<img src=x onerror=alert(1)>",
            expires: Date.now() + 900000,
            revision,
          },
        })
        return
      }
      approvals++
      expect(route.request().postDataJSON().revision).toBe(revision)
      if (conflict) {
        conflict = false
        revision++
        await route.fulfill({
          status: 409,
          json: { error: "Settings changed; reload before saving" },
        })
        return
      }
      approved = true
      valid = false
      revision++
      status = failure ? "failed" : "applied"
      if (failure) {
        await route.fulfill({ status: 500, json: { error: "Operation failed" } })
        return
      }
    }
    if (path === "/api/apply") status = "applied"
    const data: Record<string, unknown> = {
      "/api/settings": {
        revision,
        applied: status === "applied" ? revision : revision - 1,
        status,
        policy: { ...policy, groups: approved ? [-100] : [] },
      },
      "/api/inventory": { tools: [], providers: [], mcp: [] },
      "/api/chats": [],
      "/api/imports": [],
      "/api/audit": [],
    }
    await route.fulfill({ json: data[path] ?? {} })
  })
  return {
    signIn: () => {
      signedIn = true
    },
    expire: () => {
      valid = false
    },
    conflict: () => {
      conflict = true
    },
    fail: () => {
      failure = true
    },
    state: () => ({ approvals, resolutions }),
  }
}

test("retains a fragment request through reload and virtual Passkey sign-in, then requires confirmation", async ({
  page,
  context,
  baseURL,
}) => {
  const localUrl = new URL("/", baseURL)
  localUrl.hostname = "localhost"
  const f = await fixture(page, false)
  const client = await context.newCDPSession(page)
  await client.send("WebAuthn.enable")
  const { authenticatorId } = await client.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  const credentialId = Buffer.from("fixture-credential").toString("base64")
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({
    type: "pkcs8",
    format: "der",
  })
  await client.send("WebAuthn.addCredential", {
    authenticatorId,
    credential: {
      credentialId,
      isResidentCredential: true,
      rpId: "localhost",
      privateKey: key.toString("base64"),
      userHandle: Buffer.from("42").toString("base64"),
      signCount: 0,
    },
  })
  await page.route("**/auth/passkey/**", async (route) => {
    if (route.request().url().endsWith("options")) {
      await route.fulfill({
        json: {
          challenge: Buffer.from("fixture-challenge-for-chat-approval").toString("base64url"),
          rpId: "localhost",
          userVerification: "required",
        },
      })
    } else {
      expect(route.request().postDataJSON().response.response.signature).toBeTruthy()
      f.signIn()
      await route.fulfill({ json: { csrf: "csrf-fixture", actor: "42" } })
    }
  })
  await page.goto(`${localUrl.origin}/#allow=${token}`)
  await expect(page.getByRole("button", { name: "Sign in with passkey" })).toBeVisible()
  await expect(page).toHaveURL(`${localUrl.origin}/`)
  expect(f.state().resolutions).toBe(0)
  await page.reload()
  await page.getByRole("button", { name: "Sign in with passkey" }).click()
  await expect(page.getByRole("button", { name: "Approve chat", exact: true })).toBeEnabled()
  expect(f.state().approvals).toBe(0)
  const identity = page
    .getByRole("region", { name: "Chat access approval request", exact: true })
    .locator("dl")
  await expect(identity.getByText("<img src=x onerror=alert(1)>", { exact: true })).toBeVisible()
  await expect(identity.getByText("supergroup", { exact: true })).toBeVisible()
  await expect(identity.getByText("-100", { exact: true })).toBeVisible()
  await expect(identity.locator("img")).toHaveCount(0)
  await page.getByRole("button", { name: "Approve chat", exact: true }).click()
  await expect(page.getByText("Settings saved and applied.", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Approve chat", exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole("button", { name: "Account", exact: true })).toBeVisible()
  expect(f.state().approvals).toBe(1)
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0)
})

test("removes environment import controls and shows retained read-only history on Audit", async ({
  page,
}) => {
  await fixture(page)
  let reconciliationRequests = 0
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/access/reconciliation") reconciliationRequests++
  })
  await page.route("**/api/imports", (route) =>
    route.fulfill({
      json: [
        {
          name: "environment-access:5",
          report: { revision: 5, decisions: [{ id: -100, decision: "retain-denial" }] },
        },
      ],
    }),
  )
  await page.goto("/")
  await page.getByRole("link", { name: "Chat access", exact: true }).click()
  await expect(page.getByRole("button", { name: "Confirm environment review" })).toHaveCount(0)
  await expect(page.getByRole("heading", { name: "Review environment access" })).toHaveCount(0)
  await page.getByRole("link", { name: "Audit", exact: true }).click()
  await expect(page.getByText(/environment-access:5/)).toBeVisible()
  expect(reconciliationRequests).toBe(0)
})

test("shows known chat names beside access IDs and keeps unnamed IDs usable", async ({ page }) => {
  await fixture(page)
  await page.route("**/api/settings", (route) =>
    route.fulfill({
      json: {
        revision: 1,
        applied: 1,
        status: "applied",
        policy: { ...policy, privateUsers: [42, 43], groups: [-100, -200] },
      },
    }),
  )
  await page.route("**/api/chats?*", (route) => {
    const url = new URL(route.request().url())
    const id = url.searchParams.get("id")
    const query = (url.searchParams.get("q") ?? "").toLowerCase()
    const offset = Number(url.searchParams.get("offset") ?? 0)
    const chats = [
      { id: 42, type: "private", name: "Alice" },
      { id: -100, type: "supergroup", name: "<img src=x onerror=alert(1)>" },
      { id: -200, type: "group", name: "-200" },
    ]
    return route.fulfill({
      json:
        id !== null
          ? chats.filter((chat) => String(chat.id) === id)
          : chats
              .filter(
                (chat) => chat.name.toLowerCase().includes(query) || String(chat.id) === query,
              )
              .slice(offset, offset + 100),
    })
  })
  await page.goto("/")
  await page.getByRole("link", { name: "Chat access", exact: true }).click()
  const users = page.getByRole("group", { name: "Private-message access", exact: true })
  await expect(users.getByRole("row").filter({ hasText: "Alice" })).toContainText("42")
  await expect(users.getByRole("row").filter({ hasText: "43" })).toHaveText(
    "Unnamed private43ApprovedRevoke access",
  )
  const groups = page.getByRole("group", { name: "Group and channel access", exact: true })
  await expect(groups.getByRole("row").filter({ hasText: "-100" })).toContainText(
    "<img src=x onerror=alert(1)>",
  )
  await expect(groups.getByRole("row").filter({ hasText: "-200" })).toHaveText(
    "Unnamed group-200ApprovedRevoke access",
  )
  await expect(users.locator("img")).toHaveCount(0)
  await expect(groups.locator("img")).toHaveCount(0)
  await users.getByRole("button", { name: "Revoke access for ID 42", exact: true }).click()
  const revoked = users.getByRole("row").filter({ hasText: "Alice" })
  await expect(revoked).toContainText("42")
  await expect(revoked.getByText("Pending revocation", { exact: true })).toBeVisible()
  await expect(
    revoked.getByRole("button", { name: "Revoke access for ID 42", exact: true }),
  ).toHaveCount(0)
  await expect(
    revoked.getByRole("button", { name: "Undo revocation for 42", exact: true }),
  ).toBeVisible()
})

for (const mode of [
  { width: 1440, zoom: 1 },
  { width: 1200, zoom: 1 },
  { width: 390, zoom: 1 },
  { width: 320, zoom: 1 },
  { width: 640, zoom: 2 },
]) {
  test(`access undo labels fit their controls at ${mode.width}px and ${mode.zoom}x zoom`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: mode.width, height: 900 })
    await fixture(page)
    const ids = [1234567890, -1001234567890]
    await page.route("**/api/settings", (route) =>
      route.fulfill({
        json: {
          revision: 1,
          applied: 1,
          status: "applied",
          policy: { ...policy, privateUsers: [ids[0]], groups: [ids[1]] },
        },
      }),
    )
    const writes: string[] = []
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/") && request.method() !== "GET")
        writes.push(`${request.method()} ${request.url()}`)
    })
    await page.goto("/?section=Access")
    await page.evaluate((zoom) => {
      document.documentElement.style.zoom = String(zoom)
    }, mode.zoom)
    for (const id of ids) {
      const revoke = page.getByRole("button", { name: `Revoke access for ID ${id}`, exact: true })
      await revoke.click()
      const undo = page.getByRole("button", { name: `Undo revocation for ${id}`, exact: true })
      await expect(undo).toBeVisible()
      const geometry = await undo.evaluate((element) => {
        const button = element.getBoundingClientRect()
        const cell = element.closest("td")?.getBoundingClientRect()
        if (!cell) throw new Error("Missing access action cell")
        const text = document.createRange()
        text.selectNodeContents(element)
        return {
          textOverflow: Math.max(
            ...Array.from(text.getClientRects(), (rect) =>
              Math.max(button.left - rect.left, rect.right - button.right),
            ),
          ),
          buttonOverflow: Math.max(cell.left - button.left, button.right - cell.right),
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        }
      })
      expect(geometry.textOverflow, String(id)).toBeLessThanOrEqual(1)
      expect(geometry.buttonOverflow, String(id)).toBeLessThanOrEqual(1)
      expect(geometry.scrollWidth, String(id)).toBeLessThanOrEqual(geometry.clientWidth + 1)
      await undo.click()
      await expect(revoke).toBeVisible()
      await expect(undo).toHaveCount(0)
      await expect(
        page.getByRole("button", { name: "Review and save changes", exact: true }),
      ).toHaveCount(0)
    }
    expect(writes).toEqual([])
  })
}

test("captures links opened in an existing WebUI tab without a document reload", async ({
  page,
}) => {
  const f = await fixture(page)
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Account", exact: true })).toBeVisible()
  const initialUrl = page.url()
  await page.goto(`/#allow=${token}`)
  await expect(page).toHaveURL(initialUrl)
  await expect(page.getByRole("button", { name: "Approve chat", exact: true })).toBeEnabled()
  expect(f.state()).toMatchObject({ approvals: 0, resolutions: 1 })
})

test("does not show or clear an old target when another link opens during approval", async ({
  page,
}) => {
  await fixture(page)
  const replacement = "b".repeat(64)
  let finishResolve!: () => void
  let finishApprove!: () => void
  const resolving = new Promise<void>((resolve) => {
    finishResolve = resolve
  })
  const approving = new Promise<void>((resolve) => {
    finishApprove = resolve
  })
  await page.route("**/api/access/resolve", async (route) => {
    if (route.request().postDataJSON().token !== replacement) return route.fallback()
    await resolving
    await route.fulfill({
      json: {
        id: -200,
        type: "group",
        name: "Replacement target",
        expires: Date.now() + 900000,
        revision: 1,
      },
    })
  })
  await page.route("**/api/access/approve", async (route) => {
    expect(route.request().postDataJSON().token).toBe(token)
    await approving
    await route.fulfill({ json: {} })
  })
  await page.goto(`/#allow=${token}`)
  await page.getByRole("button", { name: "Approve chat", exact: true }).click()
  await page.goto(`/#allow=${replacement}`)
  await expect(page.getByRole("button", { name: "Approve chat", exact: true })).toHaveCount(0)
  finishResolve()
  const identity = page
    .getByRole("region", { name: "Chat access approval request", exact: true })
    .locator("dl")
  await expect(identity.getByText("Replacement target", { exact: true })).toBeVisible()
  await expect(identity.getByText("group", { exact: true })).toBeVisible()
  await expect(identity.getByText("-200", { exact: true })).toBeVisible()
  await expect(identity.getByText("<img src=x onerror=alert(1)>", { exact: true })).toHaveCount(0)
  await expect(identity.locator("img")).toHaveCount(0)
  finishApprove()
  await expect(page.getByRole("button", { name: "Approve chat", exact: true })).toBeEnabled()
  expect(
    await page.evaluate(
      () => JSON.parse(sessionStorage.getItem("sumire.pending-chat-access") ?? "null")?.token,
    ),
  ).toBe(replacement)
})

test("clears expired and signed-out intent without approving anything", async ({ page }) => {
  const f = await fixture(page)
  f.expire()
  await page.goto(`/#allow=${token}`)
  await expect(page.getByRole("alert")).toContainText("no longer valid")
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0)
  expect(f.state().approvals).toBe(0)
  await page.goto(`/#allow=${token}`)
  await expect(page.getByRole("button", { name: "Account", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Account", exact: true }).click()
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click()
  await expect(page.getByRole("button", { name: "Sign in with passkey" })).toBeVisible()
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0)
})

test("requires renewed review on conflict and displays failed runtime application with retry", async ({
  page,
}) => {
  const f = await fixture(page)
  f.conflict()
  await page.goto(`/#allow=${token}`)
  await page.getByRole("button", { name: "Approve chat", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("Settings changed")
  await expect(page.getByRole("button", { name: "Approve chat", exact: true })).toBeEnabled()
  expect(f.state().approvals).toBe(1)
  f.fail()
  await page.getByRole("button", { name: "Approve chat", exact: true }).click()
  await expect(
    page.getByText("Saved, but application failed. Retry application.", { exact: true }),
  ).toBeVisible()
  await page.getByRole("button", { name: "Retry application" }).click()
  await expect(page.getByText("Settings saved and applied.", { exact: true })).toBeVisible()
  expect(f.state().approvals).toBe(2)
})
