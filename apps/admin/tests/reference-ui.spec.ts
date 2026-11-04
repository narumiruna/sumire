import { expect, type Page, test } from "@playwright/test"
import { contrast } from "./contrast.js"
import { durableFixture, historyInput } from "./durable-fixture.js"

const historyUrl = (id?: number) =>
  `/?section=Durable&chat=42&view=history&conversationId=7${id === undefined ? "" : `&objectId=${id}`}`
const entries = (page: Page) =>
  page.getByRole("region", { name: "Conversation entries", exact: true })
const details = (page: Page) =>
  page.getByRole("complementary", { name: "Event details", exact: true })

for (const width of [1448, 768, 390, 320]) {
  test(`reference layout and accessible controls at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1086 })
    const state = await durableFixture(page, historyUrl(width >= 1100 ? 170 : undefined))
    await expect(
      entries(page).getByRole("link", { name: "Inspect entry 170", exact: true }),
    ).toBeVisible()
    await expect(
      page.getByRole("heading", { name: "Conversation records", exact: true }),
    ).toBeVisible()
    await expect(
      page.getByRole("region", { name: "Inspected conversation ID", exact: true }),
    ).toContainText("7")
    await expect(
      page.getByRole("region", { name: "Current inspection target", exact: true }),
    ).toContainText("Inspecting Conversation 7")
    await expect(page.locator(".durable-context-bar > section")).toHaveCount(3)
    const breadcrumb = page.locator(".page-breadcrumb")
    if (width > 650) await expect(breadcrumb).toBeVisible()
    else await expect(breadcrumb).toBeHidden()
    const views = page.getByRole("navigation", { name: "Conversation record views", exact: true })
    await expect(views.getByRole("link", { name: "History", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    )
    await expect(views.getByRole("link", { name: "Branch view", exact: true })).toBeVisible()
    if (width >= 1100) {
      await expect(
        details(page).getByRole("region", { name: "Selected item details", exact: true }),
      ).toBeVisible()
      const list = await entries(page).boundingBox()
      const detail = await details(page).boundingBox()
      const filters = await page.locator(".durable-history-filters").boundingBox()
      expect(list).not.toBeNull()
      expect(detail).not.toBeNull()
      if (list && detail && filters) {
        expect(list.x + list.width).toBeLessThanOrEqual(detail.x)
        expect(Math.abs(list.y - detail.y)).toBeLessThan(2)
        expect(filters.y + filters.height).toBeLessThanOrEqual(list.y)
        expect(list.width).toBeGreaterThan(400)
        expect(detail.width).toBeGreaterThan(list.width)
      }
    } else await expect(details(page)).toHaveCount(0)
    for (const control of await page
      .locator(
        ".durable-inspector input:visible, .durable-inspector select:visible, .durable-inspector button:visible",
      )
      .all())
      expect(
        (await control.boundingBox())?.height,
        (await control.getAttribute("aria-label")) ?? (await control.textContent()) ?? "control",
      ).toBeGreaterThanOrEqual(44)
    for (const text of await entries(page)
      .locator("article strong, .durable-history-preview, article time")
      .all())
      expect((await contrast(text)).text).toBeGreaterThanOrEqual(4.5)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({
      path: testInfo.outputPath(`reference-history-${width}.png`),
      fullPage: true,
    })

    if (width < 1100) {
      await entries(page).getByRole("link", { name: "Inspect entry 170", exact: true }).click()
      const dialog = page.getByRole("dialog", { name: "Event details", exact: true })
      await expect(dialog).toBeVisible()
      await expect(dialog.locator(".durable-message-text")).toHaveText(historyInput)
      await expect(dialog.getByRole("button", { name: "Previous", exact: true })).toBeVisible()
      await expect(dialog.getByRole("button", { name: "Next", exact: true })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      )
      await page.screenshot({
        path: testInfo.outputPath(`reference-detail-${width}.png`),
        fullPage: true,
      })
      await dialog.getByRole("button", { name: "Close event details", exact: true }).click()
      await expect(
        entries(page).getByRole("link", { name: "Inspect entry 170", exact: true }),
      ).toBeFocused()
    }
    const navigation = page.getByRole("navigation", {
      name: "Administration sections",
      exact: true,
    })
    if (!(await navigation.isVisible()))
      await page.getByRole("button", { name: /^Sections ·/ }).click()
    for (const name of [
      "Chats",
      "Conversation",
      "Models",
      "Tools & skills",
      "Configuration",
      "Monitoring",
    ])
      await expect(
        navigation.getByRole("heading", { name: `${name} navigation`, exact: true }),
      ).toBeVisible()
    await expect(navigation.locator("a > svg")).toHaveCount(10)
    for (const icon of await navigation.locator("a > svg").all()) await expect(icon).toBeVisible()
    expect(state.methods.every((method) => method === "GET")).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}

test("Copy content excludes hidden thinking and reports failures without inspection reads", async ({
  page,
}) => {
  const state = await durableFixture(page, historyUrl(171))
  const detail = details(page).getByRole("region", { name: "Selected item details", exact: true })
  await expect(detail.getByRole("button", { name: "Copy content", exact: true })).toBeVisible()
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          sessionStorage.setItem("reference-copy", value)
        },
      },
    }),
  )
  const reads = state.requests.length
  await detail.getByRole("button", { name: "Copy content", exact: true }).click()
  await expect(detail.getByRole("status")).toHaveText("Content copied.")
  const copied = await page.evaluate(() => sessionStorage.getItem("reference-copy"))
  expect(copied).toContain("Checking synthetic records.")
  expect(copied).not.toContain("Private history reasoning")
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("Copy denied")
        },
      },
    }),
  )
  await detail.getByRole("button", { name: "Copy content", exact: true }).click()
  await expect(detail.getByRole("status")).toHaveText(
    "Copy failed. Select and copy the content below.",
  )
  expect(state.requests).toHaveLength(reads)
})
