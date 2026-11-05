import { expect, test } from "@playwright/test"
import { adminDesignFixture } from "./admin-design-fixture.js"
import { navigate, openProviderDetail } from "./admin-fixture.js"
import { contrast } from "./contrast.js"

const destinations = [
  ["Chats", "聊天管理"],
  ["Defaults", "共用設定"],
  ["Model Providers", "模型供應商"],
  ["Tool permissions", "工具權限"],
  ["Skills", "技能管理"],
  ["MCP connections", "MCP 伺服器"],
  ["Secrets & variables", "密鑰與變數"],
  ["GitHub mentions", "GitHub 提及"],
  ["Audit", "稽核紀錄"],
  ["Durable", "對話紀錄"],
] as const

for (const [width, height, zoom] of [
  [320, 844, 1],
  [390, 844, 1],
  [768, 1024, 1],
  [1440, 1000, 1],
  [640, 1688, 2],
] as const) {
  test(`all ten pages share the design without overflow at ${width}px ${zoom}x`, async ({
    page,
  }, info) => {
    test.setTimeout(90000)
    await page.setViewportSize({ width, height })
    const fixture = await adminDesignFixture(page)
    if (zoom === 2)
      await page.evaluate(() => {
        document.documentElement.style.zoom = "2"
      })
    for (const [section, title] of destinations) {
      if (section === "Durable") {
        await navigate(page, "Chats")
        await page.locator(".chat-card-name").click()
      }
      await navigate(page, section)
      await page.evaluate(() => window.scrollTo(0, 0))
      const heading = page.locator("#current-section-heading")
      await expect(heading).toHaveText(title)
      await expect(heading).toHaveCSS("font-size", "30px")
      await expect(page.locator(".admin-shell > main")).toHaveCSS(
        "background-color",
        "rgb(250, 250, 249)",
      )
      expect((await contrast(heading)).text).toBeGreaterThanOrEqual(4.5)
      await expect(page.locator(".changes-bar")).toHaveCount(0)
      await expect(page.locator(".settings-saved-toast")).toHaveCount(0)
      if (section === "Durable") await expect(page.locator(".durable-inspector")).toBeVisible()
      else {
        const details = page.locator("#saved-settings-details")
        await expect(details).toBeVisible()
        expect(await details.getAttribute("open")).toBeNull()
      }
      if (section === "Secrets & variables")
        await expect(
          page.getByRole("heading", { name: "DEMO_SERVICE_TOKEN", exact: true }),
        ).toBeVisible()
      if (section === "GitHub mentions")
        await expect(
          page.getByRole("button", { name: "Reload local GitHub metadata", exact: true }),
        ).toBeEnabled()
      if (section === "Audit") await expect(page.locator(".activity-group").first()).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      )
      for (const control of await page
        .locator("main :is(button, input, select, textarea):visible")
        .all()) {
        const bounds = await control.boundingBox()
        if (!bounds) continue
        const label =
          (await control.getAttribute("aria-label")) ?? (await control.textContent()) ?? "control"
        expect(bounds.x, label).toBeGreaterThanOrEqual(-1)
        expect(bounds.x + bounds.width, label).toBeLessThanOrEqual(width + 1)
      }
      await page.screenshot({
        path: info.outputPath(`${section.toLowerCase().replaceAll(" ", "-")}.png`),
        fullPage: true,
      })
    }
    expect(fixture.methods.every((method) => method === "GET")).toBe(true)
  })
}

test("provider filters and independent add-provider search never write policy or credentials", async ({
  page,
}) => {
  const fixture = await adminDesignFixture(page)
  await navigate(page, "Model Providers")
  const cards = page.locator(".provider-card")
  await expect(cards).toHaveCount(2)
  const filters = page.getByRole("group", { name: "Provider status" })
  await filters.getByRole("button", { name: "已設定", exact: true }).click()
  await expect(cards).toHaveCount(1)
  await expect(cards).toContainText("Alpha")
  await filters.getByRole("button", { name: "需處理", exact: true }).click()
  await expect(cards).toHaveCount(1)
  await expect(cards).toContainText("Beta")
  await page.getByRole("textbox", { name: "Search providers" }).fill("nothing matches")
  await expect(cards).toHaveCount(0)
  await expect(page.getByText("沒有符合條件的供應商。請調整搜尋或狀態篩選。")).toBeVisible()
  await page.getByRole("button", { name: "Add provider", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Set up provider fixture", exact: true }),
  ).toBeVisible()
  await page.getByRole("button", { name: "Back to providers", exact: true }).click()
  await page.getByRole("textbox", { name: "Search providers" }).fill("")
  await filters.getByRole("button", { name: "全部", exact: true }).click()
  await expect(cards).toHaveCount(2)
  expect(fixture.methods.every((method) => method === "GET")).toBe(true)
})

for (const width of [390, 1440]) {
  test(`expanded editors and review dialog stay in the shared style at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 1000 })
    const fixture = await adminDesignFixture(page)
    await navigate(page, "Model Providers")
    await openProviderDetail(page)
    await page.screenshot({ path: info.outputPath("provider-detail.png"), fullPage: true })
    await navigate(page, "MCP connections")
    await page.getByRole("button", { name: "Add connection", exact: true }).click()
    await page.screenshot({ path: info.outputPath("mcp-editor.png"), fullPage: true })
    await navigate(page, "Secrets & variables")
    await expect(
      page.getByRole("heading", { name: "DEMO_SERVICE_TOKEN", exact: true }),
    ).toBeVisible()
    await page.getByRole("tab", { name: "Variables", exact: true }).click()
    await expect(page.getByText("台灣", { exact: true })).toBeVisible()
    await page.screenshot({ path: info.outputPath("variables.png"), fullPage: true })
    await navigate(page, "Tool permissions")
    await page
      .getByRole("checkbox", { name: "Default chat permission for tool read", exact: true })
      .uncheck()
    await expect(page.locator(".changes-bar")).toBeVisible()
    await page.getByRole("button", { name: "Review and save changes", exact: true }).click()
    await expect(page.getByRole("alertdialog")).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath("review-dialog.png"), fullPage: true })
    expect(fixture.methods.every((method) => method === "GET")).toBe(true)
    expect(fixture.policy.defaults.tools).toContain("read")
  })
}

for (const width of [320, 1440]) {
  test(`signed-out page uses the same palette and readable card at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 })
    await page.route("**/api/**", (route) =>
      route.fulfill({ status: 401, json: { error: "Administrator access required" } }),
    )
    await page.goto("/")
    await expect(
      page.getByRole("button", { name: "Sign in with passkey", exact: true }),
    ).toBeVisible()
    await expect(page.locator(".session-card")).toHaveCSS("border-radius", "12px")
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath("sign-in.png"), fullPage: true })
  })
}
