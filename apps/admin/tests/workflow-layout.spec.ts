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
      .getByRole("button")
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
        await page.getByRole("button", { name: "Reload", exact: true }).click()
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
        // The 16px layout places the unconfigured tab row bottom at 458px.
        expect(tabs.y + tabs.height).toBeLessThanOrEqual(480)
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
      // Use the same unconfigured provider and open authentication as the review fixture.
      if (section === "Model providers") {
        await page.unroute("**/api/inventory")
        await page.getByRole("button", { name: "Reload", exact: true }).click()
        await expect(
          page
            .getByRole("region", { name: "Model providers", exact: true })
            .getByText("Authentication required", { exact: true }),
        ).toBeVisible()
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
      if (viewport.width === 1440) {
        // Measured at 1044px and 980px with the 16px body; allow one 44px control row.
        const maxHeight = section === "Model providers" ? 1088 : 1024
        expect(
          await page.evaluate(() => document.documentElement.scrollHeight),
        ).toBeLessThanOrEqual(maxHeight)
      }
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
