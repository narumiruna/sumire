import { generateKeyPairSync } from "node:crypto"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { navigate, openDisclosure } from "./admin-fixture.js"
import { contrast } from "./contrast.js"
import { policyRecoveryFixture } from "./policy-recovery-fixture.js"
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

async function stageRecoveryDraft(page: Page) {
  await navigate(page, "Defaults")
  await page.getByRole("combobox", { name: "Shared default thinking", exact: true }).click()
  await page.getByRole("option", { name: "high", exact: true }).click()
}

async function submitRecoveryDraft(page: Page) {
  await page.getByRole("button", { name: "Review and save changes", exact: true }).click()
  await page.getByRole("button", { name: "Save changes", exact: true }).click()
}

async function openRecovery(page: Page) {
  await page.getByRole("button", { name: "Load latest and review draft", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Review recovered settings draft", exact: true })
  await expect(dialog).toBeVisible()
  return dialog
}

for (const width of [1440, 390, 320]) {
  test(`policy recovery retains disjoint edits and saves only after review at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 })
    const fixture = await policyRecoveryFixture(page)
    await stageRecoveryDraft(page)
    fixture.advance((policy) => {
      policy.privateUsers.push(43)
    })
    await submitRecoveryDraft(page)
    await expect(page.getByRole("alert")).toContainText("Fixture revision advanced")
    await expect(page.getByRole("button", { name: "Reload", exact: true })).toBeDisabled()
    const dialog = await openRecovery(page)
    await expect(dialog).toContainText("Shared defaults: Thinking level")
    expect(fixture.writes).toHaveLength(1)
    await dialog.getByRole("button", { name: "Use recovered draft", exact: true }).click()
    await page.getByRole("button", { name: "Save changes", exact: true }).click()
    await expect(page.locator('#save-status[data-compact="true"]')).toBeVisible()
    expect(fixture.writes.map((write) => write.revision)).toEqual([1, 2])
    expect(fixture.snapshot().policy.defaults.thinking).toBe("high")
    expect(fixture.snapshot().policy.privateUsers).toEqual([42, 43])
  })
}

for (const resource of ["/api/inventory", "/api/audit"]) {
  test(`a confirmed policy save remains saved if ${resource} refresh fails`, async ({ page }) => {
    const fixture = await policyRecoveryFixture(page)
    await stageRecoveryDraft(page)
    fixture.state.failedReads.add(resource)
    await submitRecoveryDraft(page)
    await expect(page.getByRole("alert")).toContainText("Settings were saved")
    await expect(page.locator("#save-status")).toContainText("Settings saved and applied.")
    await expect(
      page.getByRole("button", { name: "Load latest and review draft", exact: true }),
    ).toHaveCount(0)
    expect(fixture.writes).toHaveLength(1)
    fixture.state.failedReads.clear()
    await page.getByRole("button", { name: "Reload", exact: true }).click()
    await expect(page.getByRole("alert")).toHaveCount(0)
    expect(fixture.writes).toHaveLength(1)
    expect(fixture.snapshot().policy.defaults.thinking).toBe("high")
  })
}

test("an unknown save outcome can be confirmed without a duplicate PUT", async ({ page }) => {
  const fixture = await policyRecoveryFixture(page)
  await stageRecoveryDraft(page)
  fixture.state.loseSaveResponse = true
  await submitRecoveryDraft(page)
  const dialog = await openRecovery(page)
  await expect(dialog).toContainText("Already saved")
  await dialog.getByRole("button", { name: "Use recovered draft", exact: true }).click()
  await expect(page.locator('#save-status[data-compact="true"]')).toBeVisible()
  await expect(page.getByRole("alertdialog")).toHaveCount(0)
  expect(fixture.writes).toHaveLength(1)
})

test("a malformed successful save response retains recovery instead of corrupting the workspace", async ({
  page,
}) => {
  const fixture = await policyRecoveryFixture(page)
  await stageRecoveryDraft(page)
  fixture.state.malformedSaveResponse = true
  await submitRecoveryDraft(page)
  const dialog = await openRecovery(page)
  await expect(dialog).toContainText("Already saved")
  await dialog.getByRole("button", { name: "Use recovered draft", exact: true }).click()
  await expect(page.locator('#save-status[data-compact="true"]')).toBeVisible()
  expect(fixture.writes).toHaveLength(1)
})

test("recovery comparison renders untrusted policy values as text without loading their URLs", async ({
  page,
}) => {
  const fixture = await policyRecoveryFixture(page)
  const untrusted =
    '<img src="https://untrusted.invalid/recovery" onerror="window.recoveryInjected=true">'
  const external: string[] = []
  await page.route("https://untrusted.invalid/**", (route) => route.abort())
  page.on("request", (request) => {
    if (request.url().startsWith("https://untrusted.invalid/")) external.push(request.url())
  })
  await navigate(page, "Tool permissions")
  await openDisclosure(page, "Approve an exact tool name")
  await page.getByLabel("Additional approved tool name", { exact: true }).fill(untrusted)
  await page.getByRole("button", { name: "Add tool to pending approval", exact: true }).click()
  fixture.advance((policy) => {
    policy.tools = ["read_url_content"]
  })
  await submitRecoveryDraft(page)
  const dialog = await openRecovery(page)
  await dialog.getByText("Compare values for Global tool availability", { exact: true }).click()
  await expect(
    dialog.locator("pre").filter({ hasText: "untrusted.invalid/recovery" }),
  ).toContainText("<img")
  await expect(dialog.locator("img")).toHaveCount(0)
  expect(await page.evaluate(() => Object.hasOwn(window, "recoveryInjected"))).toBe(false)
  expect(external).toEqual([])
  expect(fixture.writes).toHaveLength(1)
})

for (const choice of ["Keep saved value", "Use draft value"]) {
  test(`overlapping recovery requires the explicit choice: ${choice}`, async ({ page }) => {
    const fixture = await policyRecoveryFixture(page)
    await stageRecoveryDraft(page)
    fixture.advance((policy) => {
      policy.defaults.thinking = "low"
    })
    await submitRecoveryDraft(page)
    const dialog = await openRecovery(page)
    await expect(
      dialog.getByRole("button", { name: "Use recovered draft", exact: true }),
    ).toBeDisabled()
    const scope = dialog.getByRole("radiogroup", {
      name: "Shared defaults: Thinking level",
      exact: true,
    })
    await scope.getByRole("radio", { name: choice, exact: true }).click()
    await dialog.getByRole("button", { name: "Use recovered draft", exact: true }).click()
    if (choice === "Use draft value") {
      await page.getByRole("button", { name: "Save changes", exact: true }).click()
      await expect(page.locator('#save-status[data-compact="true"]')).toBeVisible()
      expect(fixture.writes.at(-1)?.revision).toBe(2)
      expect(fixture.snapshot().policy.defaults.thinking).toBe("high")
    } else {
      await expect(page.getByRole("alertdialog")).toHaveCount(0)
      await expect(page.locator('#save-status[data-compact="true"]')).toBeVisible()
      expect(fixture.snapshot().policy.defaults.thinking).toBe("low")
      expect(fixture.writes).toHaveLength(1)
    }
  })
}

test("cancelled and failed recovery reads retain the draft and original save base", async ({
  page,
}) => {
  const fixture = await policyRecoveryFixture(page)
  await stageRecoveryDraft(page)
  fixture.advance((policy) => {
    policy.privateUsers.push(43)
  })
  await submitRecoveryDraft(page)
  let dialog = await openRecovery(page)
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Load latest and review draft", exact: true }),
  ).toBeFocused()
  await expect(
    page.getByRole("combobox", { name: "Shared default thinking", exact: true }),
  ).toContainText("high")
  fixture.state.failedReads.add("/api/settings")
  await page.getByRole("button", { name: "Load latest and review draft", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("Fixture read failed")
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(
    page.getByRole("combobox", { name: "Shared default thinking", exact: true }),
  ).toContainText("high")
  expect(fixture.writes.map((write) => write.revision)).toEqual([1])
  fixture.state.failedReads.clear()
  dialog = await openRecovery(page)
  await dialog.getByRole("button", { name: "Use recovered draft", exact: true }).click()
  await page.getByRole("button", { name: "Save changes", exact: true }).click()
  await expect(page.locator('#save-status[data-compact="true"]')).toBeVisible()
  expect(fixture.writes.map((write) => write.revision)).toEqual([1, 2])
})

test("recovery preserves an MCP draft and unfinished access input across revision changes", async ({
  page,
}) => {
  const fixture = await policyRecoveryFixture(page)
  await stageRecoveryDraft(page)
  fixture.advance((policy) => {
    policy.privateUsers.push(43)
  })
  await submitRecoveryDraft(page)
  await navigate(page, "Access")
  await page.getByLabel("Telegram ID to approve", { exact: true }).fill("8001")
  await navigate(page, "MCP connections")
  await page.getByRole("button", { name: "Add connection", exact: true }).click()
  await page.getByLabel("MCP server name", { exact: true }).fill("recovery-draft")
  await page.getByLabel("Connection command", { exact: true }).fill("npx")
  await openDisclosure(page, "Secrets (optional)")
  await page.getByLabel("Secret field name", { exact: true }).fill("FIXTURE_KEY")
  await page.getByLabel("New secret value", { exact: true }).fill("synthetic-retained-value")
  const dialog = await openRecovery(page)
  await dialog.getByRole("button", { name: "Use recovered draft", exact: true }).click()
  const review = page.getByRole("alertdialog")
  await expect(review.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled()
  await review.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(page.getByLabel("MCP server name", { exact: true })).toHaveValue("recovery-draft")
  await expect(page.getByLabel("New secret value", { exact: true })).toHaveValue(
    "synthetic-retained-value",
  )
  await navigate(page, "Access")
  await expect(page.getByLabel("Telegram ID to approve", { exact: true })).toHaveValue("8001")
  await page.getByRole("button", { name: "Clear ID input", exact: true }).click()
  await navigate(page, "MCP connections")
  await page.getByRole("button", { name: "Clear secret input", exact: true }).click()
  await submitRecoveryDraft(page)
  await expect(page.locator("#save-status")).not.toContainText("unsaved change")
  await expect(page.getByLabel("MCP server name", { exact: true })).toHaveValue("recovery-draft")
  await expect(page.getByLabel("Connection command", { exact: true })).toHaveValue("npx")
  expect(fixture.writes.map((write) => write.revision)).toEqual([1, 2])
})

test("another revision advance requires another recovery review", async ({ page }) => {
  const fixture = await policyRecoveryFixture(page)
  await stageRecoveryDraft(page)
  fixture.advance((policy) => {
    policy.privateUsers.push(43)
  })
  await submitRecoveryDraft(page)
  let dialog = await openRecovery(page)
  fixture.advance((policy) => {
    policy.privateUsers.push(44)
  })
  await dialog.getByRole("button", { name: "Use recovered draft", exact: true }).click()
  await page.getByRole("button", { name: "Save changes", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("Fixture revision advanced")
  dialog = await openRecovery(page)
  await dialog.getByRole("button", { name: "Use recovered draft", exact: true }).click()
  await page.getByRole("button", { name: "Save changes", exact: true }).click()
  await expect(page.locator('#save-status[data-compact="true"]')).toBeVisible()
  expect(fixture.writes.map((write) => write.revision)).toEqual([1, 2, 3])
  expect(fixture.snapshot().policy.privateUsers).toEqual([42, 43, 44])
})

test("a non-revision 409 retains its save error without claiming a revision conflict", async ({
  page,
}) => {
  const fixture = await policyRecoveryFixture(page)
  await stageRecoveryDraft(page)
  fixture.state.saveFailure = 409
  await submitRecoveryDraft(page)
  const dialog = await openRecovery(page)
  await expect(dialog).toContainText("The saved revision has not changed")
  await expect(dialog).toContainText("Fixture save rejected")
  await expect(dialog.getByRole("radio")).toHaveCount(0)
  await dialog.getByRole("button", { name: "Use recovered draft", exact: true }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("Fixture save rejected")
  fixture.state.saveFailure = 0
  await submitRecoveryDraft(page)
  await expect(page.locator('#save-status[data-compact="true"]')).toBeVisible()
  expect(fixture.writes.map((write) => write.revision)).toEqual([1, 1])
})

test("a recovered draft cannot save references removed by a concurrent change", async ({
  page,
}) => {
  const fixture = await policyRecoveryFixture(page)
  await navigate(page, "Tool permissions")
  await page
    .getByRole("checkbox", { name: "Default chat permission for tool bash", exact: true })
    .check()
  fixture.advance((policy) => {
    policy.tools = ["read_url_content"]
  })
  await submitRecoveryDraft(page)
  const dialog = await openRecovery(page)
  await dialog.getByRole("button", { name: "Use recovered draft", exact: true }).click()
  await page.getByRole("button", { name: "Save changes", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("selection exceeds global availability")
  expect(fixture.writes).toHaveLength(1)
  await page
    .getByRole("checkbox", { name: "Default chat permission for tool bash", exact: true })
    .uncheck()
  await expect(page.locator('#save-status[data-compact="true"]')).toBeVisible()
})

for (const status of ["failed", "pending"]) {
  test(`a ${status} application remains distinct from a successful save and failed refresh`, async ({
    page,
  }) => {
    const fixture = await policyRecoveryFixture(page)
    await stageRecoveryDraft(page)
    fixture.state.status = status
    fixture.state.lag = 1
    fixture.state.failedReads.add("/api/inventory")
    await submitRecoveryDraft(page)
    await expect(page.getByRole("alert")).toContainText("Settings were saved")
    await expect(page.locator("#save-status")).toContainText(
      status === "failed" ? "Saved, but application failed" : "Saved changes are waiting to apply",
    )
    await expect(page.getByRole("button", { name: "Retry application", exact: true })).toBeEnabled()
    await expect(
      page.getByRole("button", { name: "Load latest and review draft", exact: true }),
    ).toHaveCount(0)
    expect(fixture.writes).toHaveLength(1)
  })
}

for (const discard of [false, true]) {
  test(`an unknown outcome preserves ${discard ? "review after discard" : "edits made after submission"}`, async ({
    page,
  }) => {
    const fixture = await policyRecoveryFixture(page)
    await stageRecoveryDraft(page)
    fixture.state.loseSaveResponse = true
    await submitRecoveryDraft(page)
    await expect(
      page.getByRole("button", { name: "Load latest and review draft", exact: true }),
    ).toBeVisible()
    if (discard) {
      page.once("dialog", (dialog) => dialog.accept())
      await page.getByRole("button", { name: "Discard settings changes", exact: true }).click()
      await expect(page.locator("#save-status")).toContainText("Save attempt needs review")
      await expect(page.locator('#save-status [data-saved="false"]')).toBeVisible()
      await expect(page.getByRole("button", { name: "Reload", exact: true })).toBeDisabled()
    } else {
      await page.getByRole("combobox", { name: "Shared default thinking", exact: true }).click()
      await page.getByRole("option", { name: "off", exact: true }).click()
      // Another submission is blocked until the first outcome has been read and reviewed.
      await navigate(page, "Tool permissions")
      await page
        .getByRole("checkbox", {
          name: "Default chat permission for tool read_url_content",
          exact: true,
        })
        .uncheck()
      await expect(
        page.getByRole("button", { name: "Review and save changes", exact: true }),
      ).toBeDisabled()
    }
    expect(fixture.snapshot().policy.defaults.thinking).toBe("high")
    const dialog = await openRecovery(page)
    await expect(
      dialog.getByRole("button", { name: "Use recovered draft", exact: true }),
    ).toBeDisabled()
    const conflict = dialog.getByRole("radiogroup", {
      name: "Shared defaults: Thinking level",
      exact: true,
    })
    await conflict
      .getByRole("radio", { name: discard ? "Keep saved value" : "Use draft value", exact: true })
      .click()
    await dialog.getByRole("button", { name: "Use recovered draft", exact: true }).click()
    if (discard) {
      await expect(page.locator('#save-status[data-compact="true"]')).toBeVisible()
      expect(fixture.writes).toHaveLength(1)
      expect(fixture.snapshot().policy.defaults.thinking).toBe("high")
    } else {
      await page.getByRole("button", { name: "Save changes", exact: true }).click()
      await expect(page.locator('#save-status[data-compact="true"]')).toBeVisible()
      expect(fixture.writes.map((write) => write.revision)).toEqual([1, 2])
      expect(fixture.snapshot().policy.defaults.thinking).toBe("off")
      expect(fixture.snapshot().policy.defaults.tools).toEqual([])
    }
  })
}

test("a direct approval review cannot bypass a failed save and can open recovery", async ({
  page,
}) => {
  const fixture = await policyRecoveryFixture(page)
  await stageRecoveryDraft(page)
  fixture.state.loseSaveResponse = true
  await submitRecoveryDraft(page)
  await navigate(page, "Access")
  await page.getByLabel("Telegram ID to approve", { exact: true }).fill("43")
  await page.getByRole("button", { name: "Review approval", exact: true }).click()
  let review = page.getByRole("alertdialog", { name: "Save settings changes?", exact: true })
  await expect(review.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled()
  await review.getByRole("button", { name: "Load latest and review draft", exact: true }).click()
  const recovery = page.getByRole("dialog", {
    name: "Review recovered settings draft",
    exact: true,
  })
  await expect(recovery).toBeVisible()
  expect(fixture.writes).toHaveLength(1)
  await recovery.getByRole("button", { name: "Use recovered draft", exact: true }).click()
  review = page.getByRole("alertdialog", { name: "Save settings changes?", exact: true })
  await review.getByRole("button", { name: "Save changes", exact: true }).click()
  await expect(page.locator('#save-status[data-compact="true"]')).toBeVisible()
  expect(fixture.writes.map((write) => write.revision)).toEqual([1, 2])
  expect(fixture.snapshot().policy.privateUsers).toEqual([42, 43])
})

test("every failed policy attempt must be reconciled before another submission", async ({
  page,
}) => {
  const fixture = await policyRecoveryFixture(page)
  await stageRecoveryDraft(page)
  fixture.state.saveFailure = 500
  await submitRecoveryDraft(page)
  await expect(
    page.getByRole("button", { name: "Review and save changes", exact: true }),
  ).toBeDisabled()
  await page.getByRole("combobox", { name: "Shared default thinking", exact: true }).click()
  await page.getByRole("option", { name: "off", exact: true }).click()
  await navigate(page, "Tool permissions")
  await page
    .getByRole("checkbox", {
      name: "Default chat permission for tool read_url_content",
      exact: true,
    })
    .uncheck()
  fixture.state.saveFailure = 0
  fixture.state.loseSaveResponse = true
  await expect(
    page.getByRole("button", { name: "Review and save changes", exact: true }),
  ).toBeDisabled()
  expect(fixture.writes).toHaveLength(1)
  let dialog = await openRecovery(page)
  await dialog.getByRole("button", { name: "Use recovered draft", exact: true }).click()
  await page.getByRole("button", { name: "Save changes", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Load latest and review draft", exact: true }),
  ).toBeVisible()
  await page
    .getByRole("checkbox", {
      name: "Default chat permission for tool read_url_content",
      exact: true,
    })
    .check()
  dialog = await openRecovery(page)
  await expect(
    dialog.getByRole("button", { name: "Use recovered draft", exact: true }),
  ).toBeDisabled()
  await dialog
    .getByRole("radiogroup", { name: "Shared defaults: Authorized tools", exact: true })
    .getByRole("radio", { name: "Use draft value", exact: true })
    .click()
  await dialog.getByRole("button", { name: "Use recovered draft", exact: true }).click()
  await page.getByRole("button", { name: "Save changes", exact: true }).click()
  await expect(page.locator('#save-status[data-compact="true"]')).toBeVisible()
  expect(fixture.writes.map((write) => write.revision)).toEqual([1, 1, 2])
  expect(fixture.snapshot().policy.defaults.tools).toEqual(["read_url_content"])
})

test("an invalid recovery revision cannot replace the original save base or draft", async ({
  page,
}) => {
  const fixture = await policyRecoveryFixture(page)
  await stageRecoveryDraft(page)
  fixture.advance((policy) => {
    policy.privateUsers.push(43)
  })
  await submitRecoveryDraft(page)
  await page.route("**/api/settings", (route) =>
    route.fulfill({ json: { policy: fixture.snapshot().policy, status: "applied" } }),
  )
  await page.getByRole("button", { name: "Load latest and review draft", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("Could not verify saved settings")
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(
    page.getByRole("combobox", { name: "Shared default thinking", exact: true }),
  ).toContainText("high")
  await expect(page.locator('#save-status[data-compact="false"]')).toBeVisible()
  await page.unroute("**/api/settings")
  const dialog = await openRecovery(page)
  await dialog.getByRole("button", { name: "Use recovered draft", exact: true }).click()
  await page.getByRole("button", { name: "Save changes", exact: true }).click()
  await expect(page.locator('#save-status[data-compact="true"]')).toBeVisible()
  expect(fixture.writes.map((write) => write.revision)).toEqual([1, 2])
})

test("an old application retry cannot reload or erase a new session's draft", async ({
  page,
  context,
}) => {
  const fixture = await policyRecoveryFixture(page)
  const local = new URL(page.url())
  local.hostname = "localhost"
  await page.goto(local.href)
  const client = await context.newCDPSession(page)
  await client.send("WebAuthn.enable")
  const { authenticatorId } = await client.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  const privateKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({
    type: "pkcs8",
    format: "der",
  })
  await client.send("WebAuthn.addCredential", {
    authenticatorId,
    credential: {
      credentialId: Buffer.from("recovery-session-credential").toString("base64"),
      isResidentCredential: true,
      rpId: "localhost",
      privateKey: privateKey.toString("base64"),
      userHandle: Buffer.from("42").toString("base64"),
      signCount: 0,
    },
  })
  await page.route("**/auth/passkey/**", async (route) => {
    if (route.request().url().endsWith("options"))
      return route.fulfill({
        json: {
          challenge: Buffer.from("recovery-session-challenge").toString("base64url"),
          rpId: "localhost",
          userVerification: "required",
        },
      })
    fixture.state.status = "applied"
    fixture.state.lag = 0
    return route.fulfill({ json: { csrf: "new-fixture-session", actor: "42" } })
  })
  fixture.state.status = "failed"
  fixture.state.lag = 1
  await page.reload()
  let expire: () => void = () => undefined
  const expiry = new Promise<void>((resolve) => {
    expire = resolve
  })
  await page.route("**/api/chats?*", async (route) => {
    await expiry
    await route.fulfill({ status: 401, json: { error: "Session expired" } })
  })
  const directoryRequest = page.waitForRequest((request) => request.url().includes("q=expire"))
  await page.getByLabel("Search stored chats", { exact: true }).fill("expire")
  await directoryRequest
  let complete: () => void = () => undefined
  const held = new Promise<void>((resolve) => {
    complete = resolve
  })
  await page.route("**/api/apply", async (route) => {
    await held
    await route.fulfill({ json: fixture.snapshot() })
  })
  const applyRequest = page.waitForRequest(
    (request) => new URL(request.url()).pathname === "/api/apply",
  )
  await page.getByRole("button", { name: "Retry application", exact: true }).click()
  await applyRequest
  expire()
  const signIn = page.getByRole("button", { name: "Sign in with passkey", exact: true })
  await expect(signIn).toBeVisible()
  await page.unroute("**/api/chats?*")
  await signIn.click()
  await expect(page.locator('#save-status[data-compact="true"]')).toBeVisible()
  await stageRecoveryDraft(page)
  const reads = fixture.reads.filter((path) => path === "/api/settings").length
  const oldResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/apply",
  )
  complete()
  await oldResponse
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  expect(fixture.reads.filter((path) => path === "/api/settings")).toHaveLength(reads)
  await expect(
    page.getByRole("combobox", { name: "Shared default thinking", exact: true }),
  ).toContainText("high")
  await expect(page.locator("#save-status")).toContainText("unsaved change")
  expect(fixture.writes).toHaveLength(0)
  await client.detach()
})

test("session expiry clears recovery and ignores a late successful settings read", async ({
  page,
}) => {
  const fixture = await policyRecoveryFixture(page)
  await stageRecoveryDraft(page)
  fixture.advance((policy) => {
    policy.privateUsers.push(43)
  })
  await submitRecoveryDraft(page)
  await navigate(page, "Chats")
  let expire: () => void = () => undefined
  const expiry = new Promise<void>((resolve) => {
    expire = resolve
  })
  await page.route("**/api/chats?*", async (route) => {
    await expiry
    await route.fulfill({ status: 401, json: { error: "Session expired" } })
  })
  const directoryRequest = page.waitForRequest((request) => request.url().includes("q=expire"))
  await page.getByLabel("Search stored chats", { exact: true }).fill("expire")
  await directoryRequest
  let complete: () => void = () => undefined
  const held = new Promise<void>((resolve) => {
    complete = resolve
  })
  await page.route("**/api/settings", async (route) => {
    await held
    await route.fulfill({ json: fixture.snapshot() })
  })
  const recoveryRequest = page.waitForRequest(
    (request) => new URL(request.url()).pathname === "/api/settings",
  )
  await page.getByRole("button", { name: "Load latest and review draft", exact: true }).click()
  await recoveryRequest
  expire()
  const signIn = page.getByRole("button", { name: "Sign in with passkey", exact: true })
  await expect(signIn).toBeVisible()
  await signIn.focus()
  complete()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "Load latest and review draft", exact: true }),
  ).toHaveCount(0)
  await expect(signIn).toBeFocused()
  expect(fixture.writes).toHaveLength(1)
})
