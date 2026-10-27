import { expect, test } from "@playwright/test"
import { navigate, openDisclosure } from "./admin-fixture.js"
import { policyRecoveryFixture } from "./policy-recovery-fixture.js"

for (const mode of [
  { width: 1440, height: 900, zoom: 1 },
  { width: 390, height: 844, zoom: 1 },
  { width: 320, height: 844, zoom: 1 },
  { width: 640, height: 900, zoom: 2 },
]) {
  test(`recovery and labelled controls reflow at ${mode.width}px with ${mode.zoom}x CSS zoom`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: mode.width, height: mode.height })
    const fixture = await policyRecoveryFixture(page)
    await navigate(page, "Defaults")
    await page.getByRole("combobox", { name: "Shared default thinking", exact: true }).click()
    await page.getByRole("option", { name: "high", exact: true }).click()
    await page.evaluate((zoom) => {
      document.documentElement.style.zoom = String(zoom)
    }, mode.zoom)
    await page.screenshot({
      path: testInfo.outputPath("draft.png"),
      fullPage: true,
      animations: "disabled",
    })
    fixture.advance((policy) => {
      policy.defaults.thinking = "low"
    })
    await page.getByRole("button", { name: "Review and save changes", exact: true }).click()
    await page.getByRole("button", { name: "Save changes", exact: true }).click()
    const error = page.getByRole("alert")
    await expect(error).toBeFocused()
    await expect(error).toBeInViewport({ ratio: 1 })
    const bar = page.locator(".changes-bar")
    const errorBox = await error.boundingBox()
    const barBox = await bar.boundingBox()
    if (!errorBox || !barBox) throw new Error("Missing error or bar geometry")
    expect(errorBox.y + errorBox.height).toBeLessThanOrEqual(barBox.y)
    await page.screenshot({ path: testInfo.outputPath("save-error.png"), animations: "disabled" })
    await page.getByRole("button", { name: "Load latest and review draft", exact: true }).click()
    const dialog = page.getByRole("dialog", {
      name: "Review recovered settings draft",
      exact: true,
    })
    await expect(dialog).toBeVisible()
    await page.screenshot({
      path: testInfo.outputPath("recovery-open.png"),
      animations: "disabled",
    })
    await expect(dialog).toBeInViewport({ ratio: 1 })
    const choose = dialog.getByRole("radio", { name: "Use draft value", exact: true })
    await choose.focus()
    await expect(choose).toBeFocused()
    await expect(choose).toBeInViewport({ ratio: 1 })
    const radioBox = await choose.boundingBox()
    const labelBox = await choose.locator("..").boundingBox()
    const textBox = await choose.locator("..").locator(".rt-RadioGroupItemInner").boundingBox()
    if (!radioBox || !labelBox || !textBox) throw new Error("Missing radio label geometry")
    expect(labelBox.height).toBeGreaterThanOrEqual(44 * mode.zoom)
    expect(
      Math.abs(radioBox.y + radioBox.height / 2 - textBox.y - textBox.height / 2),
    ).toBeLessThan(2 * mode.zoom)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({
      path: testInfo.outputPath("recovery-keyboard-focus.png"),
      animations: "disabled",
    })
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
    await navigate(page, "Audit")
    await openDisclosure(page, "Filters")
    await page.keyboard.press("Tab")
    const result = page.getByRole("combobox", { name: "Result", exact: true })
    await result.focus()
    await expect(result).toBeInViewport({ ratio: 1 })
    const resultBox = await result.boundingBox()
    const currentBar = await bar.boundingBox()
    if (!resultBox || !currentBar) throw new Error("Missing result or bar geometry")
    expect(resultBox.y + resultBox.height).toBeLessThanOrEqual(currentBar.y)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({
      path: testInfo.outputPath("audit-keyboard-focus.png"),
      fullPage: true,
      animations: "disabled",
    })
    expect(fixture.writes).toHaveLength(1)
  })
}
