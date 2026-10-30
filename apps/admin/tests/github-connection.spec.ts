import type { GitHubConnection, GitHubFlow } from "@narumitw/sumire-contracts"
import { expect, type Page, test } from "@playwright/test"
import { parseGitHubConnection, parseGitHubFlow } from "../src/github-state.js"
import { basePolicy, inventory, navigate } from "./admin-fixture.js"

type Entry = {
  name: string
  kind: "secret" | "variable"
  configured?: true
  value?: string
  revision: number
  updatedAt: number
}
type Options = {
  mode?: GitHubConnection["mode"]
  clientId?: string | null
  lost?: "start" | "status" | "cancel" | "complete"
  failedApply?: boolean
  newerRevision?: boolean
  superseded?: boolean
  evictReceipt?: boolean
  expiredStatus?: boolean
  unavailable?: boolean
  unsafeLink?: string
  invalidAccount?: boolean
  failedFlow?: boolean
  cancelCommits?: boolean
}
const code = "ABCD-EFGH"
const hidden = "backend-only-credential-sentinel"
const rawError = "untrusted-raw-error-sentinel"
const card = (page: Page) => page.getByRole("region", { name: "GitHub connection", exact: true })

/** All API operations and credentials are synthetic. No GitHub request is made. */
async function fixture(page: Page, options: Options = {}) {
  let revision = 1
  let applied = 1
  let status = "applied"
  let mode = options.mode ?? "none"
  let clientId = options.clientId === undefined ? "Ov23fixture" : options.clientId
  let flow: GitHubFlow | undefined
  let starts = 0
  let completions = 0
  let cancellations = 0
  let statusReads = 0
  let applies = 0
  let loseReply = options.lost
  const calls: { path: string; method: string; body: Record<string, unknown> }[] = []
  let entries: Entry[] = []
  if (mode === "manual" || mode === "oauth")
    entries.push({ name: "GH_TOKEN", kind: "secret", configured: true, revision, updatedAt: 1 })
  if (clientId)
    entries.push({
      name: "GITHUB_OAUTH_CLIENT_ID",
      kind: "variable",
      value: clientId,
      revision,
      updatedAt: 1,
    })
  const safeFlow = () =>
    flow && {
      ...flow,
      ...(options.unsafeLink ? { verificationUri: options.unsafeLink } : {}),
      ...(options.invalidAccount && flow.account
        ? { account: { id: 7, login: "<img src=x>" } }
        : {}),
      accessToken: hidden,
      refreshToken: hidden,
      deviceCode: hidden,
      error: rawError,
      upstream: { html: `<script>${hidden}</script>` },
    }
  const local = () => ({
    revision,
    applied,
    status,
    secretStatus: "ready",
    clientId: clientId ?? undefined,
    mode,
    account: mode === "oauth" ? { id: 7, login: "fixture-user" } : undefined,
    scopes: mode === "oauth" ? ["repo", "read:org"] : undefined,
    reconnectRequired: mode === "invalid",
    flow: options.evictReceipt && flow?.receipt ? undefined : safeFlow(),
    accessToken: hidden,
    refreshToken: hidden,
  })
  const runtime = () => ({ revision, applied, status, secretStatus: "ready", entries })
  const save = () => {
    revision++
    status = options.failedApply ? "failed" : "applied"
    if (status === "applied") applied = revision
  }
  await page.route("**/api/**", async (route) => {
    const req = route.request()
    const path = new URL(req.url()).pathname
    const body = req.method() === "GET" ? {} : (req.postDataJSON() as Record<string, unknown>)
    calls.push({ path, method: req.method(), body })
    if (req.method() !== "GET") expect(req.headers()["x-csrf-token"]).toBe("fixture")
    if (path === "/api/github/connection") {
      await route.fulfill({ json: options.unavailable ? {} : local() })
      return
    }
    if (path === "/api/github/oauth") {
      starts++
      expect(body).toEqual({ revision, replace: mode === "manual" || mode === "oauth" })
      flow = {
        id: "fixture-flow",
        status: options.failedFlow ? "failed" : "pending",
        expiresAt: Date.now() + 600000,
        userCode: code,
        verificationUri: "https://github.com/login/device",
      }
      if (loseReply === "start") {
        loseReply = undefined
        await route.abort("failed")
      } else await route.fulfill({ json: safeFlow() })
      return
    }
    if (path === "/api/github/oauth/fixture-flow") {
      statusReads++
      if (options.expiredStatus) {
        await route.fulfill({ status: 401, json: { error: rawError } })
        return
      }
      if (loseReply === "status") {
        loseReply = undefined
        await route.abort("failed")
      } else await route.fulfill({ json: safeFlow() })
      return
    }
    if (path === "/api/github/oauth/fixture-flow/complete") {
      completions++
      expect(body).toEqual({})
      expect(flow?.status).toBe("authorized")
      save()
      mode = "oauth"
      entries = entries.filter((entry) => entry.name !== "GH_TOKEN")
      entries.push({ name: "GH_TOKEN", kind: "secret", configured: true, revision, updatedAt: 2 })
      flow = {
        id: "fixture-flow",
        status: "completed",
        expiresAt: Date.now() + 300000,
        account: { id: 7, login: "fixture-user" },
        scopes: ["repo", "read:org"],
        receipt: {
          savedRevision: revision,
          application: { revision, applied, status: options.superseded ? "unknown" : status },
        },
      }
      if (options.newerRevision || options.superseded) revision++
      if (loseReply === "complete") {
        loseReply = undefined
        await route.abort("failed")
      } else await route.fulfill({ json: safeFlow() })
      return
    }
    if (path === "/api/github/oauth/fixture-flow/cancel") {
      cancellations++
      expect(body).toEqual({})
      if (!flow?.receipt && options.cancelCommits) {
        save()
        mode = "oauth"
        flow = {
          id: "fixture-flow",
          status: "completed",
          expiresAt: Date.now() + 300000,
          receipt: { savedRevision: revision, application: { revision, applied, status } },
        }
      } else if (!flow?.receipt)
        flow = { id: "fixture-flow", status: "cancelled", expiresAt: Date.now() + 300000 }
      if (loseReply === "cancel") {
        loseReply = undefined
        await route.abort("failed")
      } else await route.fulfill({ json: safeFlow() })
      return
    }
    if (path === "/api/github/connection/disconnect") {
      expect(body).toEqual({ revision, confirm: true })
      save()
      mode = "none"
      flow = undefined
      entries = entries.filter((entry) => entry.name !== "GH_TOKEN")
      await route.fulfill({ json: local() })
      return
    }
    if (path === "/api/runtime-config") {
      await route.fulfill({ json: runtime() })
      return
    }
    if (path.startsWith("/api/runtime-config/")) {
      const name = path.split("/").at(-1) ?? ""
      expect(body.revision).toBe(revision)
      save()
      entries = entries.filter((entry) => entry.name !== name)
      if (req.method() === "PUT") {
        entries.push({
          name,
          kind: body.kind as Entry["kind"],
          ...(body.kind === "secret"
            ? { configured: true as const }
            : { value: body.value as string }),
          revision,
          updatedAt: 2,
        })
      }
      if (name === "GITHUB_OAUTH_CLIENT_ID")
        clientId = req.method() === "PUT" ? (body.value as string) : null
      if (name === "GH_TOKEN") {
        mode = req.method() === "PUT" ? "manual" : "none"
        flow = undefined
      }
      await route.fulfill({ json: runtime() })
      return
    }
    if (path === "/api/apply") {
      applies++
      applied = revision
      status = "applied"
      await route.fulfill({ json: {} })
      return
    }
    const data: Record<string, unknown> = {
      "/api/session": { csrf: "fixture", actor: "42" },
      "/api/settings": { revision, applied, status, policy: basePolicy },
      "/api/inventory": inventory,
      "/api/audit": [],
      "/api/imports": [],
      "/api/chats": [],
      "/api/logout": {},
    }
    await route.fulfill({ json: data[path] ?? {} })
  })
  await page.goto("/?section=Secrets+%26+variables")
  await expect(
    card(page).getByRole("heading", { name: "Connect GitHub", exact: true }),
  ).toBeVisible()
  if (!options.unavailable)
    await expect(
      card(page)
        .getByRole("button", { name: "Edit GitHub Client ID", exact: true })
        .or(card(page).getByRole("button", { name: "Configure GitHub Client ID", exact: true })),
    ).toBeEnabled()
  return {
    calls,
    starts: () => starts,
    completions: () => completions,
    cancellations: () => cancellations,
    statusReads: () => statusReads,
    applies: () => applies,
    completeLocally: () => {
      save()
      mode = "oauth"
      flow = {
        id: "fixture-flow",
        status: "completed",
        expiresAt: Date.now() + 300000,
        receipt: { savedRevision: revision, application: { revision, applied, status } },
      }
    },
    pending: () => {
      flow = {
        id: "fixture-flow",
        status: "pending",
        expiresAt: Date.now() + 600000,
        userCode: code,
        verificationUri: "https://github.com/login/device",
      }
    },
    authorize: () => {
      flow = {
        id: "fixture-flow",
        status: "authorized",
        expiresAt: Date.now() + 600000,
        account: { id: 7, login: "fixture-user" },
        scopes: ["read:org", "repo"],
      }
    },
  }
}
async function start(page: Page, replace = false) {
  await card(page)
    .getByRole("button", { name: /^(Connect|Reconnect) GitHub$/ })
    .click()
  const dialog = page.getByRole("dialog")
  await expect(
    dialog.getByRole("button", { name: "Start GitHub authorization", exact: true }),
  ).toBeDisabled()
  await dialog.getByRole("checkbox", { name: /^I consent to repo/ }).check()
  if (replace) {
    await expect(
      dialog.getByRole("button", { name: "Start GitHub authorization", exact: true }),
    ).toBeDisabled()
    await dialog.getByRole("checkbox", { name: /^Replace the existing GH_TOKEN/ }).check()
  }
  await dialog.getByRole("button", { name: "Start GitHub authorization", exact: true }).click()
}
async function authorize(page: Page, state: Awaited<ReturnType<typeof fixture>>) {
  state.authorize()
  await expect(
    page.getByText("Verified GitHub account: fixture-user (ID 7)", { exact: true }),
  ).toBeVisible()
  await expect(
    page.getByText("Actual granted scopes: read:org, repo.", { exact: true }),
  ).toBeVisible()
  await expect(page.getByText(`GitHub user code: ${code}`, { exact: true })).toHaveCount(0)
}
async function noLeak(page: Page, sentinel = hidden) {
  expect(await page.locator("body").innerHTML()).not.toContain(sentinel)
  expect(
    await page.evaluate(() =>
      JSON.stringify({
        local: { ...localStorage },
        session: { ...sessionStorage },
        url: location.href,
        history: history.state,
      }),
    ),
  ).not.toContain(sentinel)
}

test("safe projections reject malformed fields and omit unknown credentials, errors, and terminal codes", () => {
  const source = {
    revision: 1,
    applied: 1,
    status: "applied",
    secretStatus: "ready",
    mode: "none",
    reconnectRequired: false,
    accessToken: hidden,
    refreshToken: hidden,
    flow: {
      id: "fixture-flow",
      status: "failed",
      expiresAt: 1000,
      userCode: code,
      verificationUri: "https://github.com/login/device",
      error: rawError,
      deviceCode: hidden,
    },
  }
  expect(parseGitHubConnection(source)).toEqual({
    revision: 1,
    applied: 1,
    status: "applied",
    secretStatus: "ready",
    mode: "none",
    reconnectRequired: false,
    flow: { id: "fixture-flow", status: "failed", expiresAt: 1000 },
  })
  for (const invalid of [
    { ...source, applied: 2 },
    { ...source, status: rawError },
    { ...source, clientId: "https://untrusted.test" },
    { ...source, scopes: ["repo", "<script>"] },
    { ...source, account: { id: 1, login: "<script>" } },
    {
      ...source,
      flow: { ...source.flow, verificationUri: "https://github.com/login/device#unsafe" },
    },
    { ...source, flow: { ...source.flow, userCode: hidden } },
  ])
    expect(() => parseGitHubConnection(invalid)).toThrow()
  expect(() => parseGitHubFlow({ ...source.flow, status: "authorized" })).toThrow()
  expect(() =>
    parseGitHubFlow({
      ...source.flow,
      status: "completed",
      receipt: {
        savedRevision: 2,
        application: { revision: 3, applied: 1, status: "failed" },
      },
    }),
  ).toThrow()
})

test("explicit scope and replacement consent, safe code/link, verified account, save once", async ({
  page,
}) => {
  const state = await fixture(page, { mode: "manual" })
  expect(state.starts()).toBe(0)
  await expect(card(page)).toContainText("private-repository read/write access")
  await expect(card(page)).toContainText("Every approved bash chat")
  await expect(page.getByRole("button", { name: "Replace GH_TOKEN", exact: true })).toBeEnabled()
  await page.getByRole("tab", { name: "Variables", exact: true }).click()
  await expect(card(page)).toHaveCount(0)
  await page.getByRole("tab", { name: "Secrets", exact: true }).click()
  await start(page, true)
  await expect(page.getByText(`GitHub user code: ${code}`, { exact: true })).toBeVisible()
  const link = page.getByRole("link", { name: "Open GitHub device authorization", exact: true })
  await expect(link).toHaveAttribute("href", "https://github.com/login/device")
  await expect(link).toHaveAttribute("target", "_blank")
  await expect(link).toHaveAttribute("rel", "noopener noreferrer")
  await expect(
    page.getByRole("button", { name: "Save and apply this account", exact: true }),
  ).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Add secret", exact: true })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Account", exact: true })).toBeEnabled()
  await noLeak(page)
  await noLeak(page, rawError)
  await noLeak(page, "device_code")
  await authorize(page, state)
  await page.getByRole("button", { name: "Save and apply this account", exact: true }).click()
  await expect(card(page).getByLabel("GitHub saved outcome")).toContainText(
    "Saved GitHub revision 2",
  )
  await expect(card(page)).toContainText("GitHub account saved and applied.")
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(
    card(page).getByRole("button", { name: "Reconnect GitHub", exact: true }),
  ).toBeEnabled()
  expect(state.starts()).toBe(1)
  expect(state.completions()).toBe(1)
  expect(state.calls.filter((call) => call.path === "/api/runtime-config/GH_TOKEN")).toEqual([])
  await noLeak(page)
  await noLeak(page, code)
})

test("lost completion recovers saved failed application after a newer revision; retry only apply", async ({
  page,
}) => {
  const state = await fixture(page, { lost: "complete", failedApply: true, newerRevision: true })
  await start(page)
  await authorize(page, state)
  await page.getByRole("button", { name: "Save and apply this account", exact: true }).click()
  const outcome = card(page).getByLabel("GitHub saved outcome")
  await expect(outcome).toContainText("Saved; application failed.")
  await expect(outcome).toContainText("Saved GitHub revision 2")
  await expect(card(page).getByLabel("Current GitHub application state")).toHaveText(
    "Current settings revision 3; applied 1; failed.",
  )
  await expect(page.getByRole("button", { name: "Retry application", exact: true })).toBeEnabled()
  await page.getByRole("button", { name: "Retry application", exact: true }).click()
  await expect.poll(state.applies).toBe(1)
  await expect(card(page).getByLabel("Current GitHub application state")).toHaveText(
    "Current settings revision 3; applied 3; applied.",
  )
  await expect(outcome).toContainText("Saved; application failed.")
  await expect(outcome).toContainText("Saved GitHub revision 2")
  await card(page).getByRole("button", { name: "Reload GitHub status", exact: true }).click()
  await expect(outcome).toBeVisible()
  expect(state.completions()).toBe(1)
  expect(state.starts()).toBe(1)
  await noLeak(page)
  await noLeak(page, code)
})

test("a lost completion that is still settling cannot submit the authorized account again", async ({
  page,
}) => {
  const state = await fixture(page)
  await start(page)
  await authorize(page, state)
  let completions = 0
  await page.route("**/api/github/oauth/fixture-flow/complete", async (route) => {
    completions++
    await route.abort("failed")
  })
  await page.getByRole("button", { name: "Save and apply this account", exact: true }).click()
  await expect(card(page)).toContainText("The save outcome is not confirmed")
  await expect(
    page.getByRole("button", { name: "Save and apply this account", exact: true }),
  ).toBeDisabled()
  state.completeLocally()
  await card(page).getByRole("button", { name: "Reload GitHub status", exact: true }).click()
  await expect(card(page).getByLabel("GitHub saved outcome")).toContainText(
    "Saved GitHub revision 2",
  )
  expect(completions).toBe(1)
  expect(state.starts()).toBe(1)
})

test("a superseded receipt remains saved with an unknown historical application outcome", async ({
  page,
}) => {
  const state = await fixture(page, { lost: "complete", superseded: true })
  await start(page)
  await authorize(page, state)
  await page.getByRole("button", { name: "Save and apply this account", exact: true }).click()
  await expect(card(page).getByLabel("GitHub saved outcome")).toContainText(
    "GitHub account saved; application outcome unknown or superseded.",
  )
  await expect(card(page).getByLabel("GitHub saved outcome")).toContainText(
    "Saved GitHub revision 2",
  )
  await expect(card(page).getByLabel("Current GitHub application state")).toContainText(
    "Current settings revision 3",
  )
  expect(state.completions()).toBe(1)
  await expect(
    page.getByRole("button", { name: "Save and apply this account", exact: true }),
  ).toHaveCount(0)
})

for (const lost of ["start", "status", "cancel"] as const)
  test(`lost ${lost} response recovers local state without automatic restart or save`, async ({
    page,
  }) => {
    const state = await fixture(page, { lost })
    await start(page)
    await expect(page.getByText(`GitHub user code: ${code}`, { exact: true })).toBeVisible()
    if (lost === "status") await authorize(page, state)
    await card(page)
      .getByRole("button", { name: "Cancel GitHub authorization", exact: true })
      .click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(card(page)).toContainText("GitHub authorization cancelled. Nothing was saved.")
    expect(state.starts()).toBe(1)
    expect(state.completions()).toBe(0)
    expect(state.cancellations()).toBe(1)
    await noLeak(page, code)
  })

test("receipt eviction after a lost completion shows unknown history and current local metadata", async ({
  page,
}) => {
  const state = await fixture(page, { lost: "complete", evictReceipt: true })
  await start(page)
  await authorize(page, state)
  await page.getByRole("button", { name: "Save and apply this account", exact: true }).click()
  await expect(card(page)).toContainText("The previous authorization outcome is unknown")
  await expect(card(page)).toContainText("GitHub account: fixture-user")
  await expect(card(page).getByLabel("Current GitHub application state")).toContainText(
    "Current settings revision 2",
  )
  expect(state.completions()).toBe(1)
  expect(state.starts()).toBe(1)
  await noLeak(page, code)
})

test("Escape clears the code and stops local polling while cancellation settles", async ({
  page,
}) => {
  const state = await fixture(page)
  await start(page)
  await expect(page.getByText(`GitHub user code: ${code}`, { exact: true })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect.poll(state.cancellations).toBe(1)
  await expect(card(page)).toContainText("GitHub authorization cancelled")
  const reads = state.statusReads()
  await page.waitForTimeout(1700)
  expect(state.statusReads()).toBe(reads)
  await noLeak(page, code)
})

test("navigation confirmation cancels an active flow; a late status cannot restore it", async ({
  page,
}) => {
  const state = await fixture(page)
  await start(page)
  await expect(page.getByText(`GitHub user code: ${code}`, { exact: true })).toBeVisible()
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let dispatched = false
  await page.route("**/api/github/oauth/fixture-flow", async (route) => {
    dispatched = true
    await gate
    await route.fulfill({
      json: {
        id: "fixture-flow",
        status: "authorized",
        expiresAt: Date.now() + 600000,
        account: { id: 9, login: "late-account" },
        scopes: ["repo", "read:org"],
      },
    })
  })
  await expect.poll(() => dispatched).toBe(true)
  page.once("dialog", (dialog) => dialog.dismiss())
  await navigate(page, "Audit")
  await expect(page.getByText(`GitHub user code: ${code}`, { exact: true })).toBeVisible()
  page.once("dialog", (dialog) => dialog.accept())
  await navigate(page, "Audit")
  release()
  await expect.poll(state.cancellations).toBe(1)
  await expect(page.getByRole("heading", { name: "Audit", exact: true })).toBeVisible()
  await navigate(page, "Secrets & variables")
  await expect(card(page)).toBeVisible()
  await expect(page.getByText(/late-account/)).toHaveCount(0)
  await noLeak(page, code)
  expect(state.completions()).toBe(0)
})

test("local status polling is single-flight even when a response is slow", async ({ page }) => {
  const state = await fixture(page)
  let reads = 0
  let active = 0
  let maximum = 0
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route("**/api/github/oauth/fixture-flow", async (route) => {
    reads++
    active++
    maximum = Math.max(maximum, active)
    if (reads === 1) await gate
    await route.fulfill({
      json: {
        id: "fixture-flow",
        status: "pending",
        expiresAt: Date.now() + 600000,
        userCode: code,
        verificationUri: "https://github.com/login/device",
      },
    })
    active--
  })
  await start(page)
  await expect.poll(() => reads).toBe(1)
  await page.waitForTimeout(3200)
  expect(reads).toBe(1)
  release()
  await expect.poll(() => reads).toBe(2)
  expect(maximum).toBe(1)
  await page.keyboard.press("Escape")
  await expect.poll(state.cancellations).toBe(1)
})

test("late start after navigation is ignored and recovered local authorization is cancelled", async ({
  page,
}) => {
  const state = await fixture(page)
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let dispatched = false
  await page.route("**/api/github/oauth", async (route) => {
    state.pending()
    dispatched = true
    await gate
    await route.fulfill({
      json: {
        id: "fixture-flow",
        status: "pending",
        expiresAt: Date.now() + 600000,
        userCode: code,
        verificationUri: "https://github.com/login/device",
      },
    })
  })
  await start(page)
  await expect.poll(() => dispatched).toBe(true)
  page.once("dialog", (dialog) => dialog.accept())
  await navigate(page, "Audit")
  await expect.poll(state.cancellations).toBe(1)
  release()
  await expect(page.getByRole("heading", { name: "Audit", exact: true })).toBeVisible()
  await noLeak(page, code)
  await navigate(page, "Secrets & variables")
  await expect(card(page)).toContainText("GitHub authorization cancelled")
  await noLeak(page, code)
  expect(state.completions()).toBe(0)
})

test("cancel awaits an in-flight save and reports its committed receipt rather than cancellation", async ({
  page,
}) => {
  const state = await fixture(page, { cancelCommits: true })
  await start(page)
  await authorize(page, state)
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let saves = 0
  await page.route("**/api/github/oauth/fixture-flow/complete", async (route) => {
    saves++
    await gate
    await route.fulfill({
      json: {
        id: "fixture-flow",
        status: "completed",
        expiresAt: Date.now() + 300000,
        receipt: { savedRevision: 2, application: { revision: 2, applied: 2, status: "applied" } },
      },
    })
  })
  await page.getByRole("button", { name: "Save and apply this account", exact: true }).click()
  await expect.poll(() => saves).toBe(1)
  await card(page).getByRole("button", { name: "Cancel GitHub authorization", exact: true }).click()
  await expect(card(page).getByLabel("GitHub saved outcome")).toContainText(
    "GitHub account saved and applied.",
  )
  release()
  await expect(card(page)).not.toContainText("Nothing was saved")
  expect(saves).toBe(1)
  expect(state.cancellations()).toBe(1)
  await noLeak(page, code)
})

test("tab and Back navigation guard pending authorization without retaining a code", async ({
  page,
}) => {
  const state = await fixture(page)
  await navigate(page, "Audit")
  await navigate(page, "Secrets & variables")
  await start(page)
  await expect(page.getByText(`GitHub user code: ${code}`, { exact: true })).toBeVisible()
  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("tab", { name: "Variables", exact: true }).click()
  await expect.poll(state.cancellations).toBe(1)
  await expect(card(page)).toHaveCount(0)
  await page.getByRole("tab", { name: "Secrets", exact: true }).click()
  await start(page)
  await expect(page.getByText(`GitHub user code: ${code}`, { exact: true })).toBeVisible()
  page.once("dialog", (dialog) => dialog.accept())
  await page.goBack()
  await expect(page.getByRole("heading", { name: "Audit", exact: true })).toBeVisible()
  await expect.poll(state.cancellations).toBe(2)
  await noLeak(page, code)
})

test("sign-out and session expiry cannot restore a pending authorization", async ({ page }) => {
  let state = await fixture(page)
  await start(page)
  await expect(page.getByText(`GitHub user code: ${code}`, { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Account", exact: true }).click()
  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Sign in with passkey", exact: true }),
  ).toBeVisible()
  await noLeak(page, code)
  await expect.poll(state.cancellations).toBe(1)
  await page.unrouteAll({ behavior: "wait" })
  state = await fixture(page, { expiredStatus: true })
  await start(page)
  await expect(
    page.getByRole("button", { name: "Sign in with passkey", exact: true }),
  ).toBeVisible()
  await noLeak(page, code)
  expect(state.completions()).toBe(0)
})

test("public Client ID setup uses normal revision/apply, draft guards, and retained PAT controls", async ({
  page,
}) => {
  const state = await fixture(page, { clientId: null, mode: "manual" })
  await expect(
    card(page).getByRole("button", { name: "Connect GitHub", exact: true }),
  ).toBeDisabled()
  await card(page).getByRole("button", { name: "Configure GitHub Client ID", exact: true }).click()
  await expect(page.getByLabel("Public GitHub OAuth Client ID", { exact: true })).toBeFocused()
  await page.getByLabel("Public GitHub OAuth Client ID", { exact: true }).fill("discarded-client")
  page.once("dialog", (dialog) => dialog.dismiss())
  await page.getByRole("tab", { name: "Variables", exact: true }).click()
  await expect(page.getByLabel("Public GitHub OAuth Client ID", { exact: true })).toHaveValue(
    "discarded-client",
  )
  await page.getByLabel("Public GitHub OAuth Client ID", { exact: true }).press("Escape")
  await expect(page.getByLabel("Public GitHub OAuth Client ID", { exact: true })).toHaveCount(0)
  await card(page).getByRole("button", { name: "Configure GitHub Client ID", exact: true }).click()
  await page.getByLabel("Public GitHub OAuth Client ID", { exact: true }).fill("Ov23public")
  await page.getByRole("button", { name: "Save GitHub Client ID", exact: true }).click()
  await expect(
    card(page).getByRole("button", { name: "Connect GitHub", exact: true }),
  ).toBeEnabled()
  expect(
    state.calls.filter((call) => call.path === "/api/runtime-config/GITHUB_OAUTH_CLIENT_ID"),
  ).toEqual([
    {
      path: "/api/runtime-config/GITHUB_OAUTH_CLIENT_ID",
      method: "PUT",
      body: { revision: 1, kind: "variable", value: "Ov23public" },
    },
  ])
  expect(state.starts()).toBe(0)
  await page.getByRole("button", { name: "Replace GH_TOKEN", exact: true }).click()
  await expect(page.getByLabel("Runtime secret value", { exact: true })).toHaveValue("")
  await page.getByLabel("Runtime secret value", { exact: true }).fill("manual-pat-sentinel")
  await page.getByRole("button", { name: "Save secret", exact: true }).click()
  await expect(page.getByRole("button", { name: "Delete GH_TOKEN", exact: true })).toBeEnabled()
  await page.getByRole("button", { name: "Delete GH_TOKEN", exact: true }).click()
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Delete and apply", exact: true })
    .click()
  await expect(page.getByRole("button", { name: "Replace GH_TOKEN", exact: true })).toHaveCount(0)
  await noLeak(page, "manual-pat-sentinel")
})

test("Client ID saved with failed application retries only the root application operation", async ({
  page,
}) => {
  const state = await fixture(page, { clientId: null, failedApply: true })
  await card(page).getByRole("button", { name: "Configure GitHub Client ID", exact: true }).click()
  await page.getByLabel("Public GitHub OAuth Client ID", { exact: true }).fill("Ov23public")
  await page.getByRole("button", { name: "Save GitHub Client ID", exact: true }).click()
  await expect(card(page)).toContainText("Client ID saved; application failed")
  await expect(page.getByLabel("Public GitHub OAuth Client ID", { exact: true })).toHaveCount(0)
  await expect(
    card(page).getByRole("button", { name: "Connect GitHub", exact: true }),
  ).toBeDisabled()
  await page.getByRole("button", { name: "Retry application", exact: true }).click()
  await expect.poll(state.applies).toBe(1)
  await expect(
    card(page).getByRole("button", { name: "Connect GitHub", exact: true }),
  ).toBeEnabled()
  expect(
    state.calls.filter((call) => call.path === "/api/runtime-config/GITHUB_OAUTH_CLIENT_ID"),
  ).toHaveLength(1)
  expect(
    state.calls.filter((call) => call.path === "/api/github/connection" && call.method === "GET"),
  ).toHaveLength(2)
  expect(state.starts()).toBe(0)
})

for (const mode of ["oauth", "invalid"] as const)
  test(`${mode}: reconnect or reset requires explicit paired deletion confirmation`, async ({
    page,
  }) => {
    const state = await fixture(page, { mode })
    const reset = mode === "invalid"
    if (!reset) {
      await start(page, true)
      await expect(page.getByText(`GitHub user code: ${code}`, { exact: true })).toBeVisible()
      await page.keyboard.press("Escape")
      await expect.poll(state.cancellations).toBe(1)
    } else await expect(card(page)).toContainText("Reconnect required")
    await card(page)
      .getByRole("button", {
        name: reset ? "Reset GitHub connection" : "Disconnect GitHub",
        exact: true,
      })
      .click()
    const dialog = page.getByRole("alertdialog")
    await expect(dialog).toContainText("GH_TOKEN and GITHUB_OAUTH_STATE")
    await expect(dialog).toContainText("orphaned or colliding state")
    await expect(dialog).toContainText("does not revoke GitHub authorization")
    await dialog.getByRole("button", { name: "Keep GitHub connection", exact: true }).click()
    expect(state.calls.filter((call) => call.path.endsWith("/disconnect"))).toHaveLength(0)
    await card(page)
      .getByRole("button", {
        name: reset ? "Reset GitHub connection" : "Disconnect GitHub",
        exact: true,
      })
      .click()
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Delete both entries and apply", exact: true })
      .click()
    await expect(card(page)).toContainText("No GitHub credential configured.")
    expect(state.calls.filter((call) => call.path.endsWith("/disconnect"))).toHaveLength(1)
    await noLeak(page)
  })

for (const unsafeLink of [
  "https://github.com/login/device?code=untrusted",
  "https://github.com.evil.test/login/device",
  "javascript:alert(1)",
  "https://name:password@github.com/login/device",
])
  test(`reject unsafe verification link ${unsafeLink}`, async ({ page }) => {
    const state = await fixture(page, { unsafeLink })
    await start(page)
    await expect(page.getByRole("alert")).toContainText("GitHub outcome is unknown")
    await expect(
      page.getByRole("link", { name: "Open GitHub device authorization", exact: true }),
    ).toHaveCount(0)
    await noLeak(page, code)
    await noLeak(page, unsafeLink)
    expect(state.completions()).toBe(0)
    expect(state.starts()).toBe(1)
  })

test("unknown credential fields and raw errors never enter DOM, review, storage, or URLs", async ({
  page,
}) => {
  const state = await fixture(page, { failedFlow: true })
  await start(page)
  await expect(
    card(page).getByText(
      "GitHub authorization failed. Reload local status before another action.",
      { exact: true },
    ),
  ).toBeVisible()
  await noLeak(page)
  await noLeak(page, rawError)
  await noLeak(page, code)
  expect(state.completions()).toBe(0)
  await expect(page.locator("script").filter({ hasText: hidden })).toHaveCount(0)
})

test("invalid verified account cannot be saved or rendered as markup", async ({ page }) => {
  const state = await fixture(page, { invalidAccount: true })
  await start(page)
  state.authorize()
  await expect(page.getByRole("alert")).toContainText("GitHub outcome is unknown")
  await expect(
    page.getByRole("button", { name: "Save and apply this account", exact: true }),
  ).toHaveCount(0)
  await expect(page.locator('img[src="x"]')).toHaveCount(0)
  await noLeak(page, "<img src=x>")
  expect(state.completions()).toBe(0)
})

test("missing optional API shows unavailable GitHub without blocking generic secrets", async ({
  page,
}) => {
  const state = await fixture(page, { unavailable: true })
  await expect(card(page)).toContainText(
    "GitHub connection is unavailable. Manual GH_TOKEN controls remain available.",
  )
  await expect(page.getByRole("button", { name: "Add secret", exact: true })).toBeEnabled()
  await page.getByRole("button", { name: "Add secret", exact: true }).click()
  await page.getByLabel("Name", { exact: true }).fill("GH_TOKEN")
  await page.getByLabel("Runtime secret value", { exact: true }).fill("retained-manual-pat")
  await page.getByRole("button", { name: "Save secret", exact: true }).click()
  await expect(page.getByRole("button", { name: "Replace GH_TOKEN", exact: true })).toBeEnabled()
  expect(state.starts()).toBe(0)
  await noLeak(page, "retained-manual-pat")
})

test("keyboard authorization and cancellation fit a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const state = await fixture(page)
  const connect = card(page).getByRole("button", { name: "Connect GitHub", exact: true })
  await connect.focus()
  await page.keyboard.press("Enter")
  const consent = page.getByRole("dialog").getByRole("checkbox", { name: /^I consent to repo/ })
  await consent.focus()
  await page.keyboard.press("Space")
  await page.keyboard.press("Tab")
  await expect(
    page.getByRole("button", { name: "Start GitHub authorization", exact: true }),
  ).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(page.getByText(`GitHub user code: ${code}`, { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByRole("link", { name: "Open GitHub device authorization", exact: true }).focus()
  await page.keyboard.press("Tab")
  await expect(
    card(page).getByRole("button", { name: "Cancel GitHub authorization", exact: true }),
  ).toBeFocused()
  await page.keyboard.press("Enter")
  await expect.poll(state.cancellations).toBe(1)
  await noLeak(page, code)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
