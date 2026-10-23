import { expect, type Page, test } from "@playwright/test"
import { navigate, openDisclosure } from "./admin-fixture.js"
import { remediationFixture as fixture } from "./remediation-fixture.js"

const unfinished = [
  {
    section: "Access",
    field: "Private user ID to add",
    value: "8001",
    label: "Chat access — Private user ID to add",
    clear: "Clear ID input",
  },
  {
    section: "Access",
    field: "Group or channel ID to add",
    value: "-8001",
    label: "Chat access — Group or channel ID to add",
    clear: "Clear ID input",
  },
  {
    section: "Model Providers",
    field: "Provider ID",
    value: "draft-provider",
    label: "Model providers — Custom endpoint",
    clear: "Discard custom endpoint draft",
  },
  {
    section: "MCP connections",
    field: "Secret field name",
    value: "TEST_TOKEN",
    label: "Tool connections — Secret replacement",
    clear: "Clear secret input",
  },
]

for (const { width, zoom } of [
  { width: 320, zoom: 1 },
  { width: 640, zoom: 2 },
]) {
  test(`F1 multiple unfinished fields keep keyboard focus below status at ${width}px and ${zoom}x zoom`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    const state = await fixture(page)
    await page.evaluate((scale) => {
      document.body.style.zoom = String(scale)
    }, zoom)
    await navigate(page, "Access")
    const users = page.getByLabel("Private user ID to add", { exact: true })
    const groups = page.getByLabel("Group or channel ID to add", { exact: true })
    await users.fill("7001")
    await groups.fill("-7002")
    await navigate(page, "Tool permissions")
    await openDisclosure(page, "Approve an exact tool name")
    const tool = page.getByLabel("Additional approved tool name", { exact: true })
    await tool.fill("unfinished_tool")
    await navigate(page, "Chats")
    const resume = page.getByRole("button", {
      name: "Continue editing: Chat access — Private user ID to add",
      exact: true,
    })
    await resume.focus()
    await page.keyboard.press("Enter")
    await expect(users).toBeFocused()
    const box = await users.boundingBox()
    const status = await page.locator("#save-status").boundingBox()
    expect(box && status && box.y >= status.y + status.height).toBe(true)
    await page
      .locator(".access-list")
      .filter({ has: users })
      .getByRole("button", { name: "Clear ID input", exact: true })
      .click()
    await expect(groups).toHaveValue("-7002")
    await expect(
      page.locator("#save-status").getByRole("button", { name: /^Continue editing:/ }),
    ).toHaveCount(2)
    await page
      .getByRole("button", {
        name: "Continue editing: Tool permissions — Additional approved tool name",
        exact: true,
      })
      .click()
    await expect(tool).toBeFocused()
    await expect(tool).toHaveValue("unfinished_tool")
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(state.writes).toEqual([])
  })
}

async function chooseOtherModel(page: Page) {
  await page.getByRole("button", { name: "Model", exact: true }).click()
  await page.getByRole("option", { name: /Other/ }).click()
}

for (const width of [1440, 390]) {
  for (const editor of unfinished) {
    test(`F1 ${editor.field} returns focus and clears only its input at ${width}px`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 })
      const state = await fixture(page)
      await page.locator(".chat-list button").first().click()
      await navigate(page, "Skills")
      await page.getByRole("textbox", { name: "Search skills", exact: true }).fill("url")
      await page
        .getByRole("checkbox", { name: "Default chat selection for skill url-guide", exact: true })
        .uncheck()
      await navigate(page, editor.section)
      if (editor.section === "Model Providers") await openDisclosure(page, "Custom endpoint")
      if (editor.section === "MCP connections") {
        await page.getByRole("button", { name: "Edit fields for fixture", exact: true }).click()
        await openDisclosure(page, "Replace secrets")
        await page
          .getByLabel("New secret value", { exact: true })
          .fill("synthetic-replacement-only")
      }
      const input = page.getByLabel(editor.field, { exact: true })
      await input.fill(editor.value)
      await navigate(page, "Chats")
      const bar = page.locator("#save-status")
      await expect(bar).toContainText(editor.label)
      await expect(bar).not.toContainText("synthetic-replacement-only")
      await expect(
        page.getByRole("button", { name: "Apply policy changes", exact: true }),
      ).toBeDisabled()
      const resume = bar.getByRole("button", {
        name: `Continue editing: ${editor.label}`,
        exact: true,
      })
      await resume.focus()
      await page.keyboard.press("Enter")
      await expect(input).toBeFocused()
      await expect(input).toHaveValue(editor.value)
      const geometry = await input.evaluate((element) => ({
        top: element.getBoundingClientRect().top,
        bottom: element.getBoundingClientRect().bottom,
        bar: document.querySelector("#save-status")?.getBoundingClientRect().bottom ?? 0,
        height: innerHeight,
      }))
      expect(geometry.top).toBeGreaterThanOrEqual(geometry.bar)
      expect(geometry.bottom).toBeLessThanOrEqual(geometry.height)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      )
      await page.screenshot({
        path: testInfo.outputPath(`blocked-${editor.section}-${width}.png`),
        fullPage: true,
      })
      await page.getByRole("button", { name: editor.clear, exact: true }).click()
      await expect(
        page.getByRole("button", { name: "Apply policy changes", exact: true }),
      ).toBeEnabled()
      await expect(bar).toContainText("1 pending policy change")
      await navigate(page, "Skills")
      await expect(page.getByRole("textbox", { name: "Search skills", exact: true })).toHaveValue(
        "url",
      )
      await expect(
        page.getByRole("checkbox", {
          name: "Default chat selection for skill url-guide",
          exact: true,
        }),
      ).not.toBeChecked()
      expect(new URL(page.url()).searchParams.get("chat")).toBe("42")
      expect(state.writes).toEqual([])
    })
  }

  test(`F1 policy review opens the changed chat disclosure at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 })
    const state = await fixture(page)
    await page.locator(".chat-list button").first().click()
    await page.getByRole("button", { name: "Change model", exact: true }).click()
    const tools = page.locator("#chat-tools-options")
    await tools.click()
    await page
      .getByRole("group", { name: "Authorized tools", exact: true })
      .getByRole("checkbox", { name: "Inherit default", exact: true })
      .uncheck()
    await tools.click()
    await navigate(page, "Audit")
    await page.locator(".policy-destinations > summary").click()
    await page.getByRole("button", { name: "Review chat 42", exact: true }).click()
    await expect(tools).toBeFocused()
    await expect(tools.locator("..")).toHaveAttribute("open", "")
    await expect(page.getByRole("group", { name: "Authorized tools", exact: true })).toContainText(
      "No options allowed",
    )
    expect(state.writes).toEqual([])
  })

  test(`F3 pending status leaves the direct model action visible at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 })
    const state = await fixture(page)
    await navigate(page, "Skills")
    await page
      .getByRole("checkbox", { name: "Default chat selection for skill url-guide", exact: true })
      .uncheck()
    await navigate(page, "Chats")
    await page.locator(".chat-list button").first().click()
    await page.getByRole("button", { name: "Change model", exact: true }).click()
    const field = page.getByRole("combobox", { name: "Chat model override", exact: true })
    await expect(field).toBeFocused()
    const box = await field.boundingBox()
    const bar = await page.locator("#save-status").boundingBox()
    expect(box && bar && box.y >= bar.y + bar.height).toBe(true)
    expect(box && box.y + box.height <= (width === 1440 ? 900 : 844)).toBe(true)
    expect(state.writes).toEqual([])
  })
}

test("F1 endpoint discard restores its staged configuration and keeps the policy draft", async ({
  page,
}) => {
  const state = await fixture(page)
  await navigate(page, "Model Providers")
  await openDisclosure(page, "Custom endpoint")
  await page.getByLabel("Provider ID", { exact: true }).fill("custom")
  await page.getByRole("button", { name: "Set provider configuration", exact: true }).click()
  await page.getByRole("button", { name: "Edit configuration custom", exact: true }).click()
  await page.getByLabel("Provider ID", { exact: true }).fill("unfinished")
  await page.getByRole("button", { name: "Discard custom endpoint draft", exact: true }).click()
  await expect(page.getByLabel("Provider ID", { exact: true })).toHaveValue("custom")
  await expect(page.locator("#save-status")).toContainText("1 pending policy change")
  await expect(
    page.getByRole("button", { name: "Apply policy changes", exact: true }),
  ).toBeEnabled()
  expect(state.writes).toEqual([])
})

test("F2 changing the model task can be cancelled and authentication keeps the accepted task", async ({
  page,
}) => {
  const state = await fixture(page)
  await navigate(page, "Model Providers")
  await chooseOtherModel(page)
  const enterDefault = async () => {
    await navigate(page, "Defaults")
    await page
      .getByRole("button", { name: "Edit default model in Model providers", exact: true })
      .click()
  }
  page.once("dialog", (dialog) => dialog.dismiss())
  await enterDefault()
  await expect(
    page.getByRole("checkbox", { name: "Use as the bot default", exact: true }),
  ).not.toBeChecked()
  await expect(page.getByRole("button", { name: "Model", exact: true })).toContainText("Other")
  page.once("dialog", (dialog) => dialog.accept())
  await enterDefault()
  await page.getByRole("button", { name: "Configure authentication", exact: true }).click()
  await page.getByLabel("API key", { exact: true }).fill("synthetic-key-for-test")
  await page.getByRole("button", { name: "Save API key", exact: true }).click()
  await page.getByRole("button", { name: "Check authentication", exact: true }).click()
  await navigate(page, "Chats")
  await navigate(page, "Model Providers")
  await expect(
    page.getByRole("checkbox", { name: "Use as the bot default", exact: true }),
  ).toBeChecked()
  await expect(page.getByRole("button", { name: "Model", exact: true })).toContainText("Other")
  await expect(page.getByRole("button", { name: "Save default model", exact: true })).toBeEnabled()
  expect(state.writes.some((write) => write.path === "/api/settings")).toBe(false)
  expect(state.policy().defaults.model).toBe("fixture/test")
})

test("F2 a failed default-model save retains intent for retry", async ({ page }, testInfo) => {
  const state = await fixture(page)
  await navigate(page, "Defaults")
  await page
    .getByRole("button", { name: "Edit default model in Model providers", exact: true })
    .click()
  await chooseOtherModel(page)
  state.fail()
  await page.getByRole("button", { name: "Save default model", exact: true }).click()
  await page.getByRole("button", { name: "Save and apply", exact: true }).click()
  await expect(page.getByRole("alert").first()).toContainText("Settings changed; reload")
  await expect(
    page.getByRole("checkbox", { name: "Use as the bot default", exact: true }),
  ).toBeChecked()
  await page.screenshot({ path: testInfo.outputPath("failed-default-save.png"), fullPage: true })
  expect(state.policy().defaults.model).toBe("fixture/test")
  state.fail(false)
  await page.getByRole("button", { name: "Save default model", exact: true }).click()
  await page.getByRole("button", { name: "Save and apply", exact: true }).click()
  await expect.poll(() => state.policy().defaults.model).toBe("fixture/other")
})

test("F4 dirty connection switching and closed secret inputs retain the same draft", async ({
  page,
}) => {
  const state = await fixture(page)
  await navigate(page, "MCP connections")
  await page.getByRole("button", { name: "Edit fields for fixture", exact: true }).click()
  await openDisclosure(page, "Replace secrets")
  await page.getByLabel("Secret field name", { exact: true }).fill("TEST_TOKEN")
  await page.getByLabel("New secret value", { exact: true }).fill("synthetic-replacement-only")
  page.once("dialog", (dialog) => dialog.dismiss())
  await page.getByLabel("MCP server name", { exact: true }).fill("renamed-fixture")
  await expect(page.getByLabel("MCP server name", { exact: true })).toHaveValue("fixture")
  await expect(page.getByLabel("Secret field name", { exact: true })).toHaveValue("TEST_TOKEN")
  page.once("dialog", (dialog) => dialog.dismiss())
  await page.getByRole("button", { name: "Add connection", exact: true }).click()
  await expect(page.getByLabel("MCP server name", { exact: true })).toHaveValue("fixture")
  await page.getByRole("button", { name: "Close connection editor", exact: true }).click()
  await navigate(page, "Audit")
  await page
    .getByRole("button", {
      name: "Continue editing: Tool connections — Secret replacement",
      exact: true,
    })
    .click()
  await expect(page.getByLabel("Secret field name", { exact: true })).toBeFocused()
  await expect(page.getByLabel("New secret value", { exact: true })).toHaveValue(
    "synthetic-replacement-only",
  )
  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "Add connection", exact: true }).click()
  await openDisclosure(page, "Replace secrets")
  await expect(page.getByLabel("Secret field name", { exact: true })).toHaveValue("")
  await expect(page.getByLabel("New secret value", { exact: true })).toHaveValue("")
  await expect(page.locator("#save-status")).not.toContainText("Finish or clear input")
  await page.getByLabel("Secret field name", { exact: true }).fill("TEST_TOKEN")
  await page.getByLabel("New secret value", { exact: true }).fill("synthetic-replacement-only")
  page.once("dialog", (dialog) => dialog.accept())
  await page.getByLabel("MCP server name", { exact: true }).fill("confirmed-rename")
  await expect(page.getByLabel("MCP server name", { exact: true })).toHaveValue("confirmed-rename")
  await expect(page.getByLabel("Secret field name", { exact: true })).toHaveValue("")
  await expect(page.getByLabel("New secret value", { exact: true })).toHaveValue("")
  await expect(page.locator("#save-status")).not.toContainText("Finish or clear input")
  expect(state.writes).toEqual([])
})

test("F4 failed save and cancelled reload preserve guided, JSON, and staged secret values", async ({
  page,
}, testInfo) => {
  const state = await fixture(page)
  await navigate(page, "MCP connections")
  await page.getByRole("button", { name: "Edit fields for fixture", exact: true }).click()
  await openDisclosure(page, "Advanced connection fields")
  await page.getByRole("checkbox", { name: "Edit MCP description", exact: true }).check()
  await page.getByLabel("MCP description replacement", { exact: true }).fill("draft description")
  await openDisclosure(page, "Replace secrets")
  await page.getByLabel("Secret field name", { exact: true }).fill("TEST_TOKEN")
  await page.getByLabel("New secret value", { exact: true }).fill("synthetic-replacement-only")
  await page.getByRole("button", { name: "Set pending secret replacement", exact: true }).click()
  await openDisclosure(page, "Advanced server configuration JSON")
  const json = page.getByRole("textbox", { name: "Server configuration JSON", exact: true })
  await expect(json).toHaveValue(/draft description/)
  await expect(json).not.toHaveValue(/synthetic-replacement-only/)
  state.fail()
  await page.getByRole("button", { name: "Save MCP configuration and apply", exact: true }).click()
  await expect(page.getByRole("alert").first()).toContainText("Settings changed; reload")
  page.once("dialog", (dialog) => dialog.dismiss())
  await page.getByRole("button", { name: "Reload", exact: true }).click()
  await page.screenshot({ path: testInfo.outputPath("failed-connection-save.png"), fullPage: true })
  await expect(json).toHaveValue(/draft description/)
  state.fail(false)
  await page.getByRole("button", { name: "Save MCP configuration and apply", exact: true }).click()
  await expect.poll(() => state.writes.length).toBe(2)
  expect(state.writes[1]).toMatchObject({
    path: "/api/mcp/fixture",
    body: {
      config: {
        description: "draft description",
        env: { OLD: null, TEST_TOKEN: "synthetic-replacement-only" },
      },
    },
  })
})

for (const value of ["historical.operation", "constructor"]) {
  test(`F6 custom exact filters preserve ${value}, active summaries, and policy drafts`, async ({
    page,
  }) => {
    const state = await fixture(page)
    await navigate(page, "Skills")
    await page
      .getByRole("checkbox", { name: "Default chat selection for skill url-guide", exact: true })
      .uncheck()
    await navigate(page, "Audit")
    await openDisclosure(page, "Filters")
    for (const field of ["operation", "outcome"]) {
      await page.getByRole("combobox", { name: `Audit ${field}`, exact: true }).click()
      await page.getByRole("option", { name: "Other exact value", exact: true }).click()
      await page.getByLabel(`Audit ${field} exact value`, { exact: true }).fill(value)
    }
    await page.getByRole("button", { name: "Apply audit filters", exact: true }).click()
    await expect.poll(() => state.queries.at(-1)?.get("operation")).toBe(value)
    expect(state.queries.at(-1)?.get("outcome")).toBe(value)
    await page.locator(".audit-filter-disclosure > summary").click()
    await expect(page.locator(".audit-active-filters")).toContainText(`operation: ${value}`)
    await expect(page.locator(".audit-active-filters")).toContainText(`outcome: ${value}`)
    await expect(page.locator("#save-status")).toContainText("1 pending policy change")
    await openDisclosure(page, "Filters")
    await page.getByRole("button", { name: "Clear audit filters", exact: true }).click()
    await expect.poll(() => state.queries.at(-1)?.has("operation")).toBe(false)
    await expect(page.locator(".audit-active-filters")).toHaveCount(0)
    expect(state.writes).toEqual([])
  })
}
