import { expect, test } from "@playwright/test"
import { chatCardsFixture } from "./chat-cards-fixture.js"

for (const width of [320, 390, 450, 1440]) {
  test(`readable reference cards at ${width}px with no overflow or automatic writes`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 875 })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    const state = await chatCardsFixture(page)
    await expect(page.locator(".page-header__description")).toHaveCount(0)
    await expect(page.locator(".saved-settings-details")).not.toHaveAttribute("open", "")
    await expect(page.locator("#chat-access-management")).not.toHaveAttribute("open", "")
    const cards = page.locator(".chat-card")
    await expect(cards.nth(0)).toContainText("Shared settings")
    await expect(cards.nth(0).locator(".chat-card-warning")).toHaveCount(0)
    await expect(cards.nth(1)).toContainText("Chat settings")
    await expect(cards.nth(1).getByRole("button", { name: "Needs attention" })).toBeVisible()
    await expect(cards.nth(2)).toContainText("Waiting for administrator approval")
    await expect(page.getByRole("textbox", { name: "Search chats" })).not.toBeFocused()
    for (const element of await page
      .locator(".chat-card-name, .chat-card-facts dd, .chat-card-waiting")
      .all())
      expect(
        await element.evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize)),
      ).toBeGreaterThanOrEqual(16)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(state.writes).toEqual([])
    expect(errors).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`chat-cards-${width}.png`), fullPage: true })
  })
}

test("search and saved-state filters do not change permissions", async ({ page }) => {
  const state = await chatCardsFixture(page)
  await page.getByRole("button", { name: "Enabled", exact: true }).click()
  await expect(page.locator(".chat-card")).toHaveCount(2)
  await page.getByRole("button", { name: "Pending approval", exact: true }).click()
  await expect(page.locator(".chat-card")).toHaveCount(1)
  await expect(page.locator(".chat-card")).toContainText("測試群組")
  await page.getByRole("button", { name: "All", exact: true }).click()
  await page.getByRole("textbox", { name: "Search chats" }).fill("-101")
  await expect(page.locator(".chat-card")).toHaveCount(1)
  await expect(page.locator(".chat-card")).toContainText("開發討論群")
  await page.getByRole("textbox", { name: "Search chats" }).fill("沒有這個群組")
  await expect(page.getByText("No chats match this search", { exact: true })).toBeVisible()
  expect(state.reads.some((path) => path.includes("q=-101"))).toBe(true)
  expect(state.writes).toEqual([])
})

test("approval remains pending until explicit review and save", async ({ page }) => {
  const state = await chatCardsFixture(page)
  const pending = page.locator('[data-chat-id="-102"]')
  await pending.getByRole("button", { name: "Approve", exact: true }).click()
  await expect(pending).toContainText("Approval not saved")
  await expect(pending.locator(".chat-card-status")).toHaveText("Pending approval")
  expect(state.writes).toEqual([])
  await page.getByRole("button", { name: "Review and save changes", exact: true }).click()
  const dialog = page.getByRole("alertdialog")
  await expect(dialog).toContainText("Group/channel access: approve -102")
  await dialog.getByRole("button", { name: "Save changes", exact: true }).click()
  await expect.poll(() => state.writes.length).toBe(1)
  await expect(pending.locator(".chat-card-status")).toHaveText("Enabled")
  await expect(pending).not.toContainText("Approval not saved")
  expect(state.policy().groups).toEqual([-100, -101, -102])
})

test("settings, warning repair, manual ID configuration and access management remain reachable", async ({
  page,
}) => {
  const state = await chatCardsFixture(page)
  await page
    .locator('[data-chat-id="-100"]')
    .getByRole("button", { name: "Configure", exact: true })
    .click()
  await expect(page.getByRole("tab", { name: "Model & Tools", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  )
  await expect(page.locator(".chat-header code")).toHaveText("-100")
  await page.getByRole("button", { name: "Back to chat directory", exact: true }).click()
  await expect(page.locator('[data-chat-id="-100"] .chat-card-name')).toBeFocused()
  await page
    .locator('[data-chat-id="-101"]')
    .getByRole("button", { name: "Needs attention" })
    .click()
  await expect(page.getByRole("heading", { name: "Providers & models", exact: true })).toBeVisible()
  await page.goto("/")
  await page.getByRole("button", { name: "Filter", exact: true }).click()
  await page.getByText("Open settings by chat ID", { exact: true }).click()
  await page.getByRole("textbox", { name: "Chat ID", exact: true }).fill("-999")
  await page.getByRole("button", { name: "Open details", exact: true }).click()
  await expect(page.locator(".chat-header code")).toHaveText("-999")
  await page.getByRole("button", { name: "Back to chat directory", exact: true }).click()
  await page.locator("#chat-access-management > summary").click()
  await expect(
    page.getByRole("textbox", { name: "Telegram ID to approve", exact: true }),
  ).toBeVisible()
  expect(state.writes).toEqual([])
})

test("card menus are keyboard accessible, stage revocation and close when leaving Chats", async ({
  page,
}) => {
  const state = await chatCardsFixture(page)
  const first = page.locator('[data-chat-id="-100"]')
  const menu = first.getByRole("button", { name: "More actions for 專案機器人群", exact: true })
  await menu.focus()
  await menu.press("Enter")
  await expect(page.getByRole("menuitem", { name: "View details", exact: true })).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(menu).toBeFocused()
  await menu.click()
  await page.getByRole("menuitem", { name: "Revoke approval", exact: true }).click()
  await expect(first).toContainText("Revocation not saved")
  await expect(first.locator(".chat-card-status")).toHaveText("Enabled")
  await menu.click()
  await page.getByRole("menuitem", { name: "Cancel pending revocation", exact: true }).click()
  await expect(first).not.toContainText("Revocation not saved")
  await menu.click()
  await page.evaluate(() => {
    history.pushState(null, "", "?section=Defaults")
    dispatchEvent(new PopStateEvent("popstate"))
  })
  await expect(page.getByRole("menu")).toHaveCount(0)
  expect(state.writes).toEqual([])
})

test("directory errors can be retried without a blank page", async ({ page }) => {
  const state = await chatCardsFixture(page)
  await page.route("**/api/chats?*", (route) =>
    route.fulfill({ status: 500, json: { error: "Fixture failure" } }),
  )
  await page.getByRole("button", { name: "Refresh settings", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("Could not read chat metadata")
  await expect(page.getByRole("button", { name: "Reload", exact: true })).toBeVisible()
  await page.unroute("**/api/chats?*")
  await page.getByRole("button", { name: "Reload", exact: true }).click()
  await expect(page.locator(".chat-card")).toHaveCount(3)
  expect(state.writes).toEqual([])
})

test("server pagination and type filters remain available", async ({ page }) => {
  const state = await chatCardsFixture(page, 105)
  await expect(page.locator(".chat-card")).toHaveCount(100)
  await page.getByRole("button", { name: "Next", exact: true }).click()
  await expect(page.locator(".chat-card")).toHaveCount(5)
  await expect(page.getByText("Page 2", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Previous", exact: true }).click()
  await expect(page.locator(".chat-card")).toHaveCount(100)
  await page.getByRole("button", { name: "Filter", exact: true }).click()
  await page.getByRole("combobox", { name: "Chat type", exact: true }).click()
  await page.getByRole("option", { name: "Private", exact: true }).click()
  await expect(page.getByText("No chats match on this page", { exact: true })).toBeVisible()
  expect(state.reads.some((path) => path.includes("offset=100"))).toBe(true)
  expect(state.writes).toEqual([])
})
