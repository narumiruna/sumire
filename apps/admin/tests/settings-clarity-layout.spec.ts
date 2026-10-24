import { expect, type Locator, test } from "@playwright/test"
import { navigate } from "./admin-fixture.js"
import { clarityFixture } from "./clarity-fixture.js"
import { contrast } from "./contrast.js"

async function visibleGeometry(locator: Locator) {
  const rect = await locator.evaluate((element) => {
    const box = element.getBoundingClientRect()
    return { top: box.top, bottom: box.bottom, height: innerHeight }
  })
  expect(rect.top).toBeGreaterThanOrEqual(0)
  expect(rect.bottom).toBeLessThanOrEqual(rect.height)
  return rect
}

for (const [width, height, zoom] of [
  [1440, 900, 1],
  [390, 844, 1],
  [320, 844, 1],
  [640, 1688, 2],
] as const) {
  test(`permission headings and keyboard focus remain visible through 200 tools at ${width}px ${zoom}x`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height })
    const state = await clarityFixture(page)
    if (zoom === 2)
      await page.evaluate(() => {
        document.documentElement.style.zoom = "2"
      })
    await navigate(page, "Access")
    await page.getByRole("textbox", { name: "Telegram ID to approve", exact: true }).fill("-")
    await navigate(page, "Tool permissions")
    await page
      .getByRole("checkbox", { name: "Default chat permission for tool builtin_0", exact: true })
      .uncheck()
    await page.getByRole("button", { name: "Expand all", exact: true }).click()
    const scope = page.getByRole("region", { name: "Permission editing scope", exact: true })
    for (const name of ["builtin_1", "builtin_50", "builtin_99", "mcp__example__tool_99"]) {
      const control = page.getByRole("checkbox", {
        name: `Default chat permission for tool ${name}`,
        exact: true,
      })
      await control.evaluate((element) => element.scrollIntoView({ block: "center" }))
      await control.focus()
      await expect(control).toBeFocused()
      const bar = await page.locator("#save-status").boundingBox()
      expect(bar?.height).toBeLessThanOrEqual(height / 4 + 1)
      const controlBox = await visibleGeometry(control)
      const scopeBox = await visibleGeometry(scope)
      expect(controlBox.top).toBeGreaterThanOrEqual(scopeBox.bottom)
      if (width > 850) {
        const group = control.locator(
          "xpath=ancestor::section[contains(@class,'permission-group')]",
        )
        const heading = await visibleGeometry(group.locator(".permission-group-heading"))
        expect(heading.top).toBeGreaterThanOrEqual(scopeBox.bottom - 1)
        expect(controlBox.top).toBeGreaterThanOrEqual(heading.bottom)
      }
      await control.press("Tab")
      await page.keyboard.press("Shift+Tab")
      await expect(control).toBeFocused()
      await visibleGeometry(control)
      await info.attach(`geometry-${name}`, {
        body: JSON.stringify({ controlBox, scopeBox }),
        contentType: "application/json",
      })
    }
    await page.getByRole("button", { name: "Edit global limits", exact: true }).click()
    await expect(scope).toContainText("Editing global limits and shared defaults")
    const global = page.getByRole("checkbox", {
      name: "Globally allow tool mcp__example__tool_99",
      exact: true,
    })
    await global.evaluate((element) => element.scrollIntoView({ block: "center" }))
    await global.focus()
    await expect(global).toBeFocused()
    const globalBox = await visibleGeometry(global)
    expect(globalBox.top).toBeGreaterThanOrEqual((await visibleGeometry(scope)).bottom)
    await page.screenshot({ path: info.outputPath("permission-list-end.png") })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(state.writes).toEqual([])
  })
}

for (const [width, height] of [
  [1440, 900],
  [768, 1024],
  [390, 844],
  [320, 844],
] as const) {
  test(`settings clarity captures, entry points, and long identifiers at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height })
    const state = await clarityFixture(page)
    const id = "family/long-model-identifier-with-many-segments-for-layout-checks"
    const provider = state.inventory.providers[0]
    const firstChat = state.chats[0]
    if (!provider || !firstChat) throw new Error("Missing stress fixture data")
    provider.models.push({
      id,
      name: "Long model",
      reasoning: false,
      image: false,
      thinking: ["off"],
    })
    state.policy().models.push(`fixture/${id}`)
    state.policy().defaults.model = `fixture/${id}`
    state.policy().defaults.models = [`fixture/${id}`]
    firstChat.name = "Long chat name with several words for layout checks"
    await page.reload()
    for (const section of ["Chats", "Defaults", "Model Providers", "Tool permissions"]) {
      await navigate(page, section)
      await page.evaluate(() => window.scrollTo(0, 0))
      if (section === "Defaults") {
        await visibleGeometry(
          page.getByRole("combobox", { name: "Shared default model", exact: true }),
        )
        await expect(
          page.getByRole("combobox", { name: "Shared default model", exact: true }),
        ).toHaveAttribute("title", `fixture/${id}`)
      }
      if (section === "Tool permissions") {
        await visibleGeometry(
          page.getByRole("textbox", { name: "Search tools and servers", exact: true }),
        )
        await page.getByRole("button", { name: "Collapse all", exact: true }).click()
        await page.evaluate(() => window.scrollTo(0, 0))
      }
      if (section === "Chats") {
        const row = page.locator(".chat-list button").first()
        expect(
          await row
            .locator("strong")
            .evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize)),
        ).toBeGreaterThanOrEqual(14)
        expect(
          await row
            .locator(".directory-status-label")
            .evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize)),
        ).toBeGreaterThanOrEqual(13)
        expect((await contrast(row.locator("strong"))).text).toBeGreaterThanOrEqual(4.5)
        expect(
          (await contrast(row.locator(".directory-status-label"))).text,
        ).toBeGreaterThanOrEqual(4.5)
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      )
      await page.screenshot({ path: info.outputPath(`${section}-first.png`) })
      await page.screenshot({ path: info.outputPath(`${section}-full.png`), fullPage: true })
      const first = page.locator(".admin-page:not([hidden])").getByRole("button").first()
      await page.keyboard.press("Tab")
      await first.focus()
      await expect(first).toBeFocused()
      expect(await first.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe("none")
    }
    expect(state.writes).toEqual([])
  })
}
