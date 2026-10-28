import { expect, type Page, test } from "@playwright/test"
import { basePolicy, inventory, navigate, openDisclosure } from "./admin-fixture.js"

type Entry = {
  name: string
  kind: "secret" | "variable"
  value?: string
  configured?: true
  updatedAt: number
  revision: number
}
async function fixture(
  page: Page,
  options: {
    secretStatus?: string
    mode?: "conflict" | "unknown" | "failed" | "expired"
    session?: number
  } = {},
) {
  let revision = 1
  let applied = 1
  let status = "applied"
  let entries: Entry[] = [
    { name: "EXISTING", kind: "secret", configured: true, updatedAt: 1790000000000, revision: 1 },
  ]
  const mutations: { method: string; name: string; body: Record<string, unknown> }[] = []
  let applies = 0
  const response = () => ({
    revision,
    applied,
    status,
    secretStatus: options.secretStatus ?? "ready",
    entries,
  })
  await page.route("**/api/**", async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    if (url.pathname === "/api/session") {
      await route.fulfill({
        status: options.session ?? 200,
        json: options.session
          ? { error: "Administrator access required" }
          : { csrf: "fixture", actor: "42" },
      })
      return
    }
    if (url.pathname === "/api/runtime-config") {
      await route.fulfill({ json: response() })
      return
    }
    if (url.pathname.startsWith("/api/runtime-config/")) {
      const name = decodeURIComponent(url.pathname.split("/").at(-1) ?? "")
      const body = req.postDataJSON() as Record<string, unknown>
      mutations.push({ method: req.method(), name, body })
      expect(req.headers()["x-csrf-token"]).toBe("fixture")
      if (options.mode === "conflict") {
        await route.fulfill({ status: 409, json: { error: "Revision conflict" } })
        return
      }
      if (options.mode === "unknown") {
        revision++
        applied = revision
        entries.push({ name, kind: "secret", configured: true, updatedAt: 1790000001000, revision })
        await route.abort("failed")
        return
      }
      if (options.mode === "expired") {
        await route.fulfill({ status: 401, json: { error: "Expired" } })
        return
      }
      revision++
      status = options.mode === "failed" ? "failed" : "applied"
      if (status === "applied") applied = revision
      entries = entries.filter((entry) => entry.name !== name)
      if (req.method() === "PUT")
        entries.push({
          name,
          kind: body.kind as Entry["kind"],
          ...(body.kind === "secret"
            ? { configured: true as const }
            : { value: body.value as string }),
          updatedAt: 1790000001000,
          revision,
        })
      await route.fulfill({ json: response() })
      return
    }
    if (url.pathname === "/api/apply") {
      applies++
      applied = revision
      status = "applied"
      await route.fulfill({ json: {} })
      return
    }
    const data: Record<string, unknown> = {
      "/api/settings": { revision, applied, status, policy: basePolicy },
      "/api/inventory": inventory,
      "/api/audit": [],
      "/api/imports": [],
      "/api/chats": [],
      "/api/logout": {},
    }
    await route.fulfill({ json: data[url.pathname] ?? {} })
  })
  await page.goto("/?section=Secrets+%26+variables")
  if (!options.session)
    await expect(page.getByRole("button", { name: "Add secret", exact: true })).toBeVisible()
  return { mutations, applies: () => applies }
}
async function add(page: Page, kind: "secret" | "variable", name: string, value: string) {
  if (kind === "variable") await page.getByRole("tab", { name: "Variables", exact: true }).click()
  await page.getByRole("button", { name: `Add ${kind}`, exact: true }).click()
  await page.getByLabel("Name", { exact: true }).fill(name)
  await page
    .getByLabel(kind === "secret" ? "Runtime secret value" : "Variable value", { exact: true })
    .fill(value)
}
async function noLeak(page: Page, sentinel: string) {
  expect(
    await page.evaluate(() => {
      const body = document.body.cloneNode(true) as HTMLElement
      for (const input of body.querySelectorAll('input[type="password"]')) input.remove()
      return body.innerHTML
    }),
  ).not.toContain(sentinel)
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

test("secret CRUD is write-only, replacements are empty, search and confirmed deletion", async ({
  page,
}) => {
  const state = await fixture(page)
  await expect(page.getByText("Configured · ••••••••", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Replace EXISTING", exact: true }).click()
  await expect(page.getByLabel("Runtime secret value")).toHaveValue("")
  await expect(page.getByLabel("Runtime secret value")).toHaveAttribute("type", "password")
  await expect(page.getByRole("button", { name: "Save secret", exact: true })).toBeDisabled()
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  const sentinel = "sentinel-not-visible-123"
  await add(page, "secret", "NEW_TOKEN", sentinel)
  await noLeak(page, sentinel)
  await page.getByRole("button", { name: "Save secret", exact: true }).click()
  await expect(page.getByRole("button", { name: "Replace NEW_TOKEN", exact: true })).toBeVisible()
  await expect(page.getByLabel("Runtime secret value")).toHaveCount(0)
  await noLeak(page, sentinel)
  expect(state.mutations[0]?.body).toEqual({ revision: 1, kind: "secret", value: sentinel })
  await page.getByLabel("Search names").fill("new")
  await expect(page.getByRole("button", { name: "Replace EXISTING", exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "Replace NEW_TOKEN", exact: true }).click()
  await expect(page.getByLabel("Runtime secret value")).toHaveValue("")
  await page.getByLabel("Runtime secret value").fill("replacement-not-visible")
  await page.getByRole("button", { name: "Save secret", exact: true }).click()
  await expect(page.getByRole("button", { name: "Delete NEW_TOKEN", exact: true })).toBeEnabled()
  await page.getByRole("button", { name: "Delete NEW_TOKEN", exact: true }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel", exact: true }).click()
  expect(state.mutations).toHaveLength(2)
  await expect(page.getByRole("button", { name: "Add secret", exact: true })).toBeFocused()
  await page.getByRole("button", { name: "Delete NEW_TOKEN", exact: true }).click()
  await page.getByRole("button", { name: "Delete and apply", exact: true }).click()
  await expect(page.getByRole("button", { name: "Replace NEW_TOKEN", exact: true })).toHaveCount(0)
  expect(state.mutations.at(-1)?.body).toEqual({ revision: 3 })
  await expect(page.getByRole("button", { name: /reveal|copy|export|download/i })).toHaveCount(0)
})

test("GH_TOKEN uses existing secret controls without exposing tokens or starting authentication", async ({
  page,
}) => {
  const state = await fixture(page)
  const url = page.url()
  const navigations: string[] = []
  let popups = 0
  page.on("framenavigated", (frame) => navigations.push(frame.url()))
  page.on("popup", () => popups++)
  const guidance = page.getByText(/^For GitHub CLI,/)
  await expect(guidance).toHaveText(
    "For GitHub CLI, create a secret named GH_TOKEN with a GitHub.com Personal Access Token. Once saved and applied, the token is available to the next bash execution without restart. All chats with bash access can use and read the token; give bash only to trusted chats. Configured state does not prove that GitHub accepts the token.",
  )
  await expect(page.getByRole("tabpanel").getByRole("button")).toHaveText([
    "Add secret",
    "Reload safe metadata",
    "Replace EXISTING",
    "Delete EXISTING",
  ])
  await expect(page.getByRole("tabpanel").getByRole("link")).toHaveCount(0)
  await page.getByRole("tab", { name: "Variables", exact: true }).click()
  await expect(guidance).toHaveCount(0)
  await page.getByRole("tab", { name: "Secrets", exact: true }).click()
  await expect(guidance).toBeVisible()

  const tokens = ["github-create-sentinel", "github-replace-sentinel"]
  for (const [index, token] of tokens.entries()) {
    if (index === 0) await add(page, "secret", "GH_TOKEN", token)
    else {
      await page.getByRole("button", { name: "Replace GH_TOKEN", exact: true }).click()
      await expect(page.getByLabel("Runtime secret value")).toHaveValue("")
      await expect(page.getByLabel("Name", { exact: true })).toBeDisabled()
      await page.getByLabel("Runtime secret value").fill(token)
    }
    await expect(page.getByLabel("Runtime secret value")).toHaveAttribute("type", "password")
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await noLeak(page, token)
    const response = page.waitForResponse("**/api/runtime-config/GH_TOKEN")
    await page.getByRole("button", { name: "Save secret", exact: true }).click()
    const metadata: { entries: Entry[] } = await (await response).json()
    expect(metadata.entries.find((entry) => entry.name === "GH_TOKEN")).toEqual({
      name: "GH_TOKEN",
      kind: "secret",
      configured: true,
      updatedAt: 1790000001000,
      revision: index + 2,
    })
    await expect(page.getByText("Saved and applied.", { exact: true })).toBeVisible()
    await expect(page.getByRole("region", { name: "GH_TOKEN secret", exact: true })).toContainText(
      "Configured · ••••••••",
    )
    await expect(page.getByLabel("Runtime secret value")).toHaveCount(0)
    for (const sentinel of tokens) {
      expect(JSON.stringify(metadata)).not.toContain(sentinel)
      await noLeak(page, sentinel)
    }
  }

  await page.getByRole("button", { name: "Delete GH_TOKEN", exact: true }).click()
  const dialog = page.getByRole("alertdialog", { name: "Delete GH_TOKEN?", exact: true })
  await expect(dialog).toBeVisible()
  const response = page.waitForResponse("**/api/runtime-config/GH_TOKEN")
  await dialog.getByRole("button", { name: "Delete and apply", exact: true }).click()
  const metadata: { entries: Entry[] } = await (await response).json()
  expect(metadata.entries.some((entry) => entry.name === "GH_TOKEN")).toBe(false)
  await expect(page.getByRole("button", { name: "Replace GH_TOKEN", exact: true })).toHaveCount(0)
  for (const token of tokens) {
    expect(JSON.stringify(metadata)).not.toContain(token)
    await noLeak(page, token)
  }
  expect(state.mutations).toEqual([
    { method: "PUT", name: "GH_TOKEN", body: { revision: 1, kind: "secret", value: tokens[0] } },
    { method: "PUT", name: "GH_TOKEN", body: { revision: 2, kind: "secret", value: tokens[1] } },
    { method: "DELETE", name: "GH_TOKEN", body: { revision: 3 } },
  ])
  expect(state.applies()).toBe(0)
  await expect(page).toHaveURL(url)
  expect(navigations).toEqual([])
  expect(popups).toBe(0)
})

test("variables preserve escaped values and empty edits without changing permissions", async ({
  page,
}) => {
  const state = await fixture(page)
  await add(page, "variable", "PUBLIC", " <script>alert('x')</script> & \n ")
  await expect(page.getByText(/Authorized chats with read_variable/)).toBeVisible()
  await page.getByRole("button", { name: "Save variable", exact: true }).click()
  await expect(page.locator(".runtime-variable-value")).toHaveText("<script>alert('x')</script> &")
  await expect(page.locator(".runtime-variable-value script")).toHaveCount(0)
  await page.getByRole("button", { name: "Edit PUBLIC", exact: true }).click()
  await page.getByLabel("Variable value").fill("")
  await page.getByRole("button", { name: "Save variable", exact: true }).click()
  await expect(page.getByRole("button", { name: "Edit PUBLIC", exact: true })).toBeEnabled()
  expect(state.mutations.at(-1)?.body).toEqual({ revision: 2, kind: "variable", value: "" })
  await page.getByRole("button", { name: "Delete PUBLIC", exact: true }).click()
  await expect(page.getByRole("alertdialog")).toContainText("Delete this variable")
  await page.getByRole("button", { name: "Delete and apply", exact: true }).click()
  await expect(page.getByRole("button", { name: "Edit PUBLIC", exact: true })).toHaveCount(0)
  expect(state.mutations.at(-1)?.body).toEqual({ revision: 3 })
  expect(state.mutations.every((mutation) => !("policy" in mutation.body))).toBe(true)
})

for (const mode of ["conflict", "unknown"] as const)
  test(`${mode}: no automatic resubmission; explicit metadata reload discards the draft`, async ({
    page,
  }) => {
    const state = await fixture(page, { mode })
    await add(page, "secret", "TOKEN", "uncertain-secret")
    await page.getByRole("button", { name: "Save secret", exact: true }).click()
    await expect(page.getByRole("alert")).toContainText("No automatic retry")
    await expect(page.getByRole("alert")).toBeFocused()
    await expect(page.getByRole("button", { name: "Save secret", exact: true })).toBeDisabled()
    expect(state.mutations).toHaveLength(1)
    page.once("dialog", (dialog) => dialog.accept())
    await page.getByRole("button", { name: "Reload safe metadata", exact: true }).click()
    await expect(page.getByLabel("Runtime secret value")).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Add secret", exact: true })).toBeEnabled()
    expect(state.mutations).toHaveLength(1)
    if (mode === "unknown")
      await expect(page.getByRole("button", { name: "Replace TOKEN", exact: true })).toBeVisible()
    await noLeak(page, "uncertain-secret")
  })

test("saved but application failed clears secret and retries only application", async ({
  page,
}) => {
  const state = await fixture(page, { mode: "failed" })
  await add(page, "secret", "TOKEN", "saved-failed-secret")
  await page.getByRole("button", { name: "Save secret", exact: true }).click()
  await expect(page.getByText(/Saved; application failed/)).toBeVisible()
  await expect(page.getByLabel("Runtime secret value")).toHaveCount(0)
  await page.getByRole("button", { name: "Retry application", exact: true }).click()
  await expect.poll(state.applies).toBe(1)
  expect(state.mutations).toHaveLength(1)
  await noLeak(page, "saved-failed-secret")
})

test("navigation, tab changes, signout and session expiry clear drafts", async ({ page }) => {
  await fixture(page)
  await add(page, "secret", "TOKEN", "navigation-secret")
  page.once("dialog", (dialog) => dialog.dismiss())
  await navigate(page, "Audit")
  await expect(page.getByLabel("Runtime secret value")).toHaveValue("navigation-secret")
  page.once("dialog", (dialog) => dialog.accept())
  await navigate(page, "Audit")
  await expect(page.getByRole("heading", { name: "Audit", exact: true })).toBeFocused()
  await navigate(page, "Secrets & variables")
  await page.getByRole("button", { name: "Add secret", exact: true }).click()
  await expect(page.getByLabel("Runtime secret value")).toHaveValue("")
  await page.getByLabel("Runtime secret value").fill("tab-secret")
  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("tab", { name: "Variables", exact: true }).click()
  await noLeak(page, "tab-secret")
  await page.getByRole("tab", { name: "Secrets", exact: true }).click()
  await add(page, "secret", "TOKEN", "signout-secret")
  await page.getByRole("button", { name: "Account", exact: true }).click()
  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Sign in with passkey", exact: true }),
  ).toBeVisible()
  await noLeak(page, "signout-secret")
})

test("expired mutation unmounts secret drafts", async ({ page }) => {
  const state = await fixture(page, { mode: "expired" })
  await add(page, "secret", "TOKEN", "expiry-secret")
  await page.getByRole("button", { name: "Save secret", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Sign in with passkey", exact: true }),
  ).toBeVisible()
  await noLeak(page, "expiry-secret")
  expect(state.mutations).toHaveLength(1)
})

for (const secretStatus of ["unavailable", "locked"])
  test(`${secretStatus} secrets keep variables available on mobile`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await fixture(page, { secretStatus })
    await expect(page.getByRole("button", { name: "Add secret", exact: true })).toBeDisabled()
    await expect(page.getByText(/trusted host configuration/)).toBeVisible()
    await expect(page.getByText(/trusted host configuration/)).toContainText("ENCRYPTION_KEY")
    await add(page, "variable", "MOBILE", "public")
    await page.getByRole("button", { name: "Save variable", exact: true }).click()
    await expect(page.getByRole("button", { name: "Edit MOBILE", exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })

test("unauthenticated and forbidden sessions expose no management controls", async ({ page }) => {
  for (const session of [401, 403]) {
    await fixture(page, { session })
    await expect(
      page.getByRole("button", { name: "Sign in with passkey", exact: true }),
    ).toBeVisible()
    await expect(page.getByRole("button", { name: "Add secret", exact: true })).toHaveCount(0)
  }
})

test("kind conversion cannot expose a saved secret as a variable", async ({ page }) => {
  const state = await fixture(page)
  await add(page, "variable", "EXISTING", "not-a-secret-copy")
  await page.getByRole("button", { name: "Save variable", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("To change its kind, delete it first")
  expect(state.mutations).toHaveLength(0)
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(page.getByRole("button", { name: "Add variable", exact: true })).toBeFocused()
})

test("a late committed response after signout cannot restore the draft or session", async ({
  page,
}) => {
  await fixture(page)
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let dispatched = false
  await page.route("**/api/runtime-config/TOKEN", async (route) => {
    dispatched = true
    await gate
    await route.fulfill({
      json: {
        revision: 2,
        applied: 2,
        status: "applied",
        secretStatus: "ready",
        entries: [
          {
            name: "TOKEN",
            kind: "secret",
            configured: true,
            updatedAt: 1790000001000,
            revision: 2,
          },
        ],
      },
    })
  })
  await add(page, "secret", "TOKEN", "late-session-secret")
  await page.getByRole("button", { name: "Save secret", exact: true }).click()
  await expect.poll(() => dispatched).toBe(true)
  await page.getByRole("button", { name: "Account", exact: true }).click()
  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Sign in with passkey", exact: true }),
  ).toBeVisible()
  const response = page.waitForResponse("**/api/runtime-config/TOKEN")
  release()
  await response
  await expect(page.getByLabel("Runtime secret value")).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "Sign in with passkey", exact: true }),
  ).toBeVisible()
  await noLeak(page, "late-session-secret")
})

test("pending MCP draft blocks runtime mutation; stored-reference editor stages names only", async ({
  page,
}) => {
  await fixture(page)
  await navigate(page, "MCP connections")
  await page.getByRole("button", { name: "Add connection", exact: true }).click()
  await page.getByLabel("MCP server name", { exact: true }).fill("reference-server")
  await openDisclosure(page, "Stored references (recommended)")
  await page.getByLabel("Binding field name", { exact: true }).fill("Authorization")
  await page.getByRole("button", { name: "Load stored names", exact: true }).click()
  await page.getByLabel("Stored name", { exact: true }).fill("EXISTING")
  await page.getByLabel("Literal prefix (not a secret)", { exact: true }).fill("Bearer ")
  await page.getByRole("button", { name: "Stage stored reference", exact: true }).click()
  await navigate(page, "Secrets & variables")
  await expect(page.getByText(/Save or discard pending policy, MCP/)).toBeVisible()
  await expect(page.getByRole("button", { name: "Add secret", exact: true })).toBeDisabled()
})
