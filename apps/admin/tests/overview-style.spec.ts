import { expect, type Locator, test } from "@playwright/test"
import { chatCardsFixture } from "./chat-cards-fixture.js"
import { contrast } from "./contrast.js"
import { durableFixture } from "./durable-fixture.js"

async function expectOverviewColumns(grid: Locator, wide: boolean) {
  await expect(grid.getByRole("heading")).toHaveCount(2)
  const sections = grid.locator(":scope > section")
  await expect(sections).toHaveCount(2)
  const first = await sections.first().boundingBox()
  const second = await sections.last().boundingBox()
  if (!first || !second) throw new Error("Missing overview column geometry")
  expect(first.width).toBeCloseTo(second.width, 1)
  if (wide) {
    expect(first.y).toBeCloseTo(second.y, 1)
    expect(first.x + first.width).toBeLessThan(second.x)
  } else {
    expect(first.x).toBeCloseTo(second.x, 1)
    expect(first.y + first.height).toBeLessThan(second.y)
  }
}

async function expectPrimaryAction(action: Locator) {
  await expect(action).toHaveCSS("background-color", "rgb(251, 252, 247)")
  await expect(action).toHaveCSS("color", "rgb(53, 98, 69)")
  await expect(action).toHaveCSS("border-top-color", "rgb(53, 98, 69)")
  await expect(action).toHaveCSS("border-top-width", "1px")
  await expect(action).toHaveCSS("border-radius", "6px")
  expect((await action.boundingBox())?.height).toBeGreaterThanOrEqual(44)
  expect((await contrast(action)).text).toBeGreaterThanOrEqual(4.5)
}

for (const width of [1440, 390]) {
  test(`Chats uses open lists and responsive overview columns at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const state = await chatCardsFixture(page)
    const heading = page.getByRole("heading", { name: "Chats", exact: true, level: 1 })
    const directory = page.locator(".chat-directory")
    const row = directory.getByRole("listitem").first()
    await expect(page.getByRole("main")).toHaveCSS("background-color", "rgb(237, 239, 231)")
    await expect(heading).toHaveCSS("font-size", "30px")
    await expect(heading).toHaveCSS("font-weight", "750")
    await expect(heading).toHaveCSS("letter-spacing", "normal")
    await expect(page.locator(".workspace-header")).toHaveCSS("margin-block-end", "32px")
    await expect(row).toHaveCSS("border-top-width", "0px")
    await expect(row).toHaveCSS("padding-block-start", "4px")
    await expect(row).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
    await expectPrimaryAction(row.getByRole("button", { name: "Configure", exact: true }))

    const search = directory.getByRole("textbox", { name: "Search chats" })
    await search.fill("no-such-chat")
    const empty = directory.getByText("No chats match this search", { exact: true })
    await expect(empty).toBeVisible()
    await expect(empty.locator('svg[aria-hidden="true"]')).toBeVisible()
    expect((await contrast(empty)).text).toBeGreaterThanOrEqual(4.5)
    await search.clear()
    await row.getByRole("link").click()

    const overview = page.getByRole("tabpanel", { name: "Overview" })
    await expectOverviewColumns(overview.locator(".overview-grid"), width === 1440)
    const manage = overview.getByRole("button", { name: "Manage access", exact: true })
    await expectPrimaryAction(manage)
    const tablist = page.getByRole("tablist", { name: "Selected chat views" })
    await expect(tablist).toHaveCSS("border-bottom", "1px solid rgb(124, 136, 122)")
    const tab = tablist.getByRole("tab", { name: "Overview", selected: true })
    expect(await tab.evaluate((element) => getComputedStyle(element, "::before").height)).toBe(
      "2px",
    )
    await tab.focus()
    await page.keyboard.press("Home")
    await expect(tab).toBeFocused()
    await expect(tab.locator(".rt-BaseTabListTriggerInner")).toHaveCSS("outline-style", "solid")
    await manage.press("Enter")
    await expect(page.getByRole("tab", { name: "Access", selected: true })).toBeFocused()
    await expect(page.locator(".chat-overview:visible")).toHaveCount(0)
    expect(state.writes).toEqual([])
  })

  test(`Durable session context preserves the list, empty state, and links at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    const state = await durableFixture(page)
    await page.getByText("History and context", { exact: true }).click()
    const overview = page.getByRole("region", { name: "Durable overview", exact: true })
    await expectOverviewColumns(overview.locator(".overview-grid"), width === 1440)
    await expect(overview.locator(".overview-grid")).toHaveCSS("margin-block-start", "32px")
    const inspect = overview.getByRole("link", { name: "Inspect selected conversation" })
    await expectPrimaryAction(inspect)
    const task = overview.getByRole("listitem").first()
    await expect(task).toHaveCSS("padding-block-start", "4px")
    await expect(task).toHaveCSS("border-bottom-width", "0px")
    await inspect.press("Enter")
    await expect(page).toHaveURL(/objectId=7/)
    expect(state.methods.every((method) => method === "GET")).toBe(true)

    state.taskItems = []
    await page.reload()
    await page.getByText("History and context", { exact: true }).click()
    const empty = overview.getByText("No task history on this page.", { exact: true })
    await expect(empty).toBeVisible()
    await expect(empty.locator('svg[aria-hidden="true"]')).toBeVisible()
  })
}
