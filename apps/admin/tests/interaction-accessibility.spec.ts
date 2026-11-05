import { expect, test } from "@playwright/test"
import { adminFixture, navigate, sectionLabel, sections } from "./admin-fixture.js"
import { contrast } from "./contrast.js"

for (const mode of ["font", "zoom"] as const) {
  test(`200% ${mode} enlargement retains the ten page workflows`, async ({ page }, testInfo) => {
    test.setTimeout(90000)
    await page.setViewportSize({ width: mode === "font" ? 1440 : 640, height: 1000 })
    const requests = await adminFixture(page)
    const client = mode === "font" ? await page.context().newCDPSession(page) : undefined
    if (mode === "zoom")
      await page.evaluate(() => {
        document.documentElement.style.zoom = "2"
      })
    for (const section of sections) {
      await navigate(page, section)
      // Chromium resets this CDP override on same-document history navigation.
      // Reapply it to each page, then verify that the measured body text doubled.
      if (client) await client.send("Page.setFontSizes", { fontSizes: { standard: 32 } })
      await expect(page.locator("#current-section-heading")).toHaveText(
        ["Chats", "Access"].includes(section) ? "Chats" : sectionLabel(section),
      )
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      )
      await expect(
        page.getByRole("alert").filter({ hasText: "could not be displayed" }),
      ).toHaveCount(0)
      if (mode === "font") {
        expect(
          await page
            .locator(".radix-themes")
            .first()
            .evaluate((node) => getComputedStyle(node).fontSize),
        ).toBe("32px")
      }
      const focusables = page.locator("main :is(button,a,input,summary)")
      for (const control of await focusables.all()) {
        if (!(await control.isVisible()) || !(await control.isEnabled())) continue
        await control.focus()
        expect(await control.evaluate((node) => node === document.activeElement)).toBe(true)
      }
      await page.evaluate(() => scrollTo(0, 0))
      await page.screenshot({ path: testInfo.outputPath(`${mode}-${section}.png`), fullPage: true })
    }
    expect(requests.every((request) => request.startsWith("GET "))).toBe(true)
  })
}

test("account remains keyboard-accessible in the sidebar at 320px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 })
  await adminFixture(page)
  const account = page
    .getByRole("complementary", { name: "Administration navigation" })
    .getByRole("button", { name: "Account", exact: true })
  await account.focus()
  await account.press("Enter")
  await expect(page.getByRole("menuitem", { name: "Sign out" })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(account).toBeFocused()
  expect((await contrast(account)).text).toBeGreaterThanOrEqual(4.5)
})
