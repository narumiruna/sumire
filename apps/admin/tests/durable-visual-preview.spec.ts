import { expect, type Page, test } from "@playwright/test"
import { contrast } from "./contrast.js"

// Review-only fixture. It does not replace the production Inspector or exercise its interactions.
async function addDeepBranches(page: Page) {
  await page.evaluate(() => {
    const original = document.querySelector(".dv-branch.dv-role-call")?.parentElement
    let target = document.querySelector(".dv-branch.dv-role-call > ul")
    if (!original || !target) throw new Error("Missing synthetic tool branch")
    const template = original.cloneNode(true) as HTMLElement
    for (let index = 1; index <= 14; index++) {
      const row = template.cloneNode(true) as HTMLElement
      const list = row.querySelector("ul")
      const summary = row.querySelector("summary")
      const label = row.querySelector(".dv-row-label")
      if (!list || !summary || !label) throw new Error("Incomplete synthetic branch")
      list.replaceChildren()
      label.textContent =
        index === 14
          ? "Nested tool with a long namespace and a complete readable record name"
          : `Nested tool ${index}`
      summary.setAttribute("aria-label", `Toggle nested tool ${index} records`)
      target.append(row)
      target = list
    }
  })
}
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
        expect(
          await text.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
        ).toBeGreaterThanOrEqual(14)
        if (viewport.width <= 650) expect((await text.boundingBox())?.y).toBeLessThanOrEqual(410)
      } else {
        const output = selected.locator(".dv-output")
        await expect(output).toBeVisible()
        if (viewport.width <= 650) expect((await output.boundingBox())?.y).toBeLessThanOrEqual(410)
        expect(await output.evaluate((element) => getComputedStyle(element).fontFamily)).toContain(
          "monospace",
        )
        expect(
          await output.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
        ).toBeGreaterThanOrEqual(14)
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
      if (viewport.width < 1100) await page.locator(".dv-browse-trigger").click()
      for (const selector of [".dv-row-caption", ".dv-record-id", ".dv-tree-badge"]) {
        for (const text of await navigator.locator(selector).all()) {
          expect(
            (await contrast(text)).text,
            `${selector} must remain readable`,
          ).toBeGreaterThanOrEqual(4.5)
        }
      }
      expect(
        await navigator
          .locator(".dv-row-label")
          .first()
          .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
      ).toBeGreaterThanOrEqual(14)
      if (viewport.width < 1100) await page.locator(".dv-browse-trigger").click()
      if (viewport.width <= 650) {
        for (const name of ["Refresh", "Switch chat"]) {
          const button = page.getByRole("button", { name, exact: true })
          await expect(button).toBeVisible()
          const bounds = await button.boundingBox()
          expect(bounds?.width).toBeGreaterThanOrEqual(44)
          expect(bounds?.height).toBeGreaterThanOrEqual(44)
        }
      }
      expect(
        await selected
          .locator(".dv-detail-header")
          .evaluate((element) => getComputedStyle(element).backgroundImage),
      ).toBe("none")
      await page.screenshot({ path: testInfo.outputPath("preview.png"), fullPage: true })
    })
  }
}

for (const width of [1440, 390, 320]) {
  test(`deep preview stays readable without stretching details at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto("/tests/fixtures/durable-visual-preview.html?record=tool")
    const detail = page.getByRole("article", { name: "Selected record", exact: true })
    await expect(detail).toBeVisible()
    if (width < 1100) await page.locator(".dv-browse-trigger").click()
    const before = await detail.boundingBox()
    const footerBefore = await detail.locator(".dv-detail-footer").boundingBox()
    await addDeepBranches(page)
    const after = await detail.boundingBox()
    expect(before).not.toBeNull()
    expect(after).not.toBeNull()
    expect(Math.abs((after?.height ?? 0) - (before?.height ?? 0))).toBeLessThanOrEqual(1)
    if (width >= 1100) {
      const footerAfter = await detail.locator(".dv-detail-footer").boundingBox()
      expect(Math.abs((footerAfter?.y ?? 0) - (footerBefore?.y ?? 0))).toBeLessThanOrEqual(1)
    }
    const browser = page.locator(".dv-browser")
    expect(await browser.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    )
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const last = page.locator('.dv-branch > summary[aria-label="Toggle nested tool 14 records"]')
    await last.scrollIntoViewIfNeeded()
    await expect(last).toBeInViewport()
    const bounds = await last.boundingBox()
    const navBounds = await browser.boundingBox()
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(
      (navBounds?.x ?? 0) + (navBounds?.width ?? 0),
    )
    expect(
      await last
        .locator(".dv-row-label")
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true)
    await last.focus()
    await page.keyboard.press("Space")
    await page.keyboard.press("Space")
    expect(await last.evaluate((element) => element.matches(":focus-visible"))).toBe(true)
    expect(await last.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("solid")
    await page.screenshot({ path: testInfo.outputPath("deep-preview.png"), fullPage: true })
  })
}

test("narrow tool preview keeps the result badge beside wider fallback-font titles", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 844 })
  await page.goto("/tests/fixtures/durable-visual-preview.html?record=tool")
  await page.addStyleTag({ content: ".dv-preview { font-family: Verdana, sans-serif; }" })
  const title = page.locator(".dv-detail-titles")
  const badge = page.locator(".dv-result-status")
  await expect(title.getByRole("heading", { name: "codemode", exact: true })).toBeVisible()
  await expect(badge).toHaveText("Succeeded")
  const titleBox = await title.boundingBox()
  const badgeBox = await badge.boundingBox()
  expect(titleBox).not.toBeNull()
  expect(badgeBox).not.toBeNull()
  expect(badgeBox?.y).toBeGreaterThanOrEqual(titleBox?.y ?? 0)
  expect((badgeBox?.y ?? 0) + (badgeBox?.height ?? 0)).toBeLessThanOrEqual(
    (titleBox?.y ?? 0) + (titleBox?.height ?? 0),
  )
  expect(await title.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  expect((await page.locator(".dv-output").boundingBox())?.y).toBeLessThanOrEqual(410)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath("fallback-font-preview.png"), fullPage: true })
})
