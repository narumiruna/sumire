import { initialPolicy } from "@narumitw/sumire-policy"
import { expect, type Page, test } from "@playwright/test"
import {
  openConnectionEditor,
  openDirectoryFilters,
  openDisclosure,
  sectionLabel,
} from "./admin-fixture.js"

const longName = "Long group name with multilingual metadata 管理員 🌸 ".repeat(12).trim()
const chats = [
  { id: 42, name: "Private chat", type: "private" },
  { id: -100, name: longName, type: "supergroup" },
  { id: -101, name: "Denied channel", type: "channel" },
]

async function fixture(page: Page, section = "Chats") {
  const auditQueries: URLSearchParams[] = []
  const writes: string[] = []
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url())
    if (route.request().method() !== "GET") writes.push(url.pathname)
    if (url.pathname === "/api/audit") auditQueries.push(url.searchParams)
    const data: Record<string, unknown> = {
      "/api/session": { csrf: "fixture", actor: "42" },
      "/api/settings": {
        revision: 1,
        applied: 1,
        status: "applied",
        policy: {
          ...initialPolicy(),
          privateUsers: [42],
          groups: [-100],
        },
      },
      "/api/inventory": {
        tools: [],
        builtInTools: [],
        providers: [],
        mcp: [
          {
            name: "fixture",
            fields: ["command", "args", "env", "enabled", "exposure"],
            enabled: true,
            exposure: "codemode",
            env: { TOKEN: null },
            headers: {},
            tools: [],
            connection: "not tested",
          },
        ],
      },
      "/api/chats": url.searchParams.has("id")
        ? chats.filter((chat) => String(chat.id) === url.searchParams.get("id"))
        : chats,
      "/api/audit": [],
      "/api/imports": [],
    }
    await route.fulfill({ json: data[url.pathname] ?? {} })
  })
  await page.goto(`/?section=${encodeURIComponent(section)}`)
  await expect(
    page.getByRole("heading", { name: sectionLabel(section), exact: true }),
  ).toBeVisible()
  if (section === "MCP connections") await openConnectionEditor(page, true)
  if (section === "Audit") await openDisclosure(page, "Filters")
  return { auditQueries, writes }
}

async function choose(page: Page, name: string, option: string) {
  if (name === "Chat type" || name === "Access status") await openDirectoryFilters(page)
  await page.getByRole("combobox", { name, exact: true }).click()
  await page.getByRole("option", { name: option, exact: true }).click()
}

for (const width of [1440, 390]) {
  test(`chat controls retain filter semantics and the full two-line heading at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    const { writes } = await fixture(page)
    const rows = page.locator(".chat-list button")
    await expect(rows).toHaveCount(3)
    await choose(page, "Chat type", "Group / supergroup")
    await expect(rows).toHaveCount(1)
    await choose(page, "Access status", "Not approved or disabled")
    await expect(rows).toHaveCount(0)
    await choose(page, "Access status", "Approved and enabled")
    await expect(rows).toHaveCount(1)
    await rows.click()
    const heading = page.getByRole("heading", { name: longName, exact: true })
    await expect(heading).toHaveAttribute("title", longName)
    expect(
      await heading.evaluate((element) => {
        const style = getComputedStyle(element)
        return element.getBoundingClientRect().height <= Number.parseFloat(style.lineHeight) * 2 + 1
      }),
    ).toBe(true)
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true)
    expect(writes).toEqual([])
  })

  test(`audit dates retain inclusive UTC bounds and balanced rows at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    const { auditQueries, writes } = await fixture(page, "Audit")
    const fields = page.locator(
      ".audit-filters .rt-TextFieldRoot, .audit-filters button[role=combobox]",
    )
    await expect(fields).toHaveCount(5)
    for (const label of ["From date (UTC)", "Through date (UTC)"]) {
      const date = page.getByLabel(label, { exact: true })
      await expect(date).toHaveAccessibleName(label)
      await expect(date).toHaveAttribute("type", "date")
      await expect(date.locator("..")).toHaveClass(/rt-TextFieldRoot/)
    }
    const boxes = await fields.evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect()
        return { x: rect.x, y: rect.y }
      }),
    )
    if (width === 1440) {
      expect(boxes[0]?.y).toBe(boxes[1]?.y)
      expect(boxes[1]?.y).toBe(boxes[2]?.y)
      expect(boxes[3]?.y).toBe(boxes[4]?.y)
    } else {
      expect(new Set(boxes.map((box) => box.x)).size).toBe(1)
      expect(new Set(boxes.map((box) => box.y)).size).toBe(5)
    }
    await page.getByLabel("From date (UTC)", { exact: true }).fill("2026-10-20")
    await page.getByLabel("Through date (UTC)", { exact: true }).fill("2026-10-21")
    await page.getByRole("button", { name: "Apply audit filters", exact: true }).click()
    await expect.poll(() => auditQueries.at(-1)?.get("from")).toBe(String(Date.UTC(2026, 9, 20)))
    expect(auditQueries.at(-1)?.get("to")).toBe(String(Date.UTC(2026, 9, 22) - 1))
    const count = auditQueries.length
    await page.getByLabel("From date (UTC)", { exact: true }).fill("2026-10-22")
    await page.getByRole("button", { name: "Apply audit filters", exact: true }).click()
    await expect(page.getByRole("alert")).toContainText("Start date must precede end date.")
    expect(auditQueries).toHaveLength(count)
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true)
    expect(writes).toEqual([])
  })
}

test("MCP field replacement selectors stay distinct from values and preserve patch operations", async ({
  page,
}) => {
  const { writes } = await fixture(page, "MCP connections")
  const preview = page.getByRole("region", { name: "MCP change preview", exact: true })
  const enabled = page.getByRole("checkbox", { name: "Edit MCP enabled", exact: true })
  await expect(enabled.locator("..")).toContainText("Replace enabled")
  await expect(page.getByRole("checkbox", { name: "MCP enabled value", exact: true })).toHaveCount(
    0,
  )
  await enabled.check()
  const value = page.getByRole("checkbox", { name: "MCP enabled value", exact: true })
  await expect(value.locator("..")).toContainText("Enabled after save")
  await value.uncheck()
  await expect(preview).toContainText("Set / replaced: enabled")
  await enabled.uncheck()
  await expect(preview).toContainText("Preserved: enabled")
  await expect(value).toHaveCount(0)
  await choose(page, "Connection type", "Replace with HTTP endpoint")
  await page
    .getByRole("textbox", { name: "Connection URL", exact: true })
    .fill("https://fixture.example/mcp")
  await expect(preview).toContainText("Removed by transport selection: command")
  await expect(preview).toContainText("Removed by transport selection: env")
  await page.getByRole("checkbox", { name: "Edit MCP exposure", exact: true }).check()
  await choose(page, "MCP exposure replacement", "hidden")
  await choose(page, "MCP type replacement", "streamable-http")
  await page.getByText("Advanced server configuration JSON", { exact: true }).click()
  await expect(
    page.getByRole("textbox", { name: "Server configuration JSON", exact: true }),
  ).toHaveValue(
    JSON.stringify(
      {
        url: "https://fixture.example/mcp",
        type: "streamable-http",
        exposure: "hidden",
      },
      null,
      2,
    ),
  )
  await expect(preview).not.toContainText("https://fixture.example/mcp")
  expect(writes).toEqual([])
})

for (const name of [
  "Chat type",
  "Access status",
  "Connection type",
  "MCP exposure replacement",
  "MCP type replacement",
]) {
  test(`${name} closes on Escape and when its section becomes inactive`, async ({ page }) => {
    await fixture(page, "Access")
    const mcp = name.startsWith("MCP") || name === "Connection type"
    const section = mcp ? "MCP connections" : "Chats"
    await page.getByRole("link", { name: sectionLabel(section), exact: true }).click()
    if (!mcp) await openDirectoryFilters(page)
    if (mcp) {
      await openConnectionEditor(page, true)
      await openDisclosure(page, "Advanced connection fields")
      if (name === "MCP exposure replacement")
        await page.getByRole("checkbox", { name: "Edit MCP exposure", exact: true }).check()
      if (name === "MCP type replacement")
        await page.getByRole("checkbox", { name: "Edit MCP type", exact: true }).check()
    }
    const trigger = page.getByRole("combobox", { name, exact: true })
    await trigger.click()
    await expect(page.getByRole("listbox")).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(page.getByRole("listbox")).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await trigger.click()
    await page.goBack()
    await expect(page.getByRole("heading", { name: "Chat access", exact: true })).toBeVisible()
    await expect(page.getByRole("listbox")).toHaveCount(0)
    await page.goForward()
    await expect(trigger).toBeVisible()
    await expect(trigger).toHaveAttribute("aria-expanded", "false")
  })
}
