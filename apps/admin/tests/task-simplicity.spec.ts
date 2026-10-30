import { expect, type Locator, test } from "@playwright/test"
import { navigate } from "./admin-fixture.js"
import { remediationFixture as fixture } from "./remediation-fixture.js"

// Measure before click/fill: Playwright otherwise scrolls hidden task entry points into view.
async function inViewport(locator: Locator) {
  await expect(locator).toBeVisible()
  const box = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { top: rect.top, bottom: rect.bottom, viewport: innerHeight }
  })
  expect(box.top).toBeGreaterThanOrEqual(0)
  expect(box.bottom).toBeLessThanOrEqual(box.viewport)
  await test.info().attach("task-geometry", {
    body: JSON.stringify({ control: locator.toString(), ...box }),
    contentType: "application/json",
  })
}

for (const width of [390, 1440]) {
  test.describe(`${width}px task controls`, () => {
    test.use({ viewport: { width, height: width === 390 ? 844 : 900 } })

    test("default model starts with its controls, not credential maintenance", async ({ page }) => {
      const state = await fixture(page)
      await navigate(page, "Defaults")
      await inViewport(page.getByRole("combobox", { name: "Shared default model", exact: true }))
      await inViewport(page.getByRole("combobox", { name: "Shared default thinking", exact: true }))
      await expect(
        page.getByRole("button", { name: "Remove credential", exact: true }),
      ).toBeHidden()
      await expect(
        page.getByRole("checkbox", { name: "Use as the bot default", exact: true }),
      ).toHaveCount(0)
      await page.screenshot({ path: test.info().outputPath("model-first-viewport.png") })
      expect(state.writes).toEqual([])
    })

    test("approval starts before a large list and opens one review", async ({ page }) => {
      const state = await fixture(page)
      state.policy().privateUsers = [42, ...Array.from({ length: 99 }, (_, i) => 1000 + i)]
      await page.reload()
      await expect(page.locator('#save-status[data-compact="true"]')).toBeVisible()
      await navigate(page, "Access")
      const input = page.getByRole("textbox", { name: "Telegram ID to approve", exact: true })
      await inViewport(input)
      await inViewport(page.getByRole("button", { name: "Review approval", exact: true }))
      expect(await page.locator(".access-table tbody tr").count()).toBeLessThanOrEqual(22)
      await page.screenshot({ path: test.info().outputPath("access-first-viewport.png") })
      await input.fill("123")
      await page.getByRole("button", { name: "Review approval", exact: true }).click()
      const review = page.getByRole("alertdialog", { name: "Save settings changes?", exact: true })
      await expect(review).toBeVisible()
      await expect(review).toContainText("approve 123")
      expect(state.writes).toEqual([])
      await review.getByRole("button", { name: "Cancel", exact: true }).click()
      await expect(page.locator("#save-status")).toContainText("1 unsaved change")
      await expect(page.getByText("Review pending policy changes", { exact: true })).toHaveCount(0)
      await expect(page.getByText("Policy: 1 change", { exact: true })).toHaveCount(0)
      await page.getByRole("button", { name: "Review and save changes", exact: true }).click()
      await review.getByRole("button", { name: "Save changes", exact: true }).click()
      await expect.poll(() => state.policy().privateUsers).toContain(123)
      expect(state.writes).toHaveLength(1)
    })

    test("HTTP creation keeps basic fields and save together", async ({ page }) => {
      const state = await fixture(page)
      await navigate(page, "MCP connections")
      await page.getByRole("button", { name: "Add connection", exact: true }).click()
      await inViewport(page.getByRole("textbox", { name: "MCP server name", exact: true }))
      await page
        .getByRole("textbox", { name: "MCP server name", exact: true })
        .fill("review-example")
      await page.getByRole("combobox", { name: "Connection type", exact: true }).click()
      await page.getByRole("option", { name: "HTTP endpoint", exact: true }).click()
      await inViewport(page.getByRole("textbox", { name: "Connection URL", exact: true }))
      await page
        .getByRole("textbox", { name: "Connection URL", exact: true })
        .fill("https://example.com/mcp")
      await inViewport(page.getByRole("button", { name: "Save connection", exact: true }))
      await expect(
        page.getByRole("heading", { name: "Saved connections", exact: true }),
      ).toBeHidden()
      await expect(
        page.getByText("Removed by transport selection: args", { exact: true }),
      ).toBeHidden()
      await page.screenshot({ path: test.info().outputPath("connection-first-viewport.png") })
      expect(state.writes).toEqual([])
    })

    test("tool lookup filters many tools without changing permission", async ({ page }) => {
      const state = await fixture(page)
      const tools = [
        "read_url_content",
        ...Array.from({ length: 39 }, (_, i) => `example_tool_${i + 1}`),
      ]
      state.inventory.tools = tools
      state.inventory.builtInTools = tools
      state.policy().tools = tools
      state.policy().defaults.tools = tools
      await page.reload()
      await expect(page.locator('#save-status[data-compact="true"]')).toBeVisible()
      await navigate(page, "Tool permissions")
      const search = page.getByRole("textbox", { name: "Search tools and servers", exact: true })
      await inViewport(search)
      await expect(
        page.getByRole("checkbox", { name: "Globally allow tool read_url_content", exact: true }),
      ).toBeHidden()
      await page.screenshot({ path: test.info().outputPath("tools-first-viewport.png") })
      await search.fill("example_tool_39")
      await expect(page.locator(".permission-row:visible")).toHaveCount(1)
      await inViewport(
        page.getByRole("checkbox", {
          name: "Default chat permission for tool example_tool_39",
          exact: true,
        }),
      )
      await page.screenshot({ path: test.info().outputPath("tools-filtered-viewport.png") })
      await page.getByRole("button", { name: "Edit global limits", exact: true }).click()
      await expect(
        page.getByRole("checkbox", { name: "Globally allow tool example_tool_39", exact: true }),
      ).toBeVisible()
      await expect(page.locator('#save-status[data-compact="true"]')).toBeVisible()
      expect(state.writes).toEqual([])
    })

    test("configured chat starts with model and tool actions", async ({ page }) => {
      const state = await fixture(page)
      await page.locator(".chat-list button").first().click()
      await inViewport(page.getByRole("button", { name: "Change model", exact: true }))
      await inViewport(page.getByRole("button", { name: "View tool permissions", exact: true }))
      await page.screenshot({ path: test.info().outputPath("chat-first-viewport.png") })
      await expect(
        page
          .getByRole("region", { name: "Chat details", exact: true })
          .getByText("Configured locally. Model response not checked.", { exact: true }),
      ).toBeVisible()
      expect(state.writes).toEqual([])
    })
  })
}
