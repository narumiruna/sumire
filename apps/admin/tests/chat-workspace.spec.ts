import { expect, type Page, test } from "@playwright/test"

const longName = "🌸🧑🏽‍💻 管理員測試超級群組 日本語と中文 🚀 ".repeat(6)
const chats = Array.from({ length: 100 }, (_, i) => ({
  id: -1000 - i,
  name:
    i === 0
      ? longName
      : i === 1
        ? "Short"
        : i < 4
          ? "Same name"
          : i === 4
            ? "Unbroken".repeat(40)
            : `Group ${i}`,
  type: "supergroup",
}))
async function fixture(page: Page) {
  const requests: string[] = []
  await page.route("**/api/**", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    if (path === "/api/chats") {
      expect(request.method()).toBe("GET")
      const id = url.searchParams.get("id")
      if (id !== null) {
        // Explicit selection now reads exact metadata; other requests remain forbidden below.
        expect([...url.searchParams.keys()]).toEqual(["id"])
        await route.fulfill({ json: chats.filter((chat) => String(chat.id) === id) })
        return
      }
      const query = (url.searchParams.get("q") ?? "").toLowerCase()
      const offset = Number(url.searchParams.get("offset") ?? 0)
      requests.push(`${request.method()} ${path}`)
      await route.fulfill({
        json: chats
          .filter((chat) => chat.name.toLowerCase().includes(query) || String(chat.id) === query)
          .slice(offset, offset + 100),
      })
      return
    }
    requests.push(`${request.method()} ${path}`)
    const data: Record<string, unknown> = {
      "/api/session": { csrf: "fixture", actor: "42" },
      "/api/settings": {
        revision: 1,
        applied: 1,
        status: "applied",
        policy: {
          tools: [],
          servers: [],
          models: ["fixture/test"],
          providers: [],
          defaults: {
            tools: [],
            servers: [],
            models: ["fixture/test"],
            model: "fixture/test",
            thinking: "off",
          },
          privateUsers: [],
          groups: [-1000, -1002],
          chats: {},
        },
      },
      "/api/inventory": {
        tools: [],
        builtInTools: [],
        mcp: [],
        providers: [
          {
            id: "fixture",
            name: "Fixture",
            configured: false,
            apiKey: true,
            oauth: false,
            models: [
              { id: "test", name: "Test", thinking: ["off"], reasoning: false, image: false },
            ],
          },
        ],
      },
      "/api/chats": chats,
      "/api/audit": [],
      "/api/imports": [],
    }
    await route.fulfill({ json: data[path] ?? {} })
  })
  await page.goto("/")
  await expect(page.getByRole("list", { name: "Chats on this page" })).toBeVisible()
  return requests
}
async function select(page: Page, index: number) {
  const back = page.getByRole("button", { name: "Back to chat directory" })
  if (await back.isVisible()) await back.click()
  await page.locator(".chat-list button").nth(index).click()
  await expect(page.locator(".chat-header code")).toHaveText(String(chats[index]?.id))
}
test("keeps a directory below a tall API error usable after document scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const requests = await fixture(page)
  await page.route("**/api/settings", (route) =>
    route.fulfill({
      status: 500,
      json: { error: "Fixture API failure. ".repeat(300) },
    }),
  )
  await page.getByRole("button", { name: "Reload", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("Fixture API failure.")
  const workspace = page.locator(".chat-workspace")
  expect(
    await workspace.evaluate((el) => el.getBoundingClientRect().top + window.scrollY),
  ).toBeGreaterThan(900)
  const list = page.locator(".directory-list-region")
  await expect.poll(() => list.evaluate((el) => el.clientHeight)).toBeGreaterThan(80)
  requests.length = 0
  for (const index of [0, 50, 99]) {
    const row = page.locator(".chat-list button").nth(index)
    await row.scrollIntoViewIfNeeded()
    await expect(row).toBeInViewport()
    await row.click()
    await expect(page.locator(".chat-header code")).toHaveText(String(chats[index]?.id))
  }
  const lastBox = await page.locator(".chat-list button").last().boundingBox()
  const footerBox = await page.locator(".directory-footer").boundingBox()
  if (!lastBox || !footerBox) throw new Error("Missing directory geometry")
  expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(footerBox.y)
  await expect(page.locator(".pending-bar")).toHaveCount(0)
  expect(requests).toEqual([])
  await page.unroute("**/api/settings")
  await page.getByRole("button", { name: "Reload", exact: true }).click()
  await expect(page.getByRole("alert")).toHaveCount(0)
  await expect(page.locator(".chat-directory")).toHaveCSS("position", "sticky")
  await expect.poll(() => list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
})

for (const width of [390, 850]) {
  test(`restores directory scroll for an unobserved chat at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const requests = await fixture(page)
    await page.locator(".configure-id summary").click()
    const id = page.getByLabel("Chat ID (can configure before first message)")
    await id.fill("-9999")
    const open = page.getByRole("button", { name: "Open chat details", exact: true })
    await open.scrollIntoViewIfNeeded()
    const expected = await page.evaluate(() => window.scrollY)
    expect(expected).toBeGreaterThan(0)
    requests.length = 0
    for (let visit = 0; visit < 2; visit++) {
      await open.click()
      await expect(page.locator(".chat-header code")).toHaveText("-9999")
      await page.getByRole("button", { name: "Back to chat directory", exact: true }).click()
      await expect(page.getByLabel("Search stored chats", { exact: true })).toBeFocused()
      expect(await page.evaluate(() => window.scrollY)).toBe(expected)
      await expect(page.locator('.chat-list [aria-current="true"]')).toHaveCount(0)
      await expect(id).toHaveValue("-9999")
      await expect(page.locator(".pending-bar")).toHaveCount(0)
    }
    expect(requests).toEqual([])
  })

  for (const action of ["Show selected chat", "Open chat details"]) {
    test(`restores directory scroll after ${action} at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      const requests = await fixture(page)
      await select(page, 50)
      await page.getByRole("button", { name: "Back to chat directory", exact: true }).click()
      const previous = await page.evaluate(() => window.scrollY)
      if (action === "Open chat details") await page.locator(".configure-id summary").click()
      const button = page.getByRole("button", { name: action, exact: true })
      await button.scrollIntoViewIfNeeded()
      const expected = await page.evaluate(() => window.scrollY)
      expect(expected).toBeGreaterThan(previous)
      requests.length = 0
      await button.click()
      await expect(page.locator(".chat-header code")).toHaveText("-1050")
      await page.getByRole("button", { name: "Back to chat directory", exact: true }).click()
      await expect(page.locator(".chat-list button").nth(50)).toBeFocused()
      expect(await page.evaluate(() => window.scrollY)).toBe(expected)
      await expect(page.locator(".pending-bar")).toHaveCount(0)
      expect(requests).toEqual([])
    })
  }
}

for (const width of [1440, 390]) {
  test(`chat screenshots at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    await fixture(page)
    const phase = "after"
    await page.screenshot({
      path: testInfo.outputPath(`${phase}-directory-${width}.png`),
      fullPage: true,
    })
    for (const index of [0, 1, 2, 3, 4]) {
      await select(page, index)
      await page.screenshot({
        path: testInfo.outputPath(`${phase}-chat-${index}-${width}.png`),
        fullPage: true,
      })
    }
  })
  test(`tab interaction investigation at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const requests = await fixture(page)
    await select(page, 0)
    requests.length = 0
    for (const name of ["Access", "History", "Overview"]) {
      await page.getByRole("tab", { name, exact: true }).click()
      await expect(page.getByRole("tab", { name, exact: true })).toHaveAttribute(
        "aria-selected",
        "true",
      )
      await expect(page.getByRole("tabpanel")).toHaveCount(1)
      await expect(page.getByRole("tabpanel", { name, exact: true })).toBeVisible()
    }
    await page.getByRole("tab", { name: "Overview", exact: true }).press("End")
    await expect(page.getByRole("tab", { name: "History", exact: true })).toBeFocused()
    await expect(page.getByRole("tabpanel", { name: "History", exact: true })).toBeVisible()
    await select(page, 3)
    await expect(page.getByRole("tabpanel", { name: "History", exact: true })).toBeVisible()
    await expect(page.locator(".pending-bar")).toHaveCount(0)
    expect(requests).toEqual([])
  })
}

test("keeps the expanded onboarding footer outside the list and allows short-screen scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await fixture(page)
  const footer = page.locator(".directory-footer")
  await footer.locator("summary").click()
  await expect(footer.getByLabel("Chat ID (can configure before first message)")).toBeVisible()
  const row = page.locator(".chat-list button").last()
  await row.scrollIntoViewIfNeeded()
  const rowBox = await row.boundingBox()
  const footerBox = await footer.boundingBox()
  if (!rowBox || !footerBox) throw new Error("Missing footer geometry")
  expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(footerBox.y)
  await page.setViewportSize({ width: 1440, height: 600 })
  await expect(page.locator(".chat-directory")).toHaveCSS("position", "static")
  await expect(page.locator(".directory-list-region")).toHaveCSS("overflow-y", "visible")
  await footer.scrollIntoViewIfNeeded()
  await expect(footer.getByRole("button", { name: "Previous chats", exact: true })).toBeInViewport()
})

for (const width of [1440, 390, 320]) {
  test(`chat layout and readiness at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    const requests = await fixture(page)
    const rows = page.locator(".chat-list button")
    const list = page.locator(".directory-list-region")
    const footer = page.locator(".directory-footer")
    await expect(page.getByRole("button", { name: "Previous chats", exact: true })).toBeDisabled()
    await expect(rows.first().locator("strong")).toHaveAttribute("title", longName.trim())
    expect(
      await rows
        .first()
        .locator("strong")
        .evaluate((el) => getComputedStyle(el).webkitLineClamp),
    ).toBe("2")
    if (width > 850) {
      const geometry = await page
        .locator(".chat-directory")
        .evaluate((el) => ({ bottom: el.getBoundingClientRect().bottom, height: innerHeight }))
      expect(geometry.bottom).toBeLessThanOrEqual(geometry.height)
      expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
      // Every row can be fully revealed above the footer, including the final row.
      for (const row of await rows.all()) {
        await row.scrollIntoViewIfNeeded()
        const box = await row.boundingBox()
        const bounds = await list.boundingBox()
        const end = await footer.boundingBox()
        if (!box || !bounds || !end) throw new Error("Missing directory geometry")
        expect(box.y).toBeGreaterThanOrEqual(bounds.y)
        expect(box.y + box.height).toBeLessThanOrEqual(Math.min(bounds.y + bounds.height, end.y))
      }
      const before = await list.evaluate((el) => el.scrollTop)
      await rows.last().click()
      expect(await list.evaluate((el) => el.scrollTop)).toBe(before)
      await rows.nth(98).click()
      expect(await list.evaluate((el) => el.scrollTop)).toBe(before)
    }
    if (width <= 850) {
      await rows.nth(50).scrollIntoViewIfNeeded()
      const before = await page.evaluate(() => window.scrollY)
      await rows.nth(50).click()
      await page.getByRole("button", { name: "Back to chat directory", exact: true }).click()
      await expect(rows.nth(50)).toBeFocused()
      expect(await page.evaluate(() => window.scrollY)).toBe(before)
    }
    requests.length = 0
    for (const index of [0, 1, 2, 3, 4]) {
      await select(page, index)
      const status = page.getByRole("region", { name: "Chat setup status" })
      const approved = index === 0 || index === 2
      await expect(status.getByRole("heading")).toHaveText(
        approved ? "Setup required" : "Access not approved",
      )
      const primaryAction = status.getByRole("button", {
        name: approved ? "Configure authentication" : "Review access approval",
        exact: true,
      })
      await expect(primaryAction).toBeVisible()
      const details = status.locator("details")
      await expect(details).not.toHaveAttribute("open", "")
      await details.locator("summary").click()
      await expect(
        status.getByText("Model authentication is not configured.", { exact: true }),
      ).toBeVisible()
      await expect(
        status.getByRole("button", { name: "Configure authentication", exact: true }),
      ).toBeVisible()
      const approval = status.getByRole("button", { name: "Review access approval", exact: true })
      if (approved) await expect(approval).toHaveCount(0)
      else await expect(approval).toBeVisible()
      for (const text of ["Access", "Chat", "Configuration", "Verification", "Application"])
        await expect(
          details.locator("dt").filter({ hasText: new RegExp(`^${text}$`) }),
        ).toBeVisible()
      await expect(details).toContainText("Not checked — no remote model request")
      await details.locator("summary").click()
      const copy = page.getByRole("button", { name: "Copy chat ID", exact: true })
      await copy.scrollIntoViewIfNeeded()
      const action = await copy.boundingBox()
      const header = await page.locator(".chat-header").boundingBox()
      if (!action || !header) throw new Error("Missing header geometry")
      const id = await page.locator(".chat-header code").boundingBox()
      if (!id) throw new Error("Missing chat ID geometry")
      expect(action.y).toBeGreaterThanOrEqual(id.y - action.height)
      expect(action.y + action.height).toBeLessThanOrEqual(header.y + header.height)
      if (width > 850) await expect(rows.nth(index)).toHaveAttribute("aria-current", "true")
      else expect(action.y).toBeGreaterThan(header.y)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      )
      await copy.focus()
      await copy.press("Tab")
      await page.keyboard.press("Shift+Tab")
      await expect(copy).toBeFocused()
      expect(await copy.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe("none")
    }
    await expect(page.locator(".pending-bar")).toHaveCount(0)
    expect(requests).toEqual([])
    expect(errors).toEqual([])
  })
}
