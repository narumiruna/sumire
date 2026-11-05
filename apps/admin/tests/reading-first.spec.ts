import { expect, test } from "@playwright/test"
import { adminDesignFixture } from "./admin-design-fixture.js"
import { navigate } from "./admin-fixture.js"
import { durableFixture, historyInput, untrusted } from "./durable-fixture.js"

const pages = [
  "Chats",
  "Durable",
  "Defaults",
  "Model Providers",
  "Tool permissions",
  "Skills",
  "MCP connections",
  "Secrets & variables",
  "GitHub mentions",
  "Audit",
]

for (const width of [390, 1440]) {
  test(`reading-first visual acceptance for all ten pages at ${width}px`, async ({
    page,
  }, info) => {
    test.setTimeout(90000)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1050 })
    await page.addInitScript(() => localStorage.setItem("sumire.admin.locale", "zh-TW"))
    const failures: string[] = []
    page.on("pageerror", (error) => failures.push(error.message))
    const fixture = await adminDesignFixture(page, "reading")
    for (const section of pages) {
      await page.goto(`/?section=${encodeURIComponent(section)}&chat=42`)
      await expect(page.locator("#current-section-heading")).toBeVisible()
      await expect(page.locator(".editor-panel")).toBeVisible()
      if (section === "Durable") {
        await expect(page.locator('.durable-history-workspace[data-mode="reading"]')).toBeVisible()
        await expect(page.locator(".reading-entry").first()).toBeVisible()
        await expect(page.locator(".durable-event-details")).toHaveCount(0)
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      )
      await page.screenshot({
        animations: "disabled",
        path: info.outputPath(`${section.replaceAll(" ", "-")}-viewport.png`),
      })
      await page.screenshot({
        animations: "disabled",
        path: info.outputPath(`${section.replaceAll(" ", "-")}-full.png`),
        fullPage: true,
      })
    }
    expect(failures).toEqual([])
    expect(fixture.methods.every((method) => method === "GET")).toBe(true)
  })
}

test("reading mode uses existing bounded content, folds events, and preserves explicit inspection", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1050 })
  const state = await durableFixture(page, "/?section=Durable&chat=42", { historyMode: "reading" })
  const reading = page.locator('.durable-history-workspace[data-mode="reading"]')
  await expect(reading).toBeVisible()
  await expect(
    page.locator(".reading-entry").filter({ hasText: historyInput }).first(),
  ).toBeVisible()
  await expect(page.locator(".reading-system-events:not([open])").first()).toBeVisible()
  expect(state.requests).toHaveLength(3)
  expect(
    await page.evaluate(
      () => (window as unknown as { inspectorInjected?: boolean }).inspectorInjected,
    ),
  ).toBeUndefined()
  await expect(
    page.locator('.reading-entry img[src="https://untrusted.invalid/pixel"]'),
  ).toHaveCount(0)
  const user = page.locator(".reading-entry").filter({ hasText: historyInput }).first()
  await expect(user).toContainText(untrusted)
  await user.getByRole("link", { name: "Inspect entry 170", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Event details", exact: true })
  await expect(dialog).toBeVisible()
  await dialog.getByRole("button", { name: "Close event details", exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await page.getByRole("button", { name: "Event inspection", exact: true }).click()
  await expect(page.locator('.durable-history-workspace[data-mode="events"]')).toBeVisible()
  await expect(page.locator(".durable-event-details")).toBeVisible()
  const reads = state.requests.length
  await page.getByRole("button", { name: "Conversation reading", exact: true }).click()
  expect(state.requests).toHaveLength(reads)
  await page.screenshot({ animations: "disabled", path: info.outputPath("reading-mode.png") })
})

test("navigation rail and reading width controls are reversible without data writes", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1050 })
  const state = await durableFixture(page, "/?section=Durable&chat=42", { historyMode: "reading" })
  const sidebar = page.locator(".sidebar")
  await expect(sidebar).toHaveAttribute("data-collapsed", "true")
  expect((await sidebar.boundingBox())?.width).toBe(76)
  await page.getByRole("button", { name: "Expand navigation", exact: true }).click()
  await expect(sidebar).toHaveAttribute("data-collapsed", "false")
  await page.getByRole("button", { name: "Collapse navigation", exact: true }).click()
  const pane = page.locator(".durable-reader-pane")
  const initialWidth = (await pane.boundingBox())?.width ?? 0
  await page.getByRole("button", { name: "Collapse chat list", exact: true }).click()
  expect((await pane.boundingBox())?.width).toBeGreaterThan(initialWidth)
  await page.getByRole("button", { name: "Expand reading", exact: true }).click()
  await expect(page.locator(".durable-directory-pane")).toBeHidden()
  await page.screenshot({ animations: "disabled", path: info.outputPath("expanded-reading.png") })
  await page.getByRole("button", { name: "Restore layout", exact: true }).click()
  await page.getByRole("button", { name: "Expand chat list", exact: true }).click()
  await expect(page.locator(".durable-directory-pane")).toBeVisible()
  await navigate(page, "Defaults")
  await expect(sidebar).toHaveAttribute("data-collapsed", "true")
  expect(state.methods.every((method) => method === "GET")).toBe(true)
})

test("compact navigation retains localized links and the native language selector", async ({
  page,
}) => {
  await adminDesignFixture(page, "reading")
  await page.getByLabel("Language", { exact: true }).selectOption("zh-TW")
  await expect(page.getByRole("link", { name: "對話紀錄", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "展開導覽", exact: true }).click()
  await expect(page.locator(".sidebar")).toHaveAttribute("data-collapsed", "false")
  await page.getByLabel("語言", { exact: true }).selectOption("ja")
  await expect(page.getByRole("link", { name: "共通の既定値", exact: true })).toBeVisible()
})

test("pending save controls follow the rail width and keep review explicit", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const fixture = await adminDesignFixture(page, "reading")
  await navigate(page, "Tool permissions")
  await page
    .getByRole("checkbox", { name: "Default chat permission for tool read", exact: true })
    .uncheck()
  const bar = page.locator(".changes-bar")
  await expect(bar).toBeVisible()
  expect((await bar.boundingBox())?.x).toBe(76)
  await page.getByRole("button", { name: "Expand navigation", exact: true }).click()
  expect((await bar.boundingBox())?.x).toBe(244)
  await page.getByRole("button", { name: "Collapse navigation", exact: true }).click()
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("pending-save-desktop.png"),
  })
  await page.getByRole("button", { name: "Review and save changes", exact: true }).click()
  await expect(page.getByRole("alertdialog")).toBeVisible()
  await page.screenshot({ animations: "disabled", path: info.outputPath("review-dialog.png") })
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  expect((await bar.boundingBox())?.x).toBe(0)
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("pending-save-mobile.png"),
  })
  await page.getByRole("button", { name: "Review and save changes", exact: true }).click()
  await expect(page.getByRole("alertdialog")).toBeVisible()
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("review-dialog-mobile.png"),
  })
  expect(fixture.methods.every((method) => method === "GET")).toBe(true)
})
