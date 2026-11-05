import { expect, type Page, test } from "@playwright/test"
import { basePolicy, inventory, navigate } from "./admin-fixture.js"

const token = "synthetic-replacement-never-persist"
const hidden = "synthetic-backend-only-never-render"
const code = "ABCD-EFGH"

/** Synthetic local API only. No credentials or remote calls are used. */
async function fixture(
  page: Page,
  options: {
    failedRead?: boolean
    empty?: boolean
    failedApply?: boolean
    failedSave?: boolean
    unavailableGitHub?: boolean
  } = {},
) {
  let revision = 1
  let applied = 1
  let status = "applied"
  let flow: Record<string, unknown> | undefined
  const policy = {
    ...structuredClone(basePolicy),
    skills: ["documents"],
    defaults: { ...structuredClone(basePolicy.defaults), skills: ["documents"] },
    githubNotifications: { allowedUsernames: ["saved-author"] },
  }
  let entries: Record<string, unknown>[] = options.empty
    ? []
    : [{ name: "GH_TOKEN", kind: "secret", configured: true, updatedAt: 1000, revision: 1 }]
  const calls: { path: string; method: string; body?: unknown }[] = []
  const state = { failedRead: options.failedRead, expired: false }
  await page.route("**/api/**", async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const method = request.method()
    const body = method === "GET" ? undefined : request.postDataJSON()
    calls.push({ path, method, body })
    if (state.expired) {
      await route.fulfill({ status: 401, json: { error: hidden } })
      return
    }
    if (path === "/api/runtime-config") {
      await route.fulfill(
        state.failedRead
          ? { status: 503, json: { error: hidden } }
          : { json: { revision, applied, status, secretStatus: "ready", entries } },
      )
      return
    }
    if (path === "/api/runtime-config/GH_TOKEN" && method === "PUT") {
      if (options.failedSave) {
        await route.fulfill({ status: 409, json: { error: hidden } })
        return
      }
      revision++
      status = options.failedApply ? "failed" : "applied"
      if (status === "applied") applied = revision
      entries = [{ name: "GH_TOKEN", kind: "secret", configured: true, updatedAt: 2000, revision }]
      await route.fulfill({ json: { revision, applied, status, secretStatus: "ready", entries } })
      return
    }
    if (path === "/api/github/connection") {
      await route.fulfill(
        options.unavailableGitHub
          ? { status: 503, json: { error: hidden } }
          : {
              json: {
                revision,
                applied,
                status,
                secretStatus: "ready",
                mode: "oauth",
                clientId: "Ov23fixture",
                account: { id: 7, login: "prior-account" },
                scopes: ["repo", "read:org"],
                reconnectRequired: false,
                flow,
                accessToken: hidden,
                error: hidden,
              },
            },
      )
      return
    }
    if (path === "/api/github/oauth") {
      flow = {
        id: "interaction-flow",
        status: "pending",
        expiresAt: Date.now() + 600000,
        userCode: code,
        verificationUri: "https://github.com/login/device",
      }
      await route.fulfill({ json: flow })
      return
    }
    if (path === "/api/github/oauth/interaction-flow/cancel") {
      flow = { id: "interaction-flow", status: "cancelled", expiresAt: Date.now() + 600000 }
      await route.fulfill({ json: flow })
      return
    }
    if (path === "/api/github/oauth/interaction-flow") {
      await route.fulfill({ json: flow })
      return
    }
    const data: Record<string, unknown> = {
      "/api/session": { csrf: "fixture", actor: "42" },
      "/api/settings": { revision, applied, status, policy },
      "/api/inventory": {
        ...inventory,
        skills: [
          {
            name: "documents",
            description:
              "Read documents. Full instructions stay in details and grant no tool access.",
          },
        ],
      },
      "/api/chats": [],
      "/api/imports": [],
      "/api/audit": [],
      "/api/logout": {},
    }
    await route.fulfill({ json: data[path] ?? {} })
  })
  await page.goto("/?section=Secrets+%26+variables")
  await expect(page.getByRole("heading", { name: "密鑰與變數", exact: true })).toBeVisible()
  return { calls, state }
}

async function noLeak(page: Page, sentinel: string) {
  expect(await page.locator("body").textContent()).not.toContain(sentinel)
  expect(
    await page.evaluate(() =>
      JSON.stringify({
        url: location.href,
        history: history.state,
        local: { ...localStorage },
        session: { ...sessionStorage },
      }),
    ),
  ).not.toContain(sentinel)
}

for (const width of [320, 1440]) {
  test(`secret list precedes optional connection controls at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const { calls } = await fixture(page, { unavailableGitHub: true })
    const replace = page.getByRole("button", { name: "Replace GH_TOKEN", exact: true })
    await expect(replace).toBeEnabled()
    await expect(page.getByRole("region", { name: "GitHub connection", exact: true })).toHaveCount(
      0,
    )
    expect(calls.filter((call) => call.path.startsWith("/api/github/"))).toEqual([])
    await expect(page.getByText("Configured · write-only", { exact: true })).toBeVisible()
    await expect(page.getByText(/••••/)).toHaveCount(0)
    const action = page.getByRole("button", { name: "Manage GitHub connection", exact: true })
    const replaceBox = await replace.boundingBox()
    const actionBox = await action.boundingBox()
    if (!replaceBox || !actionBox)
      throw new Error("Secret list and connection action must be visible")
    expect(replaceBox.y).toBeLessThan(actionBox.y)
    await action.click()
    await expect(
      page.getByText(
        "GitHub connection is unavailable. Manual GH_TOKEN controls remain available.",
      ),
    ).toBeVisible()
    await replace.click()
    await expect(page.getByLabel("Runtime secret value")).toHaveValue("")
    await page.getByLabel("Runtime secret value").fill(token)
    await page.getByRole("button", { name: "Keep unchanged", exact: true }).click()
    expect(calls.filter((call) => call.method !== "GET")).toEqual([])
    await noLeak(page, token)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}

test("failed runtime read ends loading and retries safe metadata without a write", async ({
  page,
}) => {
  const { calls, state } = await fixture(page, { failedRead: true })
  await expect(page.getByRole("alert")).toContainText("Could not load safe runtime metadata")
  await expect(page.getByText("Loading runtime metadata…", { exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Add secret", exact: true })).toBeDisabled()
  state.failedRead = false
  await page.getByRole("button", { name: "Reload safe metadata", exact: true }).click()
  await expect(page.getByRole("button", { name: "Replace GH_TOKEN", exact: true })).toBeEnabled()
  expect(calls.every((call) => call.method === "GET")).toBe(true)
  await noLeak(page, hidden)
})

test("empty secret inventory and search with no matches are distinct", async ({ page }) => {
  await fixture(page, { empty: true })
  await expect(page.getByText("No secrets configured.", { exact: true })).toBeVisible()
  await page.getByRole("tab", { name: "Variables", exact: true }).click()
  await expect(page.getByText("No variables configured.", { exact: true })).toBeVisible()
  await fixture(page)
  await page.getByLabel("Search names").fill("not-present")
  await expect(page.getByText("No matching names.", { exact: true })).toBeVisible()
  await expect(page.getByText("No secrets configured.", { exact: true })).toHaveCount(0)
})

test("replacement saves once and reports application failure separately without retaining plaintext", async ({
  page,
}) => {
  const { calls } = await fixture(page, { failedApply: true })
  await page.getByRole("button", { name: "Replace GH_TOKEN", exact: true }).click()
  await expect(page.getByLabel("Runtime secret value")).toHaveValue("")
  await page.getByLabel("Runtime secret value").fill(token)
  await noLeak(page, token)
  await page.getByRole("button", { name: "Save secret", exact: true }).click()
  await expect(
    page.getByText(
      "Saved; application failed. Retry application above without submitting the value again.",
      { exact: true },
    ),
  ).toBeVisible()
  await expect(page.getByLabel("Runtime secret value")).toHaveCount(0)
  const writes = calls.filter((call) => call.method !== "GET")
  expect(writes).toEqual([
    {
      path: "/api/runtime-config/GH_TOKEN",
      method: "PUT",
      body: { revision: 1, kind: "secret", value: token },
    },
  ])
  await noLeak(page, token)
})

test("a conflicting secret save keeps its draft and requires explicit metadata recovery", async ({
  page,
}) => {
  const { calls } = await fixture(page, { failedSave: true })
  await page.getByRole("button", { name: "Replace GH_TOKEN", exact: true }).click()
  await page.getByLabel("Runtime secret value").fill(token)
  await page.getByRole("button", { name: "Save secret", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("No automatic retry will occur")
  await expect(page.getByLabel("Runtime secret value")).toHaveValue(token)
  await expect(page.getByRole("button", { name: "Save secret", exact: true })).toBeDisabled()
  expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1)
  await page.getByRole("button", { name: "Keep unchanged", exact: true }).click()
  await expect(page.getByLabel("Runtime secret value")).toHaveCount(0)
  await noLeak(page, token)
})

test("GitHub mention metadata failure is unknown, not loading or a missing credential claim", async ({
  page,
}) => {
  const { calls } = await fixture(page, { unavailableGitHub: true })
  await navigate(page, "GitHub mentions")
  const status = page.getByRole("region", { name: "GitHub mentions status", exact: true })
  await expect(status).toContainText("Could not load local GitHub metadata")
  await expect(status).toContainText("Local credential: Unknown")
  await expect(status).not.toContainText("Checking local metadata")
  await expect(status).not.toContainText("GH_TOKEN is not configured")
  await expect(page.getByRole("button", { name: "Manage GH_TOKEN", exact: true })).toBeEnabled()
  expect(calls.every((call) => call.method === "GET")).toBe(true)
  await noLeak(page, hidden)
})

test("pending mention authors do not replace the saved author policy status", async ({ page }) => {
  const { calls } = await fixture(page)
  await navigate(page, "GitHub mentions")
  await page.getByLabel("GitHub username", { exact: true }).fill("draft-author")
  await page.getByRole("button", { name: "Add username", exact: true }).click()
  const status = page.getByRole("region", { name: "GitHub mentions status", exact: true })
  await expect(status).toContainText("Saved author policy: 1 allowed usernames")
  await expect(status).toContainText(
    "Draft author policy: 2 allowed usernames. Unsaved; saved policy still applies.",
  )
  await expect(page.getByText("Pending addition", { exact: true })).toBeVisible()
  expect(calls.every((call) => call.method === "GET")).toBe(true)
})

test("GitHub mentions opens the one on-demand connection panel and closing cancels its authorization", async ({
  page,
}) => {
  const { calls } = await fixture(page)
  await navigate(page, "GitHub mentions")
  const status = page.getByRole("region", { name: "GitHub mentions status", exact: true })
  await expect(status).toContainText("Saved author policy: 1 allowed usernames")
  await expect(status).toContainText("prior-account (ID 7) during GitHub authorization")
  await expect(status).toContainText("Remote verification and worker status: unavailable")
  expect(calls.filter((call) => call.method !== "GET")).toEqual([])
  await noLeak(page, hidden)
  await page.getByRole("button", { name: "Manage GitHub connection", exact: true }).click()
  const connection = page.getByRole("region", { name: "GitHub connection", exact: true })
  await expect(connection).toHaveCount(1)
  await connection.getByRole("button", { name: "Reconnect GitHub", exact: true }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByRole("checkbox", { name: /I consent to repo/ }).check()
  await dialog.getByRole("checkbox", { name: /Replace the existing GH_TOKEN/ }).check()
  await dialog.getByRole("button", { name: "Start GitHub authorization", exact: true }).click()
  await expect(connection).toContainText(code)
  // Codes are temporary page content, never navigation or browser storage.
  expect(
    await page.evaluate(() =>
      JSON.stringify({
        url: location.href,
        history: history.state,
        local: { ...localStorage },
        session: { ...sessionStorage },
      }),
    ),
  ).not.toContain(code)
  page.once("dialog", (dialog) => dialog.dismiss())
  await page.getByRole("button", { name: "Close GitHub connection", exact: true }).click()
  await expect(connection).toContainText(code)
  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "Close GitHub connection", exact: true }).click()
  await expect(connection).toHaveCount(0)
  await expect.poll(() => calls.filter((call) => call.path.endsWith("/cancel")).length).toBe(1)
  await expect(
    page.getByRole("button", { name: "Manage GitHub connection", exact: true }),
  ).toBeFocused()
  await noLeak(page, code)
  expect(calls.filter((call) => call.path.endsWith("/complete"))).toEqual([])
})

test("skills keep full instructions in details and host maintenance in one top action", async ({
  page,
}) => {
  const { calls } = await fixture(page)
  await navigate(page, "Skills")
  const row = page.getByRole("region", { name: "Skill documents", exact: true })
  await expect(row.getByText("Read documents.", { exact: true })).toBeVisible()
  await expect(row.getByText(/Full instructions stay in details/)).not.toBeVisible()
  await row.locator("summary", { hasText: "Full description" }).click()
  await expect(row.getByText(/Full instructions stay in details/)).toBeVisible()
  await expect(row.getByText("Selected by default", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Installation instructions", exact: true }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toContainText("trusted host maintenance")
  await expect(dialog).toContainText("restart the bot")
  await expect(dialog.getByRole("button")).toHaveCount(1)
  await dialog.getByRole("button", { name: "Close", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Installation instructions", exact: true }),
  ).toBeFocused()
  await page.getByRole("textbox", { name: "Search skills", exact: true }).fill("missing-purpose")
  await expect(page.getByText("No matching skills.", { exact: true })).toBeVisible()
  expect(calls.every((call) => call.method === "GET")).toBe(true)
})
