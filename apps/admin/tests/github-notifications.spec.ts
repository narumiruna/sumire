import { expect, type Page, test } from "@playwright/test"
import { navigate } from "./admin-fixture.js"
import { policyRecoveryFixture } from "./policy-recovery-fixture.js"

async function addRecipient(page: Page, id: string) {
  await page.getByLabel("Telegram user ID", { exact: true }).fill(id)
  await page.getByRole("button", { name: "Add recipient", exact: true }).click()
}
async function save(page: Page) {
  await page.getByRole("button", { name: "Review and save changes", exact: true }).click()
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Save changes", exact: true })
    .click()
}

test("recipient edits use policy review and save without runtime variables or automatic grants", async ({
  page,
}) => {
  const fixture = await policyRecoveryFixture(page)
  const mutations: { path: string; method: string; csrf?: string }[] = []
  page.on("request", (request) => {
    if (request.method() !== "GET")
      mutations.push({
        path: new URL(request.url()).pathname,
        method: request.method(),
        csrf: request.headers()["x-csrf-token"],
      })
  })
  await navigate(page, "GitHub notifications")
  await expect(
    page.getByText("No recipients selected. An empty saved list denies everyone."),
  ).toBeVisible()
  await addRecipient(page, "123456789")
  await expect(page.getByText("Pending addition", { exact: true })).toBeVisible()
  expect(fixture.writes).toHaveLength(0)
  await page.getByRole("button", { name: "Review and save changes", exact: true }).click()
  const review = page.getByRole("alertdialog")
  await expect(review).toContainText("GitHub notifications: add recipient 123456789")
  await review.getByRole("button", { name: "Review GitHub notifications", exact: true }).click()
  await expect(page.getByRole("region", { name: "Recipient list", exact: true })).toBeFocused()
  await save(page)
  await expect(page.locator('#save-status[data-compact="true"]')).toBeVisible()
  expect(fixture.snapshot().policy.githubNotifications.allowedUserIds).toEqual([123456789])
  expect(fixture.snapshot().policy.privateUsers).toEqual([42])
  expect(fixture.snapshot().policy.tools).not.toContain("read_github_notifications")
  expect(mutations).toEqual([{ path: "/api/settings", method: "PUT", csrf: "fixture" }])
  await page.reload()
  await expect(
    page.getByRole("button", { name: "Remove recipient 123456789", exact: true }),
  ).toBeVisible()
  await page.getByRole("button", { name: "Remove recipient 123456789", exact: true }).click()
  await expect(page.getByText("Pending removal", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Restore recipient 123456789", exact: true }).click()
  await expect(page.locator('#save-status[data-compact="true"]')).toBeVisible()
  expect(fixture.writes).toHaveLength(1)
  await page.getByRole("button", { name: "Remove recipient 123456789", exact: true }).click()
  await save(page)
  await expect(page.locator('#save-status[data-compact="true"]')).toBeVisible()
  expect(fixture.snapshot().policy.githubNotifications.allowedUserIds).toEqual([])
})

test("invalid and unfinished IDs cannot be saved, and unfinished input remains discoverable", async ({
  page,
}) => {
  const fixture = await policyRecoveryFixture(page)
  await navigate(page, "GitHub notifications")
  for (const id of ["-100", "@someone", "42.5", "9007199254740992"]) {
    await addRecipient(page, id)
    await expect(page.getByRole("alert")).toContainText("positive Telegram user ID")
    await expect(page.getByLabel("Telegram user ID", { exact: true })).toBeFocused()
  }
  await addRecipient(page, "42")
  await addRecipient(page, "42")
  await expect(page.getByRole("alert")).toContainText("already a notification recipient")
  await expect(
    page.getByRole("button", { name: "Review and save changes", exact: true }),
  ).toBeDisabled()
  await navigate(page, "Defaults")
  await page
    .getByRole("button", {
      name: "Continue editing: GitHub notifications — Telegram user ID to add",
      exact: true,
    })
    .click()
  await expect(page.getByLabel("Telegram user ID", { exact: true })).toBeFocused()
  await page.getByLabel("Telegram user ID", { exact: true }).fill("")
  await expect(
    page.getByRole("button", { name: "Review and save changes", exact: true }),
  ).toBeEnabled()
  expect(fixture.writes).toHaveLength(0)
})

test("concurrent recipient edits require explicit recovery and never combine grants", async ({
  page,
}) => {
  const fixture = await policyRecoveryFixture(page)
  await navigate(page, "GitHub notifications")
  await addRecipient(page, "42")
  fixture.advance((policy) => {
    policy.githubNotifications.allowedUserIds = [43]
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
    .getByRole("radiogroup", { name: "GitHub notification recipients", exact: true })
    .getByRole("radio", { name: "Use draft value", exact: true })
    .click()
  await recovery.getByRole("button", { name: "Use recovered draft", exact: true }).click()
  expect(fixture.writes).toHaveLength(1)
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Save changes", exact: true })
    .click()
  await expect(page.locator('#save-status[data-compact="true"]')).toBeVisible()
  expect(fixture.snapshot().policy.githubNotifications.allowedUserIds).toEqual([42])
  expect(fixture.writes.at(-1)?.revision).toBe(2)
})

test("undo removal cannot exceed the recipient limit after a replacement is added", async ({
  page,
}) => {
  const fixture = await policyRecoveryFixture(page)
  fixture.advance((policy) => {
    policy.githubNotifications.allowedUserIds = Array.from(
      { length: 1000 },
      (_, index) => index + 1,
    )
  })
  await page.reload()
  await navigate(page, "GitHub notifications")
  await page.getByRole("button", { name: "Remove recipient 1", exact: true }).click()
  await addRecipient(page, "1001")
  await page.getByRole("button", { name: "Restore recipient 1", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("limit is 1,000")
  await expect(page.getByText("1000 selected recipients", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Restore recipient 1", exact: true })).toHaveCount(
    1,
  )
  await save(page)
  await expect(page.locator('#save-status[data-compact="true"]')).toBeVisible()
  const ids = fixture.snapshot().policy.githubNotifications.allowedUserIds
  expect(ids).toHaveLength(1000)
  expect(ids).not.toContain(1)
  expect(ids).toContain(1001)
})

test("expired administrator sessions clear recipient inputs", async ({ page }) => {
  const fixture = await policyRecoveryFixture(page)
  await navigate(page, "GitHub notifications")
  await addRecipient(page, "42")
  fixture.state.expired = true
  await save(page)
  await expect(
    page.getByRole("button", { name: "Sign in with passkey", exact: true }),
  ).toBeVisible()
  await expect(page.getByLabel("Telegram user ID", { exact: true })).toHaveCount(0)
  expect(fixture.writes).toHaveLength(0)
})

for (const width of [375, 1440]) {
  test(`notification setup and recipient controls fit a ${width}px viewport`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    await policyRecoveryFixture(page)
    await navigate(page, "GitHub notifications")
    await addRecipient(page, "9007199254740991")
    await expect(
      page.getByRole("button", { name: "Remove recipient 9007199254740991", exact: true }),
    ).toBeVisible()
    await expect(page.getByText(/Chats with bash access can use and read GH_TOKEN/)).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({
      path: testInfo.outputPath(`github-notifications-${width}.png`),
      fullPage: true,
    })
    await save(page)
    await expect(page.locator('#save-status[data-compact="true"]')).toBeVisible()
    await page.route("**/api/runtime-config", (route) =>
      route.fulfill({
        json: {
          revision: 2,
          applied: 2,
          status: "applied",
          secretStatus: "ready",
          entries: [],
        },
      }),
    )
    await page.getByRole("button", { name: "Manage GH_TOKEN", exact: true }).click()
    await expect(
      page.getByRole("heading", { name: "Secrets & variables", exact: true }),
    ).toBeVisible()
    await expect(page.getByRole("button", { name: "Add secret", exact: true })).toBeEnabled()
  })
}
