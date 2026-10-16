import { inherited, initialPolicy, validateReferences } from "@narumitw/sumire-policy"
import { expect, type Page, test } from "@playwright/test"
import type { Inventory, Policy } from "../src/api.js"

async function navigate(page: Page, name: string) {
  const link = page.getByRole("link", { name, exact: true })
  const menu = page.getByRole("button", { name: /Sections ·/ })
  if (!(await link.isVisible()) && (await menu.isVisible())) await menu.click()
  await link.click()
}

async function setup(page: Page) {
  const initial = initialPolicy()
  initial.tools = ["read", "bash", "mcp__fixture__read"]
  initial.servers = ["fixture"]
  initial.defaults.tools = ["read", "mcp__fixture__read"]
  initial.defaults.servers = ["fixture"]
  initial.privateUsers = [42, 43]
  initial.chats["43"] = { ...inherited, enabled: true, tools: ["read"] }
  let saved = structuredClone(initial)
  let revision = 1
  const inventory: Inventory = {
    tools: ["read", "bash", "write"],
    providers: [],
    mcp: [
      {
        name: "fixture",
        connection: "not tested",
        tools: ["mcp__fixture__read"],
        enabled: true,
        env: {},
        headers: {},
      },
    ],
  }
  const writes: string[] = []
  await page.route("**/api/**", async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() !== "GET") writes.push(path)
    if (path === "/api/session") return route.fulfill({ json: { actor: "42", csrf: "fixture" } })
    if (path === "/api/settings") {
      if (request.method() === "PUT") {
        const next: Policy = request.postDataJSON().policy
        try {
          validateReferences(next)
        } catch (error) {
          return route.fulfill({ status: 400, json: { error: String(error) } })
        }
        saved = next
        revision++
      }
      return route.fulfill({
        json: { policy: saved, revision, applied: revision, status: "applied" },
      })
    }
    if (path === "/api/inventory") return route.fulfill({ json: inventory })
    if (path === "/api/chats")
      return route.fulfill({
        json: [
          { id: 42, name: "Inherited chat", type: "private" },
          { id: 43, name: "Explicit chat", type: "private" },
        ],
      })
    if (path === "/api/mcp/fixture/discover") {
      inventory.mcp[0]?.tools.push("mcp__fixture__new")
      saved.tools.push("mcp__fixture__new")
      saved.defaults.tools?.push("mcp__fixture__new")
      revision++
      return route.fulfill({ json: {} })
    }
    if (path === "/api/mcp/draft") {
      revision++
      return route.fulfill({ json: {} })
    }
    return route.fulfill({ json: [] })
  })
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "Chats", exact: true })).toBeVisible()
  return { initial, writes, saved: () => saved }
}

async function savePolicy(page: Page) {
  await page.getByRole("button", { name: "Apply policy changes", exact: true }).click()
  await page.getByRole("button", { name: "Save and apply", exact: true }).click()
}

for (const width of [1440, 390]) {
  test(`canonical global/default controls and summary context at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    const state = await setup(page)
    await navigate(page, "Defaults")
    await expect(page.getByRole("group", { name: "Authorized tools", exact: true })).toHaveCount(0)
    await expect(
      page.getByRole("group", { name: "Authorized MCP servers", exact: true }),
    ).toHaveCount(0)
    await expect(
      page
        .getByRole("region", { name: "Shared defaults", exact: true })
        .getByText(/Saved defaults: 2 default tool names/),
    ).toBeVisible()
    await page.getByRole("link", { name: "Manage default tool permissions", exact: true }).click()
    await expect(page).toHaveURL(/section=Tool\+permissions.*#default-tool-permissions/)
    await expect(
      page.getByRole("heading", { name: "Global and default chat permissions" }),
    ).toBeFocused()
    await expect(
      page.getByText("New tools are denied until explicitly approved.", { exact: false }),
    ).toHaveCount(0)
    await expect(
      page.getByText(/New tools are enabled in global and default permissions/),
    ).toBeVisible()
    const blocked = page.getByRole("checkbox", {
      name: "Default chat permission for tool write",
      exact: true,
    })
    await expect(blocked).toBeDisabled()
    await expect(blocked).toHaveAccessibleDescription("Unavailable globally")
    const global = page.getByRole("checkbox", { name: "Globally allow tool bash", exact: true })
    const defaults = page.getByRole("checkbox", {
      name: "Default chat permission for tool bash",
      exact: true,
    })
    await expect(global).toBeChecked()
    await expect(defaults).not.toBeChecked()
    await defaults.focus()
    await page.keyboard.press("Space")
    await expect(defaults).toBeChecked()
    await expect(defaults).toBeFocused()
    await page.screenshot({ path: testInfo.outputPath(`permissions-${width}.png`), fullPage: true })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await navigate(page, "Defaults")
    await expect(
      page
        .getByRole("region", { name: "Shared defaults", exact: true })
        .getByText(/Saved defaults: 2 default tool names/),
    ).toBeVisible()
    await expect(
      page
        .getByRole("region", { name: "Shared defaults", exact: true })
        .getByText(/Policy draft defaults: 3 default tool names/),
    ).toBeVisible()
    await page.getByRole("link", { name: "Manage default tool permissions", exact: true }).click()
    await expect(defaults).toBeChecked()
    expect(state.writes).toEqual([])
    await savePolicy(page)
    await expect(page.getByText("Saved revision applied.", { exact: true })).toBeVisible()
    expect(state.saved().defaults.tools).toContain("bash")
    expect(state.saved().chats).toEqual(state.initial.chats)
  })
}

test("global removal retains defaults and overrides, shows exact references, and cannot bypass save validation", async ({
  page,
}) => {
  const state = await setup(page)
  await navigate(page, "Tool permissions")
  const global = page.getByRole("checkbox", { name: "Globally allow tool read", exact: true })
  const defaults = page.getByRole("checkbox", {
    name: "Default chat permission for tool read",
    exact: true,
  })
  await global.uncheck()
  await expect(defaults).toBeChecked()
  await expect(defaults).toHaveAccessibleDescription(/Unavailable globally.*retained/)
  await expect(page.getByText(/1 explicit chat override/)).toBeVisible()
  await savePolicy(page)
  await expect(page.getByRole("alert")).toContainText(
    "Defaults: tools selection exceeds global availability: read",
  )
  expect(state.saved()).toEqual(state.initial)
  await navigate(page, "Defaults")
  await page.getByRole("link", { name: "Manage default tool permissions", exact: true }).click()
  await expect(global).not.toBeChecked()
  await expect(defaults).toBeChecked()
  await defaults.uncheck()
  await expect(defaults).toBeDisabled()
  await page.getByRole("button", { name: "Review chat 43", exact: true }).click()
  await expect(page).toHaveURL(/section=Chats.*chat=43|chat=43.*section=Chats/)
  await page.getByRole("tab", { name: "Model & Tools", exact: true }).click()
  const tools = page.getByRole("group", { name: "Authorized tools", exact: true })
  await expect(
    tools.getByRole("checkbox", { name: "read (no longer available)", exact: true }),
  ).toBeChecked()
  await tools.getByRole("checkbox", { name: "read (no longer available)", exact: true }).click()
  await expect(
    tools.getByRole("checkbox", { name: "read (no longer available)", exact: true }),
  ).toHaveCount(0)
  await savePolicy(page)
  await expect(page.getByText("Saved revision applied.", { exact: true })).toBeVisible()
  expect(state.saved().tools).not.toContain("read")
  expect(state.saved().defaults.tools).not.toContain("read")
  expect(state.saved().chats["43"]?.tools).toEqual([])
})

test("MCP connectivity, server gates, new tools, and manual approvals keep separate save boundaries", async ({
  page,
}) => {
  const state = await setup(page)
  await navigate(page, "MCP connections")
  await expect(
    page.getByRole("checkbox", { name: /Globally allow|Default chat permission/ }),
  ).toHaveCount(0)
  await expect(
    page.getByText(/Connection configuration and enabled state do not grant execution permission/),
  ).toBeVisible()
  expect(state.writes).toEqual([])
  await page.getByRole("button", { name: "Test and discover fixture", exact: true }).click()
  await page
    .getByRole("button", { name: "Manage tool and MCP server permissions", exact: true })
    .click()
  const discovered = page.getByRole("checkbox", {
    name: "Globally allow tool mcp__fixture__new",
    exact: true,
  })
  await expect(discovered).toBeChecked()
  await expect(
    page.getByRole("checkbox", {
      name: "Default chat permission for tool mcp__fixture__new",
      exact: true,
    }),
  ).toBeChecked()
  const server = page.getByRole("checkbox", { name: "Globally allow server fixture", exact: true })
  await server.uncheck()
  await expect(
    page.getByRole("checkbox", { name: "Globally allow tool mcp__fixture__read", exact: true }),
  ).toBeChecked()
  await expect(
    page.getByRole("checkbox", { name: "Default chat permission for server fixture", exact: true }),
  ).toBeChecked()
  await server.check()
  await page
    .getByLabel("Additional approved tool name", { exact: true })
    .fill("mcp__offline__manual")
  await navigate(page, "MCP connections")
  await page.getByLabel("MCP server name", { exact: true }).fill("draft")
  await navigate(page, "Tool permissions")
  await expect(page.getByLabel("Additional approved tool name", { exact: true })).toHaveValue(
    "mcp__offline__manual",
  )
  await page.getByRole("button", { name: "Add tool to pending approval", exact: true }).click()
  await expect(
    page.getByRole("checkbox", { name: "Globally allow tool mcp__offline__manual", exact: true }),
  ).toBeChecked()
  await expect(
    page.getByRole("checkbox", {
      name: "Default chat permission for tool mcp__offline__manual",
      exact: true,
    }),
  ).not.toBeChecked()
  await savePolicy(page)
  await expect(page.getByText("Saved revision applied.", { exact: true })).toBeVisible()
  expect(state.saved().tools).toContain("mcp__offline__manual")
  expect(state.saved().tools).toContain("mcp__fixture__new")
  expect(state.saved().defaults.tools).toContain("mcp__fixture__new")
  expect(state.saved().defaults.servers).toEqual(state.initial.defaults.servers)
  expect(state.writes).toEqual(["/api/mcp/fixture/discover", "/api/settings"])
  await navigate(page, "MCP connections")
  await expect(page.getByLabel("MCP server name", { exact: true })).toHaveValue("draft")
  await page.getByRole("button", { name: "Save MCP configuration and apply", exact: true }).click()
  await expect(page.getByRole("button", { name: "Discard MCP draft", exact: true })).toHaveCount(0)
  expect(state.writes).toEqual(["/api/mcp/fixture/discover", "/api/settings", "/api/mcp/draft"])
})

test("legacy links open canonical permissions without policy changes or remote tests", async ({
  page,
}) => {
  const state = await setup(page)
  await page.goto("/?section=Tools+%2F+MCP&chat=42")
  await expect(page.getByRole("heading", { name: "Tool permissions", exact: true })).toBeVisible()
  await navigate(page, "MCP connections")
  await navigate(page, "Tool permissions")
  await page.goBack()
  await expect(page.getByRole("heading", { name: "MCP connections", exact: true })).toBeVisible()
  expect(state.writes).toEqual([])
})
