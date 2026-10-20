import { expect, test } from "@playwright/test"
import { adminFixture, navigate, sections } from "./admin-fixture.js"
import { contrast } from "./contrast.js"

const record = {
  id: 1,
  time: Date.UTC(2026, 9, 20, 10, 24),
  actor: "42",
  operation: "settings.update",
  revision: 1,
  outcome: "saved",
  target: "settings",
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
  { width: 320, height: 844 },
]) {
  test(`all production pages use the shared Radix workspace at ${viewport.width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport)
    const requests = await adminFixture(page, [record])
    await page.route("**/api/chats/42", (route) =>
      route.fulfill({ json: { id: 42, name: "Fixture chat", type: "private" } }),
    )
    await page.route("**/api/chats/42/durable?*", (route) => {
      const view = new URL(route.request().url()).searchParams.get("view") ?? "conversations"
      return route.fulfill({
        json: {
          version: 1,
          state: "loaded",
          readAt: "2026-10-20T10:24:00.000Z",
          view,
          items: [],
          selectedConversation: null,
          truncated: false,
        },
      })
    })
    await page
      .getByRole("list", { name: "Chats on this page", exact: true })
      .getByRole("button")
      .first()
      .click()
    await expect(page.locator(".chat-header")).toContainText("Fixture chat")
    for (const section of sections) {
      await navigate(page, section)
      const heading = page.locator("#current-section-heading")
      await expect(heading).toHaveCount(1)
      await expect(heading).toHaveText(section)
      await expect(heading).toBeVisible()
      if (section === "MCP connections") {
        const permissions = page.getByRole("button", {
          name: "Manage tool and MCP server permissions",
          exact: true,
        })
        const box = await permissions.boundingBox()
        expect(box?.width).toBeGreaterThanOrEqual(160)
        expect(box?.height).toBeLessThanOrEqual(96)
        expect(
          (
            await page
              .getByRole("heading", { name: "MCP connections — saved separately" })
              .boundingBox()
          )?.width,
        ).toBeGreaterThanOrEqual(200)
      }
      if (section === "Model providers") {
        await page.getByRole("button", { name: "Model", exact: true }).click()
        const popup = page.getByRole("dialog", { name: "Choose model", exact: true })
        await expect(popup).toBeVisible()
        const box = await popup.boundingBox()
        expect(box?.height).toBeLessThan(viewport.height)
        await expect(page.getByRole("option", { name: /Other/ })).toBeInViewport()
        await page.getByRole("combobox", { name: "Search model", exact: true }).press("Escape")
      }
      await expect(page.locator(".radix-themes").first()).toHaveAttribute("data-gray-color", "sand")
      expect((await contrast(heading)).text, `${section} heading contrast`).toBeGreaterThanOrEqual(
        4.5,
      )
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `${section} page width`,
      ).toBe(true)
      await expect(
        page.getByRole("alert").filter({ hasText: "could not be displayed" }),
      ).toHaveCount(0)
      for (const button of await page.locator("main :is(.rt-Button, .rt-SelectTrigger)").all()) {
        if (!(await button.isVisible())) continue
        expect(
          (await button.boundingBox())?.height,
          `${section} touch target`,
        ).toBeGreaterThanOrEqual(44)
      }
      for (const panel of await page.locator("main .panel").all()) {
        if (!(await panel.isVisible())) continue
        await expect(panel).toHaveCSS("border-radius", "8px")
        await expect(panel).toHaveCSS("border-top-style", "solid")
        await expect(panel).toHaveCSS("border-top-width", "1px")
      }
      await page.evaluate(() => window.scrollTo(0, 0))
      await page.screenshot({
        path: testInfo.outputPath(`${section.toLowerCase().replaceAll(" ", "-")}.png`),
        fullPage: true,
      })
    }
    expect(requests.every((request) => request.startsWith("GET "))).toBe(true)
  })
}
