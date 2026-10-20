import { expect, test } from "@playwright/test"
import { contrast } from "./contrast.js"

// Review-only fixture. It does not replace the production Inspector or exercise its interactions.
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
  { width: 320, height: 844 },
]) {
  for (const record of ["user", "tool"] as const) {
    test(`visual preview: ${record} at ${viewport.width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport)
      const apiReads: string[] = []
      page.on("request", (request) => {
        if (new URL(request.url()).pathname.startsWith("/api/")) apiReads.push(request.url())
      })
      await page.goto(`/tests/fixtures/durable-visual-preview.html?record=${record}`)
      const workspace = page.getByRole("region", { name: "Preview workspace", exact: true })
      const selected = page.getByRole("article", { name: "Selected record", exact: true })
      await expect(workspace).toBeVisible()
      await expect(
        selected.getByRole("heading", {
          name: record === "user" ? "User message" : "codemode",
          exact: true,
        }),
      ).toBeVisible()
      await expect(page.locator("body")).toContainText(/design preview/i)
      await expect(page.locator("body")).toContainText(/synthetic/i)
      expect(apiReads).toEqual([])
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true)
      if (record === "user") {
        const text = selected.locator(".dv-message-text")
        await expect(text).toContainText("Read README.md and summarize the setup steps.")
        expect(
          await text.evaluate((element) => getComputedStyle(element).fontFamily),
        ).not.toContain("monospace")
      } else {
        const output = selected.locator(".dv-output")
        await expect(output).toBeVisible()
        expect(await output.evaluate((element) => getComputedStyle(element).fontFamily)).toContain(
          "monospace",
        )
        expect(
          await output.evaluate((element) => element.scrollHeight <= element.clientHeight),
        ).toBe(true)
      }
      const navigator = page.getByRole("navigation", { name: "Record navigator", exact: true })
      if (viewport.width >= 1100) {
        await expect(navigator).toBeVisible()
        const bounds = await navigator.boundingBox()
        expect(bounds?.width).toBeGreaterThanOrEqual(288)
        expect(bounds?.width).toBeLessThanOrEqual(336)
        expect(bounds?.y).toBeLessThan(900)
        const current = navigator.locator('[aria-current="page"]')
        await expect(current).toHaveCount(1)
        expect((await contrast(current)).text).toBeGreaterThanOrEqual(4.5)
      } else {
        await expect(navigator).toBeHidden()
        expect((await selected.boundingBox())?.y).toBeLessThan(viewport.height)
      }
      await page.screenshot({ path: testInfo.outputPath("preview.png"), fullPage: true })
    })
  }
}
