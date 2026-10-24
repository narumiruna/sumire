import { expect, type Locator, test } from "@playwright/test"
import { navigate, openDisclosure } from "./admin-fixture.js"
import { contrast } from "./contrast.js"
import { remediationFixture } from "./remediation-fixture.js"

for (const width of [1440, 390, 320]) {
  for (const status of [409, 500]) {
    test(`failed connection save (${status}) reveals the error and retains its exact retry at ${width}px`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 })
      const state = await remediationFixture(page)
      let fail = true
      const attempts: unknown[] = []
      await page.route("**/api/mcp/review-example", async (route) => {
        attempts.push(route.request().postDataJSON())
        if (fail)
          await route.fulfill({ status, json: { error: `Connection save failed (${status}).` } })
        else await route.fallback()
      })
      await navigate(page, "MCP connections")
      await page.getByRole("button", { name: "Add connection", exact: true }).click()
      await page.getByLabel("MCP server name", { exact: true }).fill("review-example")
      await page.getByLabel("Connection command", { exact: true }).fill("npx")
      await openDisclosure(page, "Secrets (optional)")
      await page.getByLabel("Secret field name", { exact: true }).fill("REVIEW_KEY")
      await page.getByLabel("New secret value", { exact: true }).fill("synthetic-review-value")
      await page
        .getByRole("button", { name: "Set pending secret replacement", exact: true })
        .click()
      await openDisclosure(page, "Advanced connection fields")
      await openDisclosure(page, "Review field changes")
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
      const save = page.getByRole("button", { name: "Save connection", exact: true })
      await save.click()
      const alert = page
        .getByRole("alert")
        .filter({ hasText: `Connection save failed (${status}).` })
      await expect(alert).toBeFocused()
      await expect(alert).toBeInViewport({ ratio: 1 })
      const errorBox = await alert.boundingBox()
      const statusBox = await page.locator("#save-status").boundingBox()
      if (!errorBox || !statusBox) throw new Error("Missing error or status geometry")
      expect(errorBox.y + errorBox.height).toBeLessThanOrEqual(statusBox.y)
      await page.screenshot({ path: testInfo.outputPath("visible-save-error.png") })
      await expect(page.getByLabel("MCP server name", { exact: true })).toHaveValue(
        "review-example",
      )
      await expect(page.getByLabel("Connection command", { exact: true })).toHaveValue("npx")
      await expect(page.locator("#save-status")).toContainText("Saved revision applied.")
      await expect(page.locator("#save-status")).toContainText("MCP: Unsaved configuration")
      await expect(page.locator("#save-status")).not.toContainText("application failed")
      fail = false
      await save.click()
      await expect(page.getByRole("button", { name: "Add connection", exact: true })).toBeFocused()
      expect(attempts).toHaveLength(2)
      expect(attempts[1]).toEqual(attempts[0])
      expect(attempts[1]).toMatchObject({
        revision: 1,
        config: { command: "npx", env: { REVIEW_KEY: "synthetic-review-value" } },
      })
      expect(state.writes.map((write) => write.path)).toEqual(["/api/mcp/review-example"])
    })
  }
}

for (const method of ["pointer", "keyboard"]) {
  test(`desktop ${method} section navigation reveals its heading without discarding drafts`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const state = await remediationFixture(page)
    state.policy().privateUsers = Array.from({ length: 70 }, (_, index) => 42 + index)
    await page.route("**/api/audit?*", (route) =>
      route.fulfill({
        json: Array.from({ length: 10 }, (_, index) => ({
          id: index + 1,
          time: index + 1,
          actor: "42",
          operation: "settings.update",
          revision: index + 1,
          outcome: "saved",
          target: "settings",
        })),
      }),
    )
    await page.reload()
    await navigate(page, "Access")
    await page.getByLabel("Telegram ID to approve", { exact: true }).fill("8001")
    await page.evaluate(() => window.scrollTo(0, 800))
    expect(await page.evaluate(() => window.scrollY)).toBe(800)
    const audit = page
      .getByRole("navigation", { name: "Administration sections" })
      .getByRole("link", {
        name: "Audit",
        exact: true,
      })
    if (method === "keyboard") {
      await audit.focus()
      await audit.press("Enter")
    } else await audit.click()
    const heading = page.getByRole("heading", { name: "Audit", exact: true })
    await expect(heading).toBeFocused()
    await expect(heading).toBeInViewport({ ratio: 1 })
    expect(await page.evaluate(() => window.scrollY)).toBe(0)
    await page.screenshot({ path: testInfo.outputPath("section-navigation.png") })
    await navigate(page, "Access")
    await expect(page.getByLabel("Telegram ID to approve", { exact: true })).toHaveValue("8001")
    expect(state.writes).toEqual([])
  })
}

for (const width of [1440, 390]) {
  test(`enabled controls and status badges meet text contrast in every interaction state at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    await remediationFixture(page)
    const measurements: Record<string, Awaited<ReturnType<typeof contrast>>> = {}
    const check = async (label: string, locator: Locator, interactive = true) => {
      for (const state of interactive ? ["normal", "hover", "focus"] : ["normal"]) {
        await page.mouse.move(0, 0)
        await locator.evaluate((element) => {
          if (element instanceof HTMLElement) element.blur()
        })
        if (state === "hover") await locator.hover()
        if (state === "focus") {
          await page.keyboard.press("Tab")
          await locator.focus()
        }
        const measurement = await contrast(locator)
        measurements[`${label} ${state}`] = measurement
        expect.soft(measurement.text, `${label} ${state}`).toBeGreaterThanOrEqual(4.5)
      }
    }
    if (width === 390)
      await check("mobile Sections", page.getByRole("button", { name: /^Sections ·/ }))
    else {
      await check(
        "active section",
        page
          .getByRole("navigation", { name: "Administration sections" })
          .getByRole("link", { name: "Chats", exact: true }),
      )
      await check("Reload", page.getByRole("button", { name: "Reload", exact: true }))
      await check("Account", page.getByRole("button", { name: "Account", exact: true }))
    }
    await navigate(page, "MCP connections")
    await check("primary action", page.getByRole("button", { name: "Add connection", exact: true }))
    await check(
      "soft action",
      page.getByRole("button", { name: "Test and discover fixture", exact: true }),
    )
    await check(
      "enabled badge",
      page
        .getByRole("region", { name: "fixture connection", exact: true })
        .getByText("Enabled", { exact: true }),
      false,
    )
    await navigate(page, "Access")
    await check("approved badge", page.getByText("Approved", { exact: true }).first(), false)
    await navigate(page, "Model providers")
    await check("provider selector", page.getByRole("button", { name: /^Provider(?::|$)/ }))
    await check("model selector", page.getByRole("button", { name: /^Model(?::|$)/ }))
    await check(
      "ghost action",
      page.getByRole("button", { name: "Edit shared default", exact: true }),
    )
    await testInfo.attach("control-contrast", {
      contentType: "application/json",
      body: JSON.stringify(measurements, null, 2),
    })
  })
}

for (const label of ["Provider", "Model"]) {
  test(`${label} selector names include the visible value before and after keyboard selection`, async ({
    page,
  }) => {
    const state = await remediationFixture(page)
    state.inventory.providers.push({
      id: "second",
      name: "Second",
      configured: true,
      apiKey: true,
      oauth: false,
      models: [
        { id: "test", name: "Second test", thinking: ["off"], reasoning: false, image: false },
      ],
    })
    await page.reload()
    await navigate(page, "Model providers")
    const trigger = page.getByRole("button", { name: new RegExp(`^${label}(?::|$)`) })
    await expect(trigger).toHaveAccessibleName(
      `${label}: ${label === "Provider" ? "Fixture" : "Test"}`,
    )
    await trigger.click()
    const search = page.getByRole("combobox", {
      name: `Search ${label.toLowerCase()}`,
      exact: true,
    })
    const value = label === "Provider" ? "Second" : "Other"
    await search.fill(value)
    await search.press("Enter")
    await expect(trigger).toHaveAccessibleName(`${label}: ${value}`)
    await expect(trigger).toBeFocused()
    await trigger.click()
    await search.press("Escape")
    await expect(trigger).toBeFocused()
    await expect(trigger).toHaveAccessibleName(`${label}: ${value}`)
    expect(state.writes).toEqual([])
  })
}

for (const ref of [null, "missing/unavailable", "fixture/unavailable"]) {
  test(`selector names retain the displayed fallback for ${ref ?? "no selection"}`, async ({
    page,
  }) => {
    const state = await remediationFixture(page)
    state.policy().defaults.model = ref
    if (ref) {
      state.policy().models.push(ref)
      state.policy().defaults.models?.push(ref)
    }
    await page.reload()
    await navigate(page, "Model providers")
    const provider = page.getByRole("button", { name: /^Provider: / })
    await expect(provider).toHaveAccessibleName(
      `Provider: ${ref?.startsWith("fixture/") ? "Fixture" : ref ? "missing" : "Choose provider"}`,
    )
    if (ref === "fixture/unavailable") {
      await expect(page.getByRole("button", { name: /^Model: / })).toHaveAccessibleName(
        "Model: unavailable",
      )
    } else {
      // Without an available provider, there is no model selector until a provider is chosen.
      await expect(page.getByRole("button", { name: /^Model: / })).toHaveCount(0)
      await provider.click()
      await page.getByRole("combobox", { name: "Search provider", exact: true }).fill("Fixture")
      await page.keyboard.press("Enter")
      await expect(page.getByRole("button", { name: /^Model: / })).toHaveAccessibleName(
        "Model: Choose model",
      )
    }
    expect(state.writes).toEqual([])
  })
}

test("a connection save completed after navigation does not focus its hidden section", async ({
  page,
}) => {
  const state = await remediationFixture(page)
  let respond: () => void = () => undefined
  const response = new Promise<void>((resolve) => {
    respond = resolve
  })
  await page.route("**/api/mcp/fixture", async (route) => {
    await response
    await route.fallback()
  })
  await navigate(page, "MCP connections")
  await page.getByRole("button", { name: "Edit fields for fixture", exact: true }).click()
  const saving = page.waitForRequest("**/api/mcp/fixture")
  await page.getByRole("button", { name: "Save connection", exact: true }).click()
  await saving
  await navigate(page, "Access")
  const heading = page.getByRole("heading", { name: "Chat access", exact: true })
  await expect(heading).toBeFocused()
  respond()
  await expect(page.getByRole("main")).toHaveAttribute("aria-busy", "false")
  await expect(heading).toBeFocused()
  await expect(page.getByRole("button", { name: "Add connection", exact: true })).toBeHidden()
  expect(state.writes.map((write) => write.path)).toEqual(["/api/mcp/fixture"])
  await navigate(page, "MCP connections")
  await expect(page.getByRole("heading", { name: "Tool connections", exact: true })).toBeFocused()
  await expect(page.getByRole("button", { name: "Add connection", exact: true })).toBeVisible()
})

test("connection-save session expiry opens sign-in without focusing the unmounted editor", async ({
  page,
}) => {
  await remediationFixture(page)
  await page.route("**/api/mcp/fixture", (route) =>
    route.fulfill({ status: 401, json: { error: "Session expired" } }),
  )
  await navigate(page, "MCP connections")
  await page.getByRole("button", { name: "Edit fields for fixture", exact: true }).click()
  await page.getByRole("button", { name: "Save connection", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Sign in with passkey", exact: true }),
  ).toBeVisible()
  await expect(page.getByRole("alert")).toContainText("Session expired")
  await expect(page.getByLabel("MCP server name", { exact: true })).toHaveCount(0)
  await expect(page.locator(".workspace-error")).toHaveCount(0)
})

test("a background access-link failure does not take focus from an editor", async ({ page }) => {
  await remediationFixture(page)
  let respond: () => void = () => undefined
  const response = new Promise<void>((resolve) => {
    respond = resolve
  })
  await page.route("**/api/access/resolve", async (route) => {
    await response
    await route.fulfill({ status: 500, json: { error: "Access lookup failed" } })
  })
  await navigate(page, "Tool permissions")
  const resolving = page.waitForRequest("**/api/access/resolve")
  await page.evaluate(() => {
    window.location.hash = `allow=${"a".repeat(64)}`
  })
  await resolving
  const search = page.getByRole("textbox", { name: "Search tools and servers", exact: true })
  await search.fill("read")
  respond()
  await expect(page.getByRole("alert")).toContainText("Access lookup failed")
  await expect(search).toBeFocused()
  await expect(search).toHaveValue("read")
})

test("credential-save errors stay inside the authentication dialog", async ({ page }) => {
  await remediationFixture(page)
  await page.route("**/api/providers/fixture/credential", (route) =>
    route.fulfill({ status: 500, json: { error: "Credential save failed" } }),
  )
  await navigate(page, "Model providers")
  await openDisclosure(page, "Authentication")
  await page.getByRole("button", { name: "Configure authentication", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Connect Fixture", exact: true })
  await dialog.getByLabel("API key", { exact: true }).fill("synthetic-review-key")
  await dialog.getByRole("button", { name: "Save API key", exact: true }).click()
  await expect(dialog.getByRole("alert")).toContainText("Credential save failed")
  await expect(dialog).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))))
    .toBe(true)
  await expect(dialog.getByLabel("API key", { exact: true })).toHaveValue("synthetic-review-key")
})
