import { expect, test } from "@playwright/test"
import { adminFixture } from "./admin-fixture.js"

for (const width of [1440, 390]) {
  test(`shares the browser icon with navigation at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    await adminFixture(page)

    const icon = page.locator(".brand .brand-icon")
    await expect(icon).toBeVisible()
    await expect(icon).toHaveAttribute("alt", "")
    await expect(icon).toHaveAttribute("aria-hidden", "true")
    await expect(icon).toHaveCSS("width", width > 650 ? "42px" : "28px")
    await expect(icon).toHaveCSS("height", width > 650 ? "42px" : "28px")
    await expect(page.getByRole("heading", { name: "Sumire", exact: true })).toBeVisible()
    await expect
      .poll(() =>
        icon.evaluate(
          (element) =>
            element instanceof HTMLImageElement && element.complete && element.naturalWidth === 64,
        ),
      )
      .toBe(true)

    const favicon = page.locator('link[rel="icon"]')
    await expect(favicon).toHaveAttribute("type", "image/svg+xml")
    expect(await icon.getAttribute("src")).toBe(await favicon.getAttribute("href"))
    const response = await page.request.get((await favicon.getAttribute("href")) ?? "")
    expect(response.status()).toBe(200)
    expect(response.headers()["content-type"]).toContain("image/svg+xml")
    expect(await response.text()).toContain("<svg")
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`navigation-icon-${width}.png`) })
  })
}

for (const setup of [false, true]) {
  test(`shows the icon before ${setup ? "passkey registration" : "sign-in"}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.route("**/api/**", (route) =>
      route.fulfill({ status: 401, json: { error: "Sign in with a passkey" } }),
    )
    await page.goto(setup ? `/#setup=${"a".repeat(43)}` : "/")
    await expect(
      page.getByRole("button", { name: setup ? "Register passkey" : "Sign in with passkey" }),
    ).toBeVisible()

    const icon = page.locator(".session-card > .brand-icon")
    await expect(icon).toBeVisible()
    await expect(icon).toHaveCSS("width", "48px")
    await expect(icon).toHaveCSS("height", "48px")
    await expect
      .poll(() =>
        icon.evaluate(
          (element) =>
            element instanceof HTMLImageElement && element.complete && element.naturalWidth === 64,
        ),
      )
      .toBe(true)
    expect(await icon.getAttribute("src")).toBe(
      await page.locator('link[rel="icon"]').getAttribute("href"),
    )
    await page.screenshot({ path: testInfo.outputPath("session-icon.png") })
  })
}
