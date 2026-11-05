import { expect, test } from "@playwright/test"
import { adminFixture, navigate, sectionLabel, sections } from "./admin-fixture.js"
import { contrast } from "./contrast.js"

for (const width of [1440, 1024, 768, 390, 320]) {
  test(`interaction structure page evidence at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    const requests = await adminFixture(page, [
      {
        id: 1,
        time: Date.UTC(2026, 10, 5),
        actor: "42",
        operation: "settings.update",
        revision: 1,
        outcome: "saved",
        target: "settings",
      },
    ])
    const measurements = []
    for (const section of sections) {
      await navigate(page, section)
      await page.evaluate(() => window.scrollTo(0, 0))
      const heading = page.locator("#current-section-heading")
      if (section === "Chats") {
        const directory = await page.locator(".chat-directory").boundingBox()
        const header = await page.locator(".workspace-header").boundingBox()
        expect(directory && header && Math.abs(directory.width - header.width) < 2).toBe(true)
      }
      await expect(heading).toHaveText(sectionLabel(section))
      await expect(page.locator(".page-breadcrumb")).toHaveCount(0)
      expect(
        await heading.evaluate((node) => parseFloat(getComputedStyle(node).fontSize)),
      ).toBeGreaterThanOrEqual(28)
      expect(
        await heading.evaluate((node) => parseFloat(getComputedStyle(node).fontSize)),
      ).toBeLessThanOrEqual(32)
      expect(
        await page
          .locator(".radix-themes")
          .first()
          .evaluate((node) => getComputedStyle(node).fontSize),
      ).toBe("16px")
      expect((await contrast(heading)).text).toBeGreaterThanOrEqual(4.5)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      )
      measurements.push(
        await page.evaluate((section) => {
          const heading = document.querySelector("#current-section-heading")
          const navigation = document.querySelector("#section-navigation a")
          return {
            section,
            height: document.documentElement.scrollHeight,
            title: heading && getComputedStyle(heading).fontSize,
            navigation: navigation && getComputedStyle(navigation).fontSize,
            body: getComputedStyle(document.querySelector(".radix-themes") ?? document.body)
              .fontSize,
          }
        }, section),
      )
      const name = section.replaceAll(/[^a-z0-9]/gi, "-")
      await page.screenshot({ path: testInfo.outputPath(`${name}-first.png`) })
      await page.screenshot({ path: testInfo.outputPath(`${name}-full.png`), fullPage: true })
    }
    expect(requests.every((request) => request.startsWith("GET "))).toBe(true)
    await testInfo.attach("measurements-and-requests", {
      body: JSON.stringify({ width, measurements, requests }, null, 2),
      contentType: "application/json",
    })
    console.log("INTERACTION_MEASUREMENTS", JSON.stringify({ width, measurements, requests }))
  })
}
