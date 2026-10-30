import { expect, test } from "@playwright/test"
import { adminFixture, inventory, navigate } from "./admin-fixture.js"
import { durableFixture } from "./durable-fixture.js"

for (const width of [1440, 390]) {
  test(`settings states retain controls at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    await adminFixture(page)
    const long = `tool_${"long_name_".repeat(15)}`
    const tools = [
      "read_url_content",
      long,
      ...Array.from({ length: 150 }, (_, i) => `fixture_tool_${i}`),
    ]
    await page.route("**/api/inventory", (route) =>
      route.fulfill({ json: { ...inventory, tools, builtInTools: tools } }),
    )
    await page.getByRole("button", { name: "Reload", exact: true }).click()
    await navigate(page, "Tool permissions")
    await expect(page.getByText(long, { exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath("large-long.png"), fullPage: true })
    await page
      .getByRole("textbox", { name: "Search tools and servers", exact: true })
      .fill("fixture_tool_149")
    await expect(page.getByText("fixture_tool_149", { exact: true })).toBeVisible()
    await expect(page.getByText("fixture_tool_148", { exact: true })).toHaveCount(0)
    await page.getByRole("button", { name: "Clear tool filters", exact: true }).click()
    await navigate(page, "Model providers")
    await page.getByRole("button", { name: /^Model: / }).click()
    await page.getByRole("option", { name: /Other/ }).click()
    await navigate(page, "Tool permissions")
    await page
      .getByRole("checkbox", {
        name: "Default chat permission for tool read_url_content",
        exact: true,
      })
      .uncheck()
    await expect(page.getByRole("region", { name: "Pending changes", exact: true })).toContainText(
      "Provider: Unsaved",
    )
    await page.screenshot({ path: testInfo.outputPath("mixed-drafts.png"), fullPage: true })
    page.once("dialog", (dialog) => dialog.accept())
    await page.getByRole("button", { name: "Discard settings changes", exact: true }).click()
    await navigate(page, "Model providers")
    await expect(page.getByRole("button", { name: "Model: Other", exact: true })).toBeVisible()
    await page.getByRole("button", { name: "Use saved selection", exact: true }).click()

    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route("**/api/inventory", async (route) => {
      await gate
      return route.fulfill({ json: { tools: [], builtInTools: [], providers: [], mcp: [] } })
    })
    await page.getByRole("button", { name: "Reload", exact: true }).click()
    await expect(page.getByRole("button", { name: "Reload", exact: true })).toBeDisabled()
    await page.screenshot({ path: testInfo.outputPath("loading.png"), fullPage: true })
    release()
    await expect(page.getByRole("button", { name: "Reload", exact: true })).toBeEnabled()
    await expect(page.getByText(/The selected provider fixture is no longer/)).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath("empty.png"), fullPage: true })
    await page.route("**/api/inventory", (route) =>
      route.fulfill({ status: 503, json: { error: "Inventory unavailable" } }),
    )
    await page.getByRole("button", { name: "Reload", exact: true }).click()
    await expect(page.getByRole("alert")).toContainText("Inventory unavailable")
    await page.screenshot({ path: testInfo.outputPath("error.png"), fullPage: true })
    await page.unroute("**/api/inventory")
    await page.getByRole("button", { name: "Reload", exact: true }).click()
    await expect(page.getByRole("alert")).toHaveCount(0)
  })
}

test("mobile chat actions support keyboard focus return and record navigation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await adminFixture(page)
  await page.route("**/api/chats/42/durable?*", (route) =>
    route.fulfill({
      json: {
        version: 1,
        state: "loaded",
        readAt: "2026-10-24T00:00:00Z",
        view: "conversations",
        items: [],
        selectedConversation: null,
        truncated: false,
      },
    }),
  )
  await page
    .getByRole("list", { name: "Chats on this page", exact: true })
    .getByRole("button")
    .first()
    .click()
  const trigger = page.getByRole("button", { name: "Chat actions", exact: true })
  await trigger.focus()
  await trigger.press("Enter")
  await expect(page.getByRole("menuitem", { name: "Copy chat ID", exact: true })).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(trigger).toBeFocused()
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => {} },
    }),
  )
  await trigger.click()
  await page.getByRole("menuitem", { name: "Copy chat ID", exact: true }).click()
  await expect(page.getByRole("status").filter({ hasText: "Chat ID copied." })).toBeVisible()
  await expect(trigger).toBeFocused()
  await trigger.click()
  await page.getByRole("menuitem", { name: "View conversation records", exact: true }).click()
  await expect(page.locator("#current-section-heading")).toHaveText("Conversation records")
})

test("browser Back closes the mobile chat menu instead of leaving hidden-section actions open", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await adminFixture(page)
  await page
    .getByRole("list", { name: "Chats on this page", exact: true })
    .getByRole("button")
    .first()
    .click()
  await navigate(page, "Defaults")
  await navigate(page, "Chats")
  await page.getByRole("button", { name: "Chat actions", exact: true }).click()
  await expect(page.getByRole("menuitem", { name: "Copy chat ID", exact: true })).toBeVisible()
  await page.goBack()
  await expect(page.locator("#current-section-heading")).toHaveText("Shared defaults")
  await expect(page.getByRole("menuitem", { name: "Copy chat ID", exact: true })).toHaveCount(0)
  await page.goForward()
  await expect(page.getByRole("button", { name: "Chat actions", exact: true })).toBeVisible()
  await expect(page.getByRole("menuitem", { name: "Copy chat ID", exact: true })).toHaveCount(0)
})

test("record refresh reads only records, retains drafts, retries failures, and clears expired content", async ({
  page,
}) => {
  const state = await durableFixture(page)
  await expect(page.getByRole("button", { name: "Refresh records", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Reload", exact: true })).toHaveCount(0)
  await navigate(page, "Tool permissions")
  await page.getByText("Approve an exact tool name", { exact: true }).click()
  await page.getByLabel("Additional approved tool name", { exact: true }).fill("fixture_tool")
  await page.getByRole("button", { name: "Add tool to pending approval", exact: true }).click()
  await navigate(page, "Durable")
  await expect(page.getByRole("region", { name: "Pending changes", exact: true })).toBeVisible()
  const requests: string[] = []
  page.on("request", (request) => {
    if (request.url().includes("/api/")) requests.push(new URL(request.url()).pathname)
  })
  await page.getByRole("button", { name: "Refresh records", exact: true }).click()
  await expect.poll(() => requests.length).toBeGreaterThan(0)
  expect(requests.every((path) => path.endsWith("/durable"))).toBe(true)
  await expect(
    page.getByRole("button", { name: "Review and save changes", exact: true }),
  ).toBeVisible()
  state.failed = true
  await page.getByRole("button", { name: "Refresh records", exact: true }).click()
  await expect(page.getByRole("alert").filter({ hasText: "Read failed" }).first()).toBeVisible()
  state.failed = false
  await page.getByRole("button", { name: "Refresh records", exact: true }).click()
  await expect(page.getByRole("alert").filter({ hasText: "Read failed" })).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "Review and save changes", exact: true }),
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "Refresh records", exact: true })).toBeEnabled()
  await expect(
    page
      .getByRole("region", { name: "Conversation entries", exact: true })
      .getByRole("link", { name: "Inspect entry 170", exact: true }),
  ).toBeVisible()
  state.expired = true
  await page.getByRole("button", { name: "Refresh records", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Sign in with passkey", exact: true }),
  ).toBeVisible()
  await expect(page.getByRole("region", { name: "Durable Inspector", exact: true })).toHaveCount(0)
})
