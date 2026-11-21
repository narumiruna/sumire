import { expect, test } from "@playwright/test"
import { adminFixture, inventory, navigate } from "./admin-fixture.js"
import { durableFixture } from "./durable-fixture.js"

for (const viewport of [
  { width: 1440, height: 900, zoom: 1 },
  { width: 768, height: 1024, zoom: 1 },
  { width: 390, height: 844, zoom: 1 },
  { width: 320, height: 844, zoom: 1 },
  { width: 640, height: 900, zoom: 2 },
]) {
  test(`workflow geometry ${viewport.width} ${viewport.zoom}x`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport)
    await adminFixture(page)
    await page.route("**/api/chats/42", (route) =>
      route.fulfill({ json: { id: 42, name: "Fixture chat", type: "private" } }),
    )
    await page.evaluate((zoom) => {
      document.documentElement.style.zoom = String(zoom)
    }, viewport.zoom)
    await page
      .getByRole("list", { name: "Chats on this page", exact: true })
      .locator(".directory-chat")
      .first()
      .click()
    for (const configured of [false, true]) {
      if (configured) {
        await page.route("**/api/inventory", (route) =>
          route.fulfill({
            json: {
              ...inventory,
              providers: inventory.providers.map((p) => ({ ...p, configured: true })),
            },
          }),
        )
        await page.getByRole("button", { name: "Refresh settings", exact: true }).click()
        await expect(page.locator(".chat-ready-summary")).toBeVisible()
      }
      await page.evaluate(() => window.scrollTo(0, 0))
      console.log(
        "CHAT",
        viewport,
        configured,
        await page.getByRole("tablist", { name: "Selected chat views" }).boundingBox(),
      )
      const tabs = await page.getByRole("tablist", { name: "Selected chat views" }).boundingBox()
      if (viewport.width === 390) {
        if (!tabs) throw new Error("Missing tab geometry")
        // The 16 px body text replaces the old 450 px density target. Keep the
        // full tab strip and the first repair action inside the initial viewport.
        expect(tabs.y).toBeGreaterThanOrEqual(0)
        expect(tabs.height).toBeGreaterThanOrEqual(44)
        expect(tabs.y + tabs.height).toBeLessThanOrEqual(viewport.height)
        await expect(
          page.getByRole("tabpanel", { name: "Overview", exact: true }).getByRole("button").first(),
        ).toBeInViewport()
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      )
      await page.screenshot({ path: testInfo.outputPath(`chat-${configured}.png`), fullPage: true })
    }
    for (const section of ["Model providers", "Tool permissions"]) {
      await navigate(page, section)
      // Open the unconfigured provider through the explicit list/detail action.
      if (section === "Model providers") {
        await page.unroute("**/api/inventory")
        await page.getByRole("button", { name: "Refresh settings", exact: true }).click()
        await page.getByRole("button", { name: "Manage provider fixture", exact: true }).click()
        await expect(page.getByText("Missing credential", { exact: true })).toBeVisible()
        await expect(page.getByRole("heading", { name: "Connection", exact: true })).toBeVisible()
      }
      await page.evaluate(() => window.scrollTo(0, 0))
      console.log(
        "HEIGHT",
        section,
        viewport,
        await page.evaluate(() => document.documentElement.scrollHeight),
      )
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      )
      const scope =
        section === "Model providers"
          ? page.getByRole("heading", { name: "Connection", exact: true })
          : page.getByRole("region", { name: "Permission editing scope", exact: true })
      await expect(scope).toBeInViewport()
      const action =
        section === "Model providers"
          ? page.getByRole("button", { name: "Configure authentication", exact: true })
          : page.getByRole("textbox", { name: "Search tools and servers", exact: true })
      // Larger text can move controls below the first viewport. Keyboard focus must
      // reveal the complete action without horizontal scrolling or fixed-bar overlap.
      await action.focus()
      const geometry = await action.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        const bar = document.querySelector("#save-status")?.getBoundingClientRect()
        return {
          top: rect.top,
          bottom: rect.bottom,
          left: rect.left,
          right: rect.right,
          height: innerHeight,
          width: innerWidth,
          barBottom: bar && bar.top <= 0 ? bar.bottom : 0,
          fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
        }
      })
      expect(geometry.top).toBeGreaterThanOrEqual(geometry.barBottom)
      expect(geometry.bottom).toBeLessThanOrEqual(geometry.height)
      expect(geometry.left).toBeGreaterThanOrEqual(0)
      expect(geometry.right).toBeLessThanOrEqual(geometry.width)
      expect(geometry.fontSize).toBe(16)
      await expect(action).toBeFocused()
      await testInfo.attach(`${section}-action-geometry`, {
        body: JSON.stringify(geometry),
        contentType: "application/json",
      })
      for (const control of await page.locator("main :is(.rt-Button, .rt-SelectTrigger)").all()) {
        if (await control.isVisible())
          expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(44 * viewport.zoom)
      }
      await page.screenshot({ path: testInfo.outputPath(`${section}.png`), fullPage: true })
    }
    await durableFixture(page)
    await page.evaluate((zoom) => {
      document.documentElement.style.zoom = String(zoom)
    }, viewport.zoom)
    await page.screenshot({ path: testInfo.outputPath("records.png"), fullPage: true })
  })
}
