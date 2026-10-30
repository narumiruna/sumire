import { expect, type Locator, test } from "@playwright/test"
import { navigate } from "./admin-fixture.js"
import { remediationFixture as fixture } from "./remediation-fixture.js"

async function visibleInViewport(locator: Locator) {
  await expect(locator).toBeVisible()
  const geometry = await locator.evaluate((el) => {
    const rect = el.getBoundingClientRect()
    return { top: rect.top, bottom: rect.bottom, height: innerHeight }
  })
  expect(geometry.top).toBeGreaterThanOrEqual(0)
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.height)
  await test.info().attach("viewport-geometry", {
    body: JSON.stringify({ control: locator.toString(), ...geometry }),
    contentType: "application/json",
  })
}

for (const width of [1440, 390]) {
  test(`F1 unfinished tool input has a direct return and isolated clear at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 })
    const state = await fixture(page)
    await navigate(page, "Tool permissions")
    const manual = page.getByRole("textbox", { name: "Additional approved tool name", exact: true })
    if (!(await manual.isVisible()))
      await page.getByText("Approve an exact tool name", { exact: true }).click()
    await manual.fill("unfinished_tool")
    await navigate(page, "Access")
    await page.getByRole("button", { name: "Revoke access for ID 42", exact: true }).click()
    await expect(
      page.getByRole("button", { name: "Review and save changes", exact: true }),
    ).toBeDisabled()
    await page
      .getByRole("button", {
        name: "Continue editing: Tool permissions — Additional approved tool name",
        exact: true,
      })
      .click()
    await expect(manual).toBeFocused()
    await expect(manual).toHaveValue("unfinished_tool")
    await page.getByRole("button", { name: "Clear tool input", exact: true }).click()
    await expect(
      page.getByRole("button", { name: "Review and save changes", exact: true }),
    ).toBeEnabled()
    await expect(page.locator("#save-status")).toContainText("1 unsaved change")
    expect(state.writes).toEqual([])
  })

  test(`F2 default model intent survives model selection at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 })
    const state = await fixture(page)
    state.policy().models.push("fixture/other")
    await page.reload()
    await navigate(page, "Defaults")
    await page.getByRole("combobox", { name: "Shared default model", exact: true }).click()
    await page.getByRole("option", { name: "Other", exact: true }).click()
    await expect(
      page.getByRole("button", { name: "Review and save changes", exact: true }),
    ).toBeEnabled()
    await page.getByRole("button", { name: "Review and save changes", exact: true }).click()
    await page.getByRole("button", { name: "Cancel", exact: true }).click()
    expect(state.writes).toEqual([])
    await page.getByRole("button", { name: "Review and save changes", exact: true }).click()
    await page.getByRole("button", { name: "Save changes", exact: true }).click()
    await expect.poll(() => state.policy().defaults.model).toBe("fixture/other")
    expect(state.policy().defaults.models).toContain("fixture/other")
    expect(state.policy().chats).toEqual({})
  })

  test(`F3 Change model focuses the field without tool settings at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 })
    const state = await fixture(page)
    await page.locator(".chat-list .directory-chat").first().click()
    await page.getByRole("button", { name: "Change model", exact: true }).click()
    const model = page.getByRole("combobox", { name: "Chat model override", exact: true })
    await expect(model).toBeFocused()
    await visibleInViewport(model)
    await expect(page.getByRole("group", { name: "Authorized tools", exact: true })).toBeHidden()
    expect(state.writes).toEqual([])
  })
}

for (const width of [1440, 768]) {
  test(`F4 the closed connection editor does not reserve an empty column at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 768 ? 1024 : 900 })
    const state = await fixture(page)
    await navigate(page, "MCP connections")
    const layout = page.locator(".mcp-workspace")
    const list = page.locator(".mcp-chooser")
    const card = page.getByRole("region", { name: "fixture connection", exact: true })
    const workspaceBox = await layout.boundingBox()
    const listBox = await list.boundingBox()
    const cardBox = await card.boundingBox()
    expect(workspaceBox && listBox && Math.abs(workspaceBox.width - listBox.width) < 1).toBe(true)
    expect(cardBox && listBox && cardBox.width >= listBox.width - 40).toBe(true)
    await page.screenshot({
      path: testInfo.outputPath(`connection-list-${width}.png`),
      fullPage: true,
    })
    await page.getByRole("button", { name: "Add connection", exact: true }).click()
    await expect(list).toBeHidden()
    const editorBox = await page.locator(".mcp-editor-column").boundingBox()
    expect(editorBox && workspaceBox && editorBox.width <= workspaceBox.width).toBe(true)
    await page.getByRole("button", { name: "Close connection editor", exact: true }).click()
    await expect(layout).toHaveClass(/mcp-list-only/)
    expect(state.writes).toEqual([])
  })
}

test("F4 connection editing starts explicitly and retains a closed draft", async ({ page }) => {
  const state = await fixture(page)
  await navigate(page, "MCP connections")
  await expect(page.getByRole("group", { name: "Connection details", exact: true })).toBeHidden()
  await page.getByRole("button", { name: "Add connection", exact: true }).click()
  await page.getByRole("textbox", { name: "MCP server name", exact: true }).fill("new-connection")
  await page.getByRole("combobox", { name: "Connection type", exact: true }).click()
  await page.getByRole("option", { name: /HTTP endpoint/ }).click()
  await page
    .getByRole("textbox", { name: "Connection URL", exact: true })
    .fill("https://example.com/mcp")
  await expect(page.getByRole("textbox", { name: "Connection command", exact: true })).toBeHidden()
  await page.getByRole("button", { name: "Close connection editor", exact: true }).click()
  await navigate(page, "Chats")
  await navigate(page, "MCP connections")
  await page.getByRole("button", { name: "Resume connection draft", exact: true }).click()
  await expect(page.getByRole("textbox", { name: "Connection URL", exact: true })).toHaveValue(
    "https://example.com/mcp",
  )
  expect(state.writes).toEqual([])
})

test("F5 settings start with usable controls on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const state = await fixture(page)
  await navigate(page, "Tool permissions")
  await page.evaluate(() => window.scrollTo(0, 0))
  await expect(
    page.getByRole("checkbox", { name: "Globally allow tool read_url_content", exact: true }),
  ).toBeHidden()
  await visibleInViewport(
    page.getByRole("checkbox", {
      name: "Default chat permission for tool read_url_content",
      exact: true,
    }),
  )
  await visibleInViewport(page.locator(".permission-row").first())
  await navigate(page, "Access")
  await page.evaluate(() => window.scrollTo(0, 0))
  await visibleInViewport(page.getByRole("button", { name: "Review approval", exact: true }))
  await navigate(page, "Skills")
  await page.evaluate(() => window.scrollTo(0, 0))
  await visibleInViewport(
    page.getByRole("checkbox", { name: "Default chat selection for skill url-guide", exact: true }),
  )
  await navigate(page, "Defaults")
  await page.evaluate(() => window.scrollTo(0, 0))
  await visibleInViewport(page.getByRole("combobox", { name: "Shared default model", exact: true }))
  await expect(
    page.getByRole("button", { name: "Reset all chats to inherit defaults", exact: true }),
  ).toBeHidden()
  await navigate(page, "MCP connections")
  await page.evaluate(() => window.scrollTo(0, 0))
  await visibleInViewport(page.getByRole("button", { name: "Add connection", exact: true }))
  await visibleInViewport(
    page.getByRole("button", { name: "Edit fields for fixture", exact: true }),
  )
  expect(state.writes).toEqual([])
})

test("F6 Audit starts with records and offers exact-value choices", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const state = await fixture(page)
  await navigate(page, "Audit")
  await page.evaluate(() => window.scrollTo(0, 0))
  await expect(page.getByLabel("Actor (exact)", { exact: true })).toBeHidden()
  await visibleInViewport(page.locator(".audit-record-fields").first())
  await page.getByText("Filters", { exact: true }).click()
  await page.getByRole("combobox", { name: "Operation type", exact: true }).click()
  await page.getByRole("option", { name: "Settings saved", exact: true }).click()
  await page.getByRole("combobox", { name: "Result", exact: true }).click()
  await page.getByRole("option", { name: "Saved", exact: true }).click()
  await page.getByRole("button", { name: "Apply audit filters", exact: true }).click()
  await expect.poll(() => state.queries.at(-1)?.get("operation")).toBe("settings.update")
  expect(state.queries.at(-1)?.get("outcome")).toBe("saved")
  expect(state.writes).toEqual([])
})
