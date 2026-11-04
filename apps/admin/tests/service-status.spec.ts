import { expect, type Page, test } from "@playwright/test"
import { navigate, openDisclosure } from "./admin-fixture.js"
import { policyRecoveryFixture } from "./policy-recovery-fixture.js"

async function statusFixture(page: Page) {
  const fixture = await policyRecoveryFixture(page)
  const chats = [
    ...Array.from({ length: 100 }, (_, index) => ({
      id: 1000 + index,
      name: `Private recipient ${index}`,
      type: "private",
    })),
    { id: -100500, name: "Beyond page group", type: "supergroup" },
    { id: -100600, name: "Release channel", type: "channel" },
    { id: 4242, name: "Remote private", type: "private" },
  ]
  const searches: URLSearchParams[] = []
  await page.route("**/api/chats?*", async (route) => {
    expect(route.request().method()).toBe("GET")
    const params = new URL(route.request().url()).searchParams
    searches.push(params)
    const id = params.get("id")
    const query = (params.get("q") ?? "").toLowerCase()
    const offset = Number(params.get("offset") ?? 0)
    const matches = chats.filter((chat) =>
      id
        ? String(chat.id) === id
        : chat.name.toLowerCase().includes(query) || String(chat.id) === query,
    )
    await route.fulfill({ json: matches.slice(offset, offset + 100) })
  })
  await navigate(page, "Service status")
  const directory = page.getByRole("region", {
    name: "Stored notification destinations",
    exact: true,
  })
  await expect(
    directory.getByRole("checkbox", {
      name: "Send status notifications to Private recipient 0 · 1000",
      exact: true,
    }),
  ).toBeVisible()
  return { ...fixture, directory, searches }
}

async function review(page: Page) {
  await page.getByRole("button", { name: "Review and save changes", exact: true }).click()
  return page.getByRole("alertdialog", { name: "Save settings changes?", exact: true })
}

async function save(page: Page) {
  const dialog = await review(page)
  await dialog.getByRole("button", { name: "Save changes", exact: true }).click()
}

test("multi-chat service settings use paginated server search and revisioned review/save/reload", async ({
  page,
}) => {
  const fixture = await statusFixture(page)
  const before = structuredClone(fixture.snapshot().policy)
  const mutations: { path: string; method: string; csrf?: string }[] = []
  page.on("request", (request) => {
    if (request.method() !== "GET")
      mutations.push({
        path: new URL(request.url()).pathname,
        method: request.method(),
        csrf: request.headers()["x-csrf-token"],
      })
  })
  const selected = page.getByRole("list", { name: "Selected destinations", exact: true })
  await page
    .getByRole("checkbox", { name: "Enable service status notifications", exact: true })
    .check()
  await expect(page.getByRole("alert")).toContainText("No notifications will be sent.")
  await fixture.directory
    .getByRole("checkbox", {
      name: "Send status notifications to Private recipient 0 · 1000",
      exact: true,
    })
    .check()
  await expect(page.getByText("No notifications will be sent.", { exact: false })).toHaveCount(0)
  await fixture.directory.getByRole("button", { name: "Next chats", exact: true }).click()
  await fixture.directory
    .getByRole("checkbox", {
      name: "Send status notifications to Beyond page group · -100500",
      exact: true,
    })
    .check()
  await fixture.directory
    .getByRole("checkbox", {
      name: "Send status notifications to Release channel · -100600",
      exact: true,
    })
    .check()
  await expect(selected).toContainText("Private recipient 0")
  await expect(selected).toContainText("Beyond page group")
  await fixture.directory
    .getByRole("textbox", { name: "Search stored chats", exact: true })
    .fill("Remote private")
  await fixture.directory
    .getByRole("checkbox", {
      name: "Send status notifications to Remote private · 4242",
      exact: true,
    })
    .check()
  await fixture.directory
    .getByRole("textbox", { name: "Search stored chats", exact: true })
    .fill("not in directory")
  await expect(
    fixture.directory.getByText("No stored chats match this search.", { exact: true }),
  ).toBeVisible()
  for (const name of [
    "Private recipient 0",
    "Beyond page group",
    "Release channel",
    "Remote private",
  ])
    await expect(selected).toContainText(name)
  expect(fixture.searches.some((params) => params.get("offset") === "100")).toBe(true)
  expect(
    fixture.searches.some(
      (params) => params.get("q") === "Remote private" && params.get("offset") === "0",
    ),
  ).toBe(true)

  await page.getByRole("checkbox", { name: "OpenAI", exact: true }).uncheck()
  await page.getByRole("checkbox", { name: "Cloudflare", exact: true }).uncheck()
  await page.getByRole("combobox", { name: "Polling interval", exact: true }).click()
  await page.getByRole("option", { name: "300 seconds", exact: true }).click()
  await page.getByRole("combobox", { name: "Minimum impact", exact: true }).click()
  await page.getByRole("option", { name: "Major", exact: true }).click()
  await page.getByRole("checkbox", { name: "Notify incident updates", exact: true }).uncheck()
  await page.getByRole("checkbox", { name: "Notify resolved incidents", exact: true }).uncheck()
  await expect(
    page.getByRole("checkbox", { name: "Include scheduled maintenance", exact: true }),
  ).not.toBeChecked()
  await page.getByRole("checkbox", { name: "Include scheduled maintenance", exact: true }).check()

  const dialog = await review(page)
  await expect(dialog).toContainText("Service status: add destination -100500")
  await expect(dialog).toContainText("Service status: remove service OpenAI")
  await expect(dialog).toContainText("Service status: polling interval 60 seconds → 300 seconds")
  await expect(dialog).toContainText("Service status: minimum impact minor → major")
  await expect(dialog).toContainText("does not grant Pi access")
  expect(fixture.writes).toHaveLength(0)
  await dialog
    .getByRole("listitem")
    .filter({ hasText: "Service status: remove service OpenAI" })
    .getByRole("button", { name: "Review Service status", exact: true })
    .click()
  await expect(page.locator("#status-notification-services")).toBeFocused()
  await save(page)
  await expect(page.locator('#save-status[data-compact="true"]')).toBeVisible()
  expect(fixture.writes).toHaveLength(1)
  expect(fixture.writes[0]?.revision).toBe(1)
  expect(fixture.snapshot().policy.statusNotifications).toEqual({
    enabled: true,
    providers: ["github", "claude"],
    chatIds: [1000, -100500, -100600, 4242],
    pollIntervalSeconds: 300,
    minimumImpact: "major",
    componentSelections: {},
    quietHours: null,
    batchWindowSeconds: 0,
    chatOverrides: {},
    notifyUpdates: false,
    notifyResolved: false,
    includeMaintenance: true,
  })
  expect(fixture.snapshot().policy.privateUsers).toEqual(before.privateUsers)
  expect(fixture.snapshot().policy.groups).toEqual(before.groups)
  expect(fixture.snapshot().policy.tools).toEqual(before.tools)
  expect(fixture.snapshot().policy.chats).toEqual(before.chats)
  expect(mutations).toEqual([{ path: "/api/settings", method: "PUT", csrf: "fixture" }])

  await page.reload()
  await expect(page.getByRole("heading", { name: "Service status", exact: true })).toBeVisible()
  await expect(
    page.getByRole("checkbox", { name: "Enable service status notifications", exact: true }),
  ).toBeChecked()
  await expect(page.getByRole("checkbox", { name: "OpenAI", exact: true })).not.toBeChecked()
  await expect(page.getByRole("checkbox", { name: "Claude", exact: true })).toBeChecked()
  await expect(page.getByRole("combobox", { name: "Polling interval", exact: true })).toContainText(
    "300 seconds",
  )
  await expect(page.getByRole("combobox", { name: "Minimum impact", exact: true })).toContainText(
    "Major",
  )
  await expect(
    page.getByRole("checkbox", { name: "Notify incident updates", exact: true }),
  ).not.toBeChecked()
  await expect(
    page.getByRole("checkbox", { name: "Notify resolved incidents", exact: true }),
  ).not.toBeChecked()
  await expect(
    page.getByRole("checkbox", { name: "Include scheduled maintenance", exact: true }),
  ).toBeChecked()
  for (const id of [1000, -100500, -100600, 4242])
    await expect(
      selected.getByRole("button", { name: `Remove destination ${id}`, exact: true }),
    ).toBeVisible()
  await fixture.directory
    .getByRole("textbox", { name: "Search stored chats", exact: true })
    .fill("-100500")
  await expect(
    fixture.directory.getByRole("checkbox", {
      name: "Send status notifications to Beyond page group · -100500",
      exact: true,
    }),
  ).toBeChecked()
})

test("canonical manual destination input participates in pending-editor guards and stays mounted", async ({
  page,
}) => {
  const fixture = await statusFixture(page)
  await openDisclosure(page, "Add an exact Telegram chat ID")
  const input = page.getByRole("textbox", { name: "Telegram notification chat ID", exact: true })
  for (const value of [
    "0",
    "-0",
    "+42",
    "0042",
    "-00100",
    " 42",
    "42 ",
    "42.0",
    "9007199254740992",
    "https://t.me/example",
  ]) {
    await input.fill(value)
    await page.getByRole("button", { name: "Add destination", exact: true }).click()
    await expect(page.getByRole("alert")).toContainText("canonical, non-zero Telegram chat ID")
    await expect(input).toBeFocused()
  }
  await input.fill("-100999")
  await page.getByRole("button", { name: "Add destination", exact: true }).click()
  await expect(input).toHaveValue("")
  await expect(
    page.getByRole("button", { name: "Remove destination -100999", exact: true }),
  ).toBeVisible()
  await input.fill("-100999")
  await page.getByRole("button", { name: "Add destination", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("already selected")
  await input.fill("424242")
  await fixture.directory
    .getByRole("textbox", { name: "Search stored chats", exact: true })
    .fill("Remote private")
  await expect(
    fixture.directory.getByRole("checkbox", {
      name: "Send status notifications to Remote private · 4242",
      exact: true,
    }),
  ).toBeVisible()
  await expect(input).toHaveValue("424242")
  await navigate(page, "Defaults")
  await expect(
    page.getByRole("button", { name: "Review and save changes", exact: true }),
  ).toBeDisabled()
  await expect(page.getByRole("button", { name: "Reload", exact: true })).toBeDisabled()
  await page
    .getByRole("button", {
      name: "Continue editing: Service status — Telegram chat ID to add",
      exact: true,
    })
    .click()
  await expect(input).toBeFocused()
  await expect(input).toHaveValue("424242")
  await expect(page.getByRole("heading", { name: "Service status", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Clear chat ID input", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Review and save changes", exact: true }),
  ).toBeEnabled()
  await input.fill("424242")
  await page.getByRole("button", { name: "Add destination", exact: true }).click()
  await save(page)
  await expect(page.locator('#save-status[data-compact="true"]')).toBeVisible()
  expect(fixture.snapshot().policy.statusNotifications.chatIds).toEqual([-100999, 424242])
  expect(fixture.snapshot().policy.privateUsers).toEqual([42])
  expect(fixture.snapshot().policy.groups).toEqual([-100, -101])
})

test("enabled empty services and destinations warn clearly but remain valid saved policy", async ({
  page,
}) => {
  const fixture = await statusFixture(page)
  await page
    .getByRole("checkbox", { name: "Enable service status notifications", exact: true })
    .check()
  for (const service of ["GitHub", "OpenAI", "Claude", "Cloudflare"])
    await page.getByRole("checkbox", { name: service, exact: true }).uncheck()
  const warning = page.getByRole("alert")
  await expect(warning).toContainText("No notifications will be sent.")
  await expect(warning).toContainText("Select at least one service.")
  await expect(warning).toContainText("Select at least one destination.")
  await save(page)
  await expect(page.locator('#save-status[data-compact="true"]')).toBeVisible()
  expect(fixture.snapshot().policy.statusNotifications).toMatchObject({
    enabled: true,
    providers: [],
    chatIds: [],
  })
  await page.reload()
  await expect(warning).toContainText("No notifications will be sent.")
})

test("concurrent status settings recover atomically without combining destinations and filters", async ({
  page,
}) => {
  const fixture = await statusFixture(page)
  await page
    .getByRole("checkbox", { name: "Enable service status notifications", exact: true })
    .check()
  await fixture.directory
    .getByRole("checkbox", {
      name: "Send status notifications to Private recipient 0 · 1000",
      exact: true,
    })
    .check()
  fixture.advance((policy) => {
    policy.statusNotifications.chatIds = [-100777]
    policy.statusNotifications.minimumImpact = "critical"
  })
  await save(page)
  await page.getByRole("button", { name: "Load latest and review draft", exact: true }).click()
  const recovery = page.getByRole("dialog", {
    name: "Review recovered settings draft",
    exact: true,
  })
  await expect(
    recovery.getByRole("button", { name: "Use recovered draft", exact: true }),
  ).toBeDisabled()
  await recovery
    .getByRole("radiogroup", { name: "Service status notifications", exact: true })
    .getByRole("radio", { name: "Use draft value", exact: true })
    .click()
  await recovery.getByRole("button", { name: "Use recovered draft", exact: true }).click()
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Save changes", exact: true })
    .click()
  await expect(page.locator('#save-status[data-compact="true"]')).toBeVisible()
  expect(fixture.writes.at(-1)?.revision).toBe(2)
  expect(fixture.snapshot().policy.statusNotifications).toMatchObject({
    enabled: true,
    chatIds: [1000],
    minimumImpact: "minor",
  })
})

test("session expiry clears unfinished manual destination input", async ({ page }) => {
  const fixture = await policyRecoveryFixture(page)
  await navigate(page, "Service status")
  await openDisclosure(page, "Add an exact Telegram chat ID")
  await page
    .getByRole("textbox", { name: "Telegram notification chat ID", exact: true })
    .fill("424242")
  fixture.state.expired = true
  await page
    .getByRole("region", { name: "Stored notification destinations", exact: true })
    .getByRole("button", { name: "Refresh chats", exact: true })
    .click()
  await expect(
    page.getByRole("button", { name: "Sign in with passkey", exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole("textbox", { name: "Telegram notification chat ID", exact: true }),
  ).toHaveCount(0)
  expect(fixture.writes).toHaveLength(0)
})

for (const width of [320, 1440]) {
  test(`status controls and signed IDs fit a ${width}px viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const fixture = await statusFixture(page)
    await openDisclosure(page, "Add an exact Telegram chat ID")
    await page
      .getByRole("textbox", { name: "Telegram notification chat ID", exact: true })
      .fill("-9007199254740991")
    await page.getByRole("button", { name: "Add destination", exact: true }).click()
    await expect(
      page.getByRole("button", { name: "Remove destination -9007199254740991", exact: true }),
    ).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await save(page)
    await expect(page.locator('#save-status[data-compact="true"]')).toBeVisible()
    expect(fixture.snapshot().policy.statusNotifications.chatIds).toEqual([-9007199254740991])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}
