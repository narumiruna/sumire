import { expect, test } from "@playwright/test"
import { contrast } from "./contrast.js"

for (const color of [
  { name: "RGB", ink: "rgb(0 0 0)", paper: "rgb(255 255 255)" },
  { name: "OKLCH", ink: "oklch(0% 0 0)", paper: "oklch(100% 0 0)" },
]) {
  test(`contrast measures ${color.name} colors in sRGB`, async ({ page }) => {
    await page.setContent(
      `<div style="background: ${color.paper}"><span style="color: ${color.ink}; border: 1px solid ${color.ink}">Text</span></div>`,
    )
    const result = await contrast(page.locator("span"))
    expect(result.text).toBeCloseTo(21, 2)
    expect(result.border).toBeCloseTo(21, 2)
  })

  test(`contrast rejects low-contrast ${color.name} text`, async ({ page }) => {
    await page.setContent(
      `<span style="color: ${color.paper}; background: ${color.paper}">Text</span>`,
    )
    expect((await contrast(page.locator("span"))).text).toBeCloseTo(1, 2)
  })
}

test("contrast measures equivalent RGB and OKLCH brand tokens", async ({ page }) => {
  await page.setContent(`
    <div style="background: #f8f6f1"><span id="rgb" style="color: #252824">Text</span></div>
    <div style="background: oklch(97.3% 0.007 89)"><span id="oklch" style="color: oklch(27.2% 0.008 138)">Text</span></div>
  `)
  const rgb = await contrast(page.locator("#rgb"))
  const oklch = await contrast(page.locator("#oklch"))
  expect(oklch.text).toBeCloseTo(rgb.text, 1)
  expect(oklch.text).toBeGreaterThanOrEqual(4.5)
})

test("contrast composites translucent OKLCH text and ancestor backgrounds", async ({ page }) => {
  await page.setContent(`
    <div style="background: white">
      <div style="background: oklch(0% 0 0 / 50%)">
        <span style="color: oklch(0% 0 0 / 50%); border: 1px solid oklch(0% 0 0)">Text</span>
      </div>
    </div>
  `)
  const result = await contrast(page.locator("span"))
  expect(result.background).toEqual([127, 127, 127, 1])
  expect(result.text).toBeGreaterThan(2)
  expect(result.text).toBeLessThan(3)
  expect(result.border).toBeGreaterThanOrEqual(5)
})
