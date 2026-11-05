import { expect, type Page, test } from "@playwright/test"
import { navigate } from "./admin-fixture.js"
import { policyRecoveryFixture } from "./policy-recovery-fixture.js"

async function addAuthor(page: Page, username: string) {
  await page.getByLabel("GitHub username", { exact: true }).fill(username)
  await page.getByRole("button", { name: "Add username", exact: true }).click()
}
async function save(page: Page) {
  await page.getByRole("button", { name: "Review and save changes", exact: true }).click()
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Save changes", exact: true })
    .click()
}

test("legacy GitHub notifications links open the GitHub mention author allowlist", async ({
  page,
}) => {
  const fixture = await policyRecoveryFixture(page)
  await page.goto("/?section=GitHub+notifications")
  await expect(page.getByRole("heading", { name: "GitHub mentions", exact: true })).toBeVisible()
  await expect(page.getByLabel("GitHub username", { exact: true })).toBeVisible()
  await expect(page.getByRole("link", { name: "GitHub mentions", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  )
  expect(fixture.writes).toHaveLength(0)
})

test("username edits use policy review and save without runtime variables or automatic grants", async ({
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
  await navigate(page, "GitHub mentions")
  await expect(
    page.getByText("No usernames allowed. An empty saved allowlist disables automatic replies."),
  ).toBeVisible()
  await addAuthor(page, "OctoCat")
  await expect(page.getByText("Pending addition", { exact: true })).toBeVisible()
  expect(fixture.writes).toHaveLength(0)
  await page.getByRole("button", { name: "Review and save changes", exact: true }).click()
  const review = page.getByRole("alertdialog")
  await expect(review).toContainText("GitHub mentions: add username octocat")
  await review.getByRole("button", { name: "Review GitHub mentions", exact: true }).click()
  await expect(
    page.getByRole("region", { name: "Allowed GitHub usernames", exact: true }),
  ).toBeFocused()
  await save(page)
  await expect(page.locator('#save-status[data-compact="true"]')).toBeVisible()
  expect(fixture.snapshot().policy.githubNotifications.allowedUsernames).toEqual(["octocat"])
  expect(fixture.snapshot().policy.privateUsers).toEqual([42])
  expect(fixture.snapshot().policy.tools).not.toContain("read_github_notifications")
  expect(mutations).toEqual([{ path: "/api/settings", method: "PUT", csrf: "fixture" }])
  await page.reload()
  await expect(
    page.getByRole("button", { name: "Remove username octocat", exact: true }),
  ).toBeVisible()
  await page.getByRole("button", { name: "Remove username octocat", exact: true }).click()
  await expect(page.getByText("Pending removal", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Restore username octocat", exact: true }).click()
  await expect(page.locator('#save-status[data-compact="true"]')).toBeVisible()
  expect(fixture.writes).toHaveLength(1)
  await page.getByRole("button", { name: "Remove username octocat", exact: true }).click()
  await save(page)
  await expect(page.locator('#save-status[data-compact="true"]')).toBeVisible()
  expect(fixture.snapshot().policy.githubNotifications.allowedUsernames).toEqual([])
})

test("invalid and unfinished usernames cannot be saved, and unfinished input remains discoverable", async ({
  page,
}) => {
  const fixture = await policyRecoveryFixture(page)
  await navigate(page, "GitHub mentions")
  for (const id of ["-cat", "@someone", "cat.name", "two--hyphens", "cat-", "a".repeat(40)]) {
    await addAuthor(page, id)
    await expect(page.getByRole("alert")).toContainText("Enter a GitHub username")
    await expect(page.getByLabel("GitHub username", { exact: true })).toBeFocused()
  }
  await addAuthor(page, "Hubot")
  await addAuthor(page, "HUBOT")
  await expect(page.getByRole("alert")).toContainText("already allowed")
  await expect(
    page.getByRole("button", { name: "Review and save changes", exact: true }),
  ).toBeDisabled()
  await navigate(page, "Defaults")
  await page
    .getByRole("button", {
      name: "Continue editing: GitHub mentions — GitHub username to add",
      exact: true,
    })
    .click()
  await expect(page.getByLabel("GitHub username", { exact: true })).toBeFocused()
  await page.getByLabel("GitHub username", { exact: true }).fill("")
  await expect(
    page.getByRole("button", { name: "Review and save changes", exact: true }),
  ).toBeEnabled()
  expect(fixture.writes).toHaveLength(0)
})

test("concurrent username edits require explicit recovery and never combine grants", async ({
  page,
}) => {
  const fixture = await policyRecoveryFixture(page)
  await navigate(page, "GitHub mentions")
  await addAuthor(page, "Hubot")
  fixture.advance((policy) => {
    policy.githubNotifications.allowedUsernames = ["other-author"]
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
    .getByRole("radiogroup", { name: "GitHub mention authors", exact: true })
    .getByRole("radio", { name: "Use draft value", exact: true })
    .click()
  await recovery.getByRole("button", { name: "Use recovered draft", exact: true }).click()
  expect(fixture.writes).toHaveLength(1)
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Save changes", exact: true })
    .click()
  await expect(page.locator('#save-status[data-compact="true"]')).toBeVisible()
  expect(fixture.snapshot().policy.githubNotifications.allowedUsernames).toEqual(["hubot"])
  expect(fixture.writes.at(-1)?.revision).toBe(2)
})

test("undo removal cannot exceed the username limit after a replacement is added", async ({
  page,
}) => {
  const fixture = await policyRecoveryFixture(page)
  fixture.advance((policy) => {
    policy.githubNotifications.allowedUsernames = Array.from(
      { length: 1000 },
      (_, index) => `user-${index + 1}`,
    )
  })
  await page.reload()
  await navigate(page, "GitHub mentions")
  await page.getByRole("button", { name: "Remove username user-1", exact: true }).click()
  await addAuthor(page, "new-author")
  await page.getByRole("button", { name: "Restore username user-1", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("limit is 1,000")
  await expect(page.getByText("1000 allowed usernames", { exact: true })).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Restore username user-1", exact: true }),
  ).toHaveCount(1)
  await save(page)
  await expect(page.locator('#save-status[data-compact="true"]')).toBeVisible()
  const ids = fixture.snapshot().policy.githubNotifications.allowedUsernames
  expect(ids).toHaveLength(1000)
  expect(ids).not.toContain("user-1")
  expect(ids).toContain("new-author")
})

test("expired administrator sessions clear username inputs", async ({ page }) => {
  const fixture = await policyRecoveryFixture(page)
  await navigate(page, "GitHub mentions")
  await addAuthor(page, "Hubot")
  fixture.state.expired = true
  await save(page)
  await expect(
    page.getByRole("button", { name: "Sign in with passkey", exact: true }),
  ).toBeVisible()
  await expect(page.getByLabel("GitHub username", { exact: true })).toHaveCount(0)
  expect(fixture.writes).toHaveLength(0)
})

for (const width of [375, 1440]) {
  test(`mention setup and username controls fit a ${width}px viewport`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    await policyRecoveryFixture(page)
    await navigate(page, "GitHub mentions")
    await addAuthor(page, "a".repeat(39))
    await expect(
      page.getByRole("button", { name: `Remove username ${"a".repeat(39)}`, exact: true }),
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
