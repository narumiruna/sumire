import { inherited } from "@narumitw/sumire-policy"
import { expect, type Page, test } from "@playwright/test"
import {
  navigate,
  openChatConfiguration,
  openDirectoryFilters,
  openGlobalLimits,
} from "./admin-fixture.js"
import { remediationFixture } from "./remediation-fixture.js"

async function fixture(page: Page) {
  const state = await remediationFixture(page)
  state.policy().chats["42"] = { ...inherited, enabled: false, tools: ["read_url_content"] }
  const chats = [
    { id: 42, name: "Approved but disabled 👩‍💻 日本語 ".repeat(6), type: "private" },
    { id: 43, name: "Unapproved chat", type: "private" },
  ]
  const reads: URLSearchParams[] = []
  await page.route("**/api/chats?*", async (route) => {
    const params = new URL(route.request().url()).searchParams
    reads.push(params)
    const id = params.get("id")
    const query = params.get("q") ?? ""
    return route.fulfill({
      json: chats.filter((chat) =>
        id ? String(chat.id) === id : chat.name.includes(query) || String(chat.id) === query,
      ),
    })
  })
  await page.reload()
  await expect(page.locator(".directory-row")).toHaveCount(2)
  return { ...state, reads }
}

function row(page: Page, id: number) {
  return page
    .locator(".directory-row")
    .filter({ has: page.locator(`.directory-chat[href*="chat=${id}"]`) })
}

for (const width of [1440, 390, 320]) {
  test(`management columns keep access, saved diagnostics, copy and repairs separate at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: async (value: string) => {
            Object.assign(window, { copiedChatId: value })
          },
        },
      })
    })
    const state = await fixture(page)
    const approved = row(page, 42)
    await expect(approved.locator(".directory-approval")).toHaveText("Approved")
    await expect(approved.locator(".directory-row-state")).toContainText("Disabled")
    await expect(approved.locator(".directory-model")).toContainText("fixture/test")
    await expect(approved.locator(".directory-model")).toContainText("Shared defaults")
    await expect(approved.locator(".directory-issues")).toContainText("The chat is disabled.")
    await expect(
      approved.getByRole("button", { name: "Review chat enabled switch", exact: true }),
    ).toBeVisible()
    await expect(approved.getByRole("button", { name: "Manage access", exact: true })).toBeVisible()
    await approved.getByRole("button", { name: "Copy chat ID 42", exact: true }).click()
    await expect(approved.getByRole("status")).toHaveText("Chat ID copied.")
    expect(await page.evaluate(() => Reflect.get(window, "copiedChatId"))).toBe("42")
    await expect(approved.getByRole("link")).toHaveAttribute("href", /chat=42/)
    await expect(approved.locator("a button, button button")).toHaveCount(0)
    await row(page, 43).getByRole("button", { name: "Grant access", exact: true }).click()
    await expect(row(page, 43).locator(".directory-approval")).toHaveText("Not approved")
    await expect(row(page, 43)).toContainText("Pending access grant")
    await approved.getByRole("button", { name: /^Actions for / }).click()
    await page.getByRole("menuitem", { name: "Revoke access", exact: true }).click()
    await expect(approved.locator(".directory-approval")).toHaveText("Approved")
    await expect(approved).toContainText("Pending access revocation")
    await expect(approved.locator(".directory-issues")).toContainText("The chat is disabled.")
    expect(state.writes).toEqual([])
    expect(state.policy().privateUsers).toEqual([42])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}

test("directory return retains query, page filters, selected row focus and exact metadata lookup", async ({
  page,
}) => {
  const state = await fixture(page)
  const search = page.getByRole("textbox", { name: "Search stored chats", exact: true })
  await search.fill("42")
  await expect(page.locator(".directory-row")).toHaveCount(1)
  await openDirectoryFilters(page)
  await page.getByRole("combobox", { name: "Chat type", exact: true }).click()
  await page.getByRole("option", { name: "Private", exact: true }).click()
  await row(page, 42).getByRole("link").click()
  await expect(page).toHaveURL(/chat=42/)
  await expect.poll(() => state.reads.some((params) => params.get("id") === "42")).toBe(true)
  await page.getByRole("button", { name: "Back to chat directory", exact: true }).click()
  await expect(search).toHaveValue("42")
  await expect(page.getByRole("combobox", { name: "Chat type", exact: true })).toHaveText("Private")
  await expect(row(page, 42).getByRole("link")).toBeFocused()
  expect(state.writes).toEqual([])
})

test("unknown inventory is a saved diagnostic with a visible configuration repair", async ({
  page,
}) => {
  const state = await fixture(page)
  state.inventory.providers = []
  await page.reload()
  await expect(row(page, 43).locator(".directory-issues")).toContainText(
    "Provider configuration is not in the loaded inventory.",
  )
  await expect(
    row(page, 43).getByRole("button", { name: "Review authentication configuration", exact: true }),
  ).toBeVisible()
  await expect(row(page, 43)).not.toContainText("Ready")
  expect(state.writes).toEqual([])
})

test("permission scopes route the selected chat to its category editor and leave explicit selections unchanged", async ({
  page,
}) => {
  const state = await fixture(page)
  await row(page, 42).getByRole("link").click()
  await navigate(page, "Tool permissions")
  const scope = page.getByRole("region", { name: "Permission editing scope", exact: true })
  await expect(scope.getByRole("button", { name: "Global policy", exact: true })).toBeVisible()
  await expect(scope.getByRole("button", { name: "Shared defaults", exact: true })).toBeVisible()
  await scope.getByRole("button", { name: "Selected chat 42", exact: true }).click()
  await expect(page).toHaveURL(/chat=42/)
  await openChatConfiguration(page)
  const tools = page.getByRole("group", { name: "Authorized tools", exact: true })
  await expect(tools).toContainText("Allow read_url_content; deny other names in this category")
  await expect(
    tools.getByRole("checkbox", { name: "Inherit default", exact: true }),
  ).not.toBeChecked()
  await tools
    .getByRole("button", { name: "Reset authorized tools to default", exact: true })
    .click()
  await expect(tools.getByRole("checkbox", { name: "Inherit default", exact: true })).toBeChecked()
  await tools.getByRole("checkbox", { name: "Inherit default", exact: true }).uncheck()
  await expect(tools).toContainText("Deny all names in this category")
  await expect(tools).toContainText("This does not inherit shared defaults")
  expect(state.policy().chats["42"]?.tools).toEqual(["read_url_content"])
  expect(state.writes).toEqual([])
})

test("filtered conflicts retain names and scopes, link to the global rule, and cannot bypass save validation", async ({
  page,
}) => {
  const state = await fixture(page)
  await navigate(page, "Tool permissions")
  await openGlobalLimits(page)
  const global = page.getByRole("checkbox", {
    name: "Globally allow tool read_url_content",
    exact: true,
  })
  await global.uncheck()
  await page
    .getByRole("textbox", { name: "Search tools and servers", exact: true })
    .fill("no-matching-tool")
  const conflicts = page.getByRole("region", { name: "Retained permission conflicts", exact: true })
  await expect(conflicts).toContainText("1 tool/server name")
  await expect(conflicts).toContainText("read_url_content")
  await expect(conflicts).toContainText("Shared defaults")
  await expect(conflicts).toContainText("1 explicit chat override: 42")
  await expect(page.getByText("No matching tools or servers.", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Review and save changes", exact: true }).click()
  await page.getByRole("button", { name: "Save changes", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("tools selection exceeds global availability")
  expect(state.policy().tools).toContain("read_url_content")
  expect(state.writes).toEqual([])
  await conflicts
    .getByRole("button", { name: "Review global permission for read_url_content", exact: true })
    .click()
  await expect(global).toBeFocused()
  await expect(global).not.toBeChecked()
  await expect(
    page.getByRole("checkbox", {
      name: "Default chat permission for tool read_url_content",
      exact: true,
    }),
  ).toBeChecked()
  await expect(
    page.getByRole("region", { name: "Permission editing scope", exact: true }),
  ).toContainText("Global policy")
})

test("a blocked MCP tool names the server rule and its repair focuses the retained gate", async ({
  page,
}) => {
  const state = await fixture(page)
  state.policy().tools.push("mcp_fixture_read")
  state.policy().defaults.tools?.push("mcp_fixture_read")
  const server = state.inventory.mcp[0]
  if (!server) throw new Error("Missing fixture MCP server")
  server.tools = ["mcp_fixture_read"]
  await page.reload()
  await navigate(page, "Tool permissions")
  await page
    .getByRole("textbox", { name: "Search tools and servers", exact: true })
    .fill("mcp_fixture_read")
  const tool = page.locator('.permission-row[data-permission-name="mcp_fixture_read"]')
  await expect(tool).toContainText("Configured: Allow · Shared defaults")
  await expect(tool).toContainText("Blocking source: MCP server permission: fixture")
  await expect(tool).toContainText("Server gate blocked")
  await tool.getByRole("button", { name: "Review server gate fixture", exact: true }).click()
  await expect(
    page.getByRole("checkbox", { name: "Globally allow server fixture", exact: true }),
  ).toBeFocused()
  expect(state.writes).toEqual([])
})
