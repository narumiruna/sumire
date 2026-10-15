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
}) => {
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
  await page.goto(`http://localhost:17466/#allow=${token}`)
  await expect(page.getByRole("button", { name: "Sign in with passkey" })).toBeVisible()
  await expect(page).toHaveURL("http://localhost:17466/")
  expect(f.state().resolutions).toBe(0)
  await page.reload()
  await page.getByRole("button", { name: "Sign in with passkey" }).click()
  await expect(page.getByRole("button", { name: "Approve chat", exact: true })).toBeEnabled()
  expect(f.state().approvals).toBe(0)
  await expect(page.getByText("<img src=x onerror=alert(1)> · supergroup · -100")).toBeVisible()
  await expect(page.locator("img")).toHaveCount(0)
  await page.getByRole("button", { name: "Approve chat", exact: true }).click()
  await expect(page.getByText("All changes applied.", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Approve chat", exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible()
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
  await page.getByRole("button", { name: "Access", exact: true }).click()
  await expect(page.getByRole("button", { name: "Confirm environment review" })).toHaveCount(0)
  await expect(page.getByRole("heading", { name: "Review environment access" })).toHaveCount(0)
  await page.getByRole("button", { name: "Audit", exact: true }).click()
  await expect(page.getByText(/environment-access:5/)).toBeVisible()
  expect(reconciliationRequests).toBe(0)
})

test("captures links opened in an existing WebUI tab without a document reload", async ({
  page,
}) => {
  const f = await fixture(page)
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible()
  await page.goto(`/#allow=${token}`)
  await expect(page).toHaveURL("http://127.0.0.1:17466/")
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
  await expect(page.getByText("Replacement target · group · -200")).toBeVisible()
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
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible()
  await page.getByRole("button", { name: "Sign out" }).click()
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
  await expect(page.getByText("All changes applied.", { exact: true })).toBeVisible()
  expect(f.state().approvals).toBe(2)
})
