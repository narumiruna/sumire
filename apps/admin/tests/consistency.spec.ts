import { expect, type Page, test } from "@playwright/test"
import {
  adminFixture as fixture,
  navigate as navigateSection,
  openConnectionEditor,
  openDirectoryFilters,
  sections,
} from "./admin-fixture"

async function navigate(page: Page, section: string) {
  await navigateSection(page, section)
  if (section === "MCP connections") await openConnectionEditor(page, true)
}

for (const control of [
  { section: "Chats", name: "Chat type" },
  { section: "Chats", name: "Access status" },
  { section: "MCP connections", name: "Connection type" },
  { section: "MCP connections", name: "MCP exposure replacement", field: "exposure" },
  { section: "MCP connections", name: "MCP type replacement", field: "type" },
  { section: "MCP connections", name: "Field map" },
]) {
  test(`${control.name} closes when history hides its section`, async ({ page }) => {
    await fixture(page)
    await navigate(page, control.section)
    if (control.section === "Chats") await openDirectoryFilters(page)
    if (control.field)
      await page.getByRole("checkbox", { name: `Edit MCP ${control.field}`, exact: true }).check()
    await navigate(page, "Defaults")
    await page.goBack()
    if (control.name === "Field map")
      await page.getByText("Secrets (optional)", { exact: true }).click()
    const trigger = page.getByRole("combobox", { name: control.name, exact: true })
    await trigger.click()
    await expect(page.getByRole("listbox")).toBeVisible()
    await page.goForward()
    await expect(page.getByRole("heading", { name: "Shared defaults", exact: true })).toBeVisible()
    await expect(page.getByRole("listbox")).toHaveCount(0)
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest("[hidden]")))).toBe(
      false,
    )
    await page.goBack()
    await expect(trigger).toBeVisible()
    await expect(page.getByRole("listbox")).toHaveCount(0)
    if (control.field)
      await expect(
        page.getByRole("checkbox", { name: `Edit MCP ${control.field}`, exact: true }),
      ).toBeChecked()
  })
}

for (const width of [1440, 390, 320]) {
  test(`all sections reflow with bounded save chrome at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await fixture(page)
    const workspace = page.locator(".chat-workspace")
    if (width <= 390) {
      const box = await workspace.boundingBox()
      expect(box).not.toBeNull()
      expect(box?.y).toBeLessThanOrEqual(250)
    }
    for (const section of sections) {
      await navigate(page, section)
      if (section === "Tool permissions")
        await page.getByRole("button", { name: "Expand all", exact: true }).click()
      await page.evaluate(() => window.scrollTo(0, 0))
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
        section,
      ).toBeLessThanOrEqual(width)
      if (width === 1440 && section === "MCP connections")
        expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThan(2054)
      const bar = page.getByRole("region", { name: "Save status and pending changes" })
      if (section === "Durable") {
        await expect(bar).toBeHidden()
        continue
      }
      await expect(bar).toHaveAttribute("data-compact", "true")
      await expect(bar).toContainText("Settings saved and applied.")
      await expect(bar.getByRole("button")).toHaveCount(0)
      await expect(bar.getByText("How saving works", { exact: true })).toHaveCount(0)
      if (width <= 390) {
        await expect(bar).toBeVisible()
        const box = await bar.boundingBox()
        expect(box?.height, section).toBeLessThanOrEqual(900 / 4)
      }
    }
    await navigate(page, "Access")
    await page.getByRole("button", { name: "Revoke access for ID 42", exact: true }).click()
    const bar = page.getByRole("region", { name: "Save status and pending changes" })
    await expect(bar.locator(".save-status-line .rt-Badge")).toHaveCount(1)
    await expect(bar.locator(".save-status-line .rt-Badge")).toHaveText("1 unsaved change")
    await expect(
      bar.getByRole("button", { name: "Review and save changes", exact: true }),
    ).toBeEnabled()
    if (width <= 390) {
      expect((await bar.boundingBox())?.height).toBeLessThanOrEqual(900 / 4)
      await expect(bar.getByText("How saving works", { exact: true })).toHaveCount(0)
      await expect(bar.getByText("Review pending policy changes", { exact: true })).toHaveCount(0)
      await bar.getByRole("button", { name: "Review and save changes", exact: true }).click()
      await expect(page.getByRole("alertdialog")).toContainText("Chat access")
    }
  })
}

test("Defaults omits an identical model draft after a tool-only edit", async ({ page }) => {
  await fixture(page)
  await navigate(page, "Tool permissions")
  await page.getByRole("button", { name: "Expand all", exact: true }).click()
  await page
    .getByRole("checkbox", {
      name: "Default chat permission for tool read_url_content",
      exact: true,
    })
    .uncheck()
  await navigate(page, "Defaults")
  await expect(
    page.getByRole("combobox", { name: "Shared default thinking", exact: true }),
  ).toContainText("off")
  await expect(page.getByText(/Policy draft model:/)).toHaveCount(0)
  await expect(
    page
      .getByRole("region", { name: "Shared defaults", exact: true })
      .getByText("No tools allowed by default.", { exact: true }),
  ).toBeVisible()
})

test("dark operating-system preference keeps the complete light appearance", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" })
  await fixture(page)
  const theme = page.locator(".radix-themes").first()
  await expect(theme).toHaveClass(/light/)
  await expect(theme).not.toHaveClass(/dark/)
  for (const section of sections) {
    await navigate(page, section)
    expect(await theme.evaluate((element) => getComputedStyle(element).colorScheme), section).toBe(
      "light",
    )
  }
})

test("MCP steps distinguish creation, replacement fields, and redacted review", async ({
  page,
}) => {
  const requests = await fixture(page)
  await navigate(page, "MCP connections")
  const choose = page.getByRole("heading", { name: "Saved connections", exact: true })
  await expect(choose).toBeHidden()
  await page.getByRole("button", { name: "Close connection editor", exact: true }).click()
  await expect(choose).toBeVisible()
  await page.getByRole("button", { name: "Add connection", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Add connection", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Save connection", exact: true })).toBeVisible()
  await expect(page.getByRole("textbox", { name: "MCP server name", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Close connection editor", exact: true }).click()
  await expect(choose).toBeVisible()
  await page.getByRole("button", { name: "Edit fields for fixture", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Edit connection", exact: true })).toBeVisible()
  const replacement = page.getByRole("checkbox", { name: "Edit MCP enabled", exact: true })
  const value = page.getByRole("checkbox", { name: "MCP enabled value", exact: true })
  await expect(value).toHaveCount(0)
  await replacement.check()
  await expect(replacement.locator("..")).toContainText("Replace enabled")
  await expect(value.locator("..")).toContainText("Enabled after save")
  await expect(value).toBeChecked()
  await value.uncheck()
  const preview = page.getByRole("region", { name: "MCP change preview", exact: true })
  await expect(preview).toContainText("Set: enabled")
  await expect(preview).toContainText("Preserved: command")
  await expect(preview).toContainText("Preserved: env.OLD")
  await page.getByRole("checkbox", { name: "Edit MCP description", exact: true }).check()
  await page
    .getByRole("textbox", { name: "MCP description replacement", exact: true })
    .fill("private replacement value")
  await expect(preview).not.toContainText("private replacement value")
  await page.getByText("Advanced server configuration JSON", { exact: true }).click()
  const json = page.getByRole("textbox", { name: "Server configuration JSON", exact: true })
  expect(JSON.parse(await json.inputValue())).toMatchObject({
    enabled: false,
    description: "private replacement value",
  })
  await replacement.uncheck()
  expect(JSON.parse(await json.inputValue())).not.toHaveProperty("enabled")
  await expect(value).toHaveCount(0)
  expect(requests.every((request) => request.startsWith("GET "))).toBe(true)
})

test("a failed Audit display can retry a corrected record without a mutation", async ({ page }) => {
  const record = {
    id: 1,
    time: 1,
    actor: "42",
    operation: "settings.update",
    revision: 1,
    outcome: "saved",
    target: "settings",
  }
  const requests = await fixture(page, [], [{ ...record, time: "invalid" }])
  await navigate(page, "Audit")
  await expect(page.getByRole("alert")).toContainText("Audit history could not be displayed.")
  await page.route("**/api/audit?*", (route) => route.fulfill({ json: [record] }))
  await page.getByRole("button", { name: "Retry audit history", exact: true }).click()
  await expect(page.getByRole("list", { name: "Configuration activity" })).toContainText(
    "Settings saved",
  )
  await expect(page.getByRole("alert")).toHaveCount(0)
  expect(requests.every((request) => request.startsWith("GET "))).toBe(true)
})

const goodRecord = {
  id: 1,
  time: 1,
  actor: "42",
  operation: "chat.access.approve",
  revision: 1,
  outcome: "saved",
  target: "chat:42",
}
for (const time of ["invalid", "absent"] as const) {
  const malformed: Record<string, unknown> = { ...goodRecord, id: 2 }
  if (time === "invalid") malformed.time = "not-a-date"
  else delete malformed.time

  test(`Audit contains an ${time} time without breaking valid Chat history or drafts`, async ({
    page,
  }) => {
    await fixture(page, [goodRecord], [{ ...malformed, target: "settings" }])
    await navigate(page, "Access")
    await page.getByLabel("Telegram ID to approve", { exact: true }).fill("1234")
    await navigate(page, "Audit")
    await expect(page.getByRole("alert")).toContainText("Audit history could not be displayed.")
    await expect(
      page.getByRole("region", { name: "Save status and pending changes" }),
    ).toBeVisible()
    await navigate(page, "Chats")
    await page
      .getByRole("list", { name: "Chats on this page" })
      .locator(".directory-chat")
      .first()
      .click()
    await page.getByRole("tab", { name: "History", exact: true }).click()
    const history = page.getByRole("tabpanel", { name: "History", exact: true })
    await expect(history.getByRole("list", { name: "Configuration activity" })).toContainText(
      "chat:42",
    )
    await expect(history.getByRole("alert")).toHaveCount(0)
    await navigate(page, "Access")
    await expect(page.getByLabel("Telegram ID to approve", { exact: true })).toHaveValue("1234")
  })

  test(`Chat history contains an ${time} time independently of global Audit`, async ({ page }) => {
    await fixture(page, [malformed], [{ ...goodRecord, target: "settings" }])
    await page
      .getByRole("list", { name: "Chats on this page" })
      .locator(".directory-chat")
      .first()
      .click()
    await page.getByRole("tab", { name: "History", exact: true }).click()
    const history = page.getByRole("tabpanel", { name: "History", exact: true })
    await expect(history.getByRole("alert")).toContainText("Chat history could not be displayed.")
    await expect(page.getByRole("heading", { name: "Fixture chat", exact: true })).toBeVisible()
    await page.getByRole("tab", { name: "Overview", exact: true }).click()
    await expect(page.getByRole("tabpanel", { name: "Overview", exact: true })).toBeVisible()
    await expect(
      page.getByRole("region", { name: "Save status and pending changes" }),
    ).toBeVisible()
    await navigate(page, "Audit")
    await expect(page.getByRole("list", { name: "Configuration activity" })).toContainText(
      "settings",
    )
    await expect(page.getByRole("alert")).toHaveCount(0)
    await navigate(page, "Defaults")
    await expect(page.getByRole("heading", { name: "Shared defaults", exact: true })).toBeVisible()
  })
}
