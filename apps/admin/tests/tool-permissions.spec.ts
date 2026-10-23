import { inherited, initialPolicy, validateReferences } from "@narumitw/sumire-policy"
import { expect, type Page, test } from "@playwright/test"
import type { Inventory, Policy } from "../src/api.js"
import {
  openChatConfiguration,
  openConnectionEditor,
  openDisclosure,
  sectionLabel,
} from "./admin-fixture.js"

async function navigate(page: Page, name: string) {
  const link = page.getByRole("link", { name: sectionLabel(name), exact: true })
  const menu = page.getByRole("button", { name: /Sections ·/ })
  if (!(await link.isVisible()) && (await menu.isVisible())) await menu.click()
  await link.click()
  if (name === "MCP connections") await openConnectionEditor(page)
}

async function setup(page: Page, options: { actor?: string; inventory?: Inventory } = {}) {
  const initial = initialPolicy()
  initial.tools = ["read", "bash", "mcp__fixture__read"]
  initial.servers = ["fixture"]
  initial.defaults.tools = ["read", "mcp__fixture__read"]
  initial.defaults.servers = ["fixture"]
  initial.privateUsers = [42, 43]
  initial.chats["43"] = { ...inherited, enabled: true, tools: ["read"] }
  let saved = structuredClone(initial)
  let revision = 1
  const inventory: Inventory = options.inventory ?? {
    builtInTools: ["read", "bash", "write"],
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
    if (path === "/api/session")
      return route.fulfill({ json: { actor: options.actor ?? "42", csrf: "fixture" } })
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
    await openDisclosure(page, "Permission rules and inheritance")
    await expect(
      page.getByText(/New tools are added to global and default permissions/),
    ).toBeVisible()
    if (
      (await page
        .getByRole("button", { name: "Built-in tools · 3 tools", exact: true })
        .getAttribute("aria-expanded")) === "false"
    )
      await page.getByRole("button", { name: "Built-in tools · 3 tools", exact: true }).click()
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
    await expect(page.getByText("All settings saved and applied.", { exact: true })).toBeVisible()
    expect(state.saved().defaults.tools).toContain("bash")
    expect(state.saved().chats).toEqual(state.initial.chats)
  })
}

for (const width of [1440, 390]) {
  test(`imagegen capability diagnostics remain separate from global and default permissions at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    const inventory: Inventory = {
      tools: ["read", "bash", "generate_image"],
      builtInTools: ["read", "bash", "generate_image"],
      providers: [],
      mcp: [],
      toolAvailability: {
        generate_image: {
          available: false,
          reason: "Requires compatible openai-codex OAuth. Check Model providers.",
        },
      },
    }
    const state = await setup(page, { inventory })
    await navigate(page, "Tool permissions")
    if (
      (await page
        .getByRole("button", { name: "Built-in tools · 3 tools", exact: true })
        .getAttribute("aria-expanded")) === "false"
    )
      await page.getByRole("button", { name: "Built-in tools · 3 tools", exact: true }).click()
    const row = page
      .getByRole("listitem")
      .filter({ has: page.getByText("generate_image", { exact: true }) })
    await expect(row.getByText("Capability unavailable", { exact: true })).toBeVisible()
    await expect(row.getByText(/Requires compatible openai-codex OAuth/)).toBeVisible()
    const global = row.getByRole("checkbox", {
      name: "Globally allow tool generate_image",
      exact: true,
    })
    const defaults = row.getByRole("checkbox", {
      name: "Default chat permission for tool generate_image",
      exact: true,
    })
    await expect(global).not.toBeChecked()
    await expect(defaults).not.toBeChecked()
    expect(state.writes).toEqual([])
    await global.check()
    await expect(defaults).not.toBeChecked()
    await expect(row.getByText("Not allowed for inheriting chats", { exact: true })).toBeVisible()
    await defaults.check()
    await savePolicy(page)
    await expect(page.getByText("All settings saved and applied.", { exact: true })).toBeVisible()
    expect(state.saved().tools).toContain("generate_image")
    expect(state.saved().defaults.tools).toContain("generate_image")
    expect(state.saved().chats).toEqual(state.initial.chats)
    await expect(row.getByText("Capability unavailable", { exact: true })).toBeVisible()
    inventory.toolAvailability = {
      generate_image: {
        available: true,
        reason: "Codex OAuth is configured; experimental image access is not verified.",
      },
    }
    await page.reload()
    await expect(row.getByText("Capability configured", { exact: true })).toBeVisible()
    await expect(row.getByText(/experimental image access is not verified/)).toBeVisible()
    await expect(global).toBeChecked()
    await expect(defaults).toBeChecked()
    expect(state.writes).toEqual(["/api/settings"])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}

for (const width of [1440, 390]) {
  test(`MCP tool groups collapse without changing permissions at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const state = await setup(page)
    await navigate(page, "Tool permissions")
    const summary = page.getByRole("button", { name: "MCP: fixture · 1 tool", exact: true })
    const global = page.getByRole("checkbox", {
      name: "Globally allow tool mcp__fixture__read",
      exact: true,
    })
    await expect(summary).toBeVisible()
    await expect(global).not.toBeVisible()
    await expect(
      page.getByRole("checkbox", { name: "Globally allow tool read", exact: true }),
    ).toBeVisible()
    await expect(summary).toHaveAttribute("aria-expanded", "false")
    await summary.focus()
    await page.keyboard.press("Enter")
    await expect(global).toBeVisible()
    const defaults = page.getByRole("checkbox", {
      name: "Default chat permission for tool mcp__fixture__read",
      exact: true,
    })
    await defaults.uncheck()
    await summary.click()
    await expect(defaults).not.toBeVisible()
    await summary.click()
    await expect(defaults).not.toBeChecked()
    await expect(global).toBeChecked()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(state.writes).toEqual([])
    await savePolicy(page)
    await expect(page.getByText("All settings saved and applied.", { exact: true })).toBeVisible()
    expect(state.saved().tools).toEqual(state.initial.tools)
    expect(state.saved().defaults.tools).toEqual(["read"])
  })
}

test("global removal retains defaults and overrides, shows exact references, and cannot bypass save validation", async ({
  page,
}) => {
  const state = await setup(page)
  await navigate(page, "Tool permissions")
  if (
    (await page
      .getByRole("button", { name: "Built-in tools · 3 tools", exact: true })
      .getAttribute("aria-expanded")) === "false"
  )
    await page.getByRole("button", { name: "Built-in tools · 3 tools", exact: true }).click()
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
  await openChatConfiguration(page)
  const tools = page.getByRole("group", { name: "Authorized tools", exact: true })
  await expect(
    tools.getByRole("checkbox", { name: "read (no longer available)", exact: true }),
  ).toBeChecked()
  await tools.getByRole("checkbox", { name: "read (no longer available)", exact: true }).click()
  await expect(
    tools.getByRole("checkbox", { name: "read (no longer available)", exact: true }),
  ).toHaveCount(0)
  await savePolicy(page)
  await expect(page.getByText("All settings saved and applied.", { exact: true })).toBeVisible()
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
  await openDisclosure(page, "Connection permissions and discovery")
  await expect(
    page.getByText(/Connection configuration and enabled state do not grant execution permission/),
  ).toBeVisible()
  expect(state.writes).toEqual([])
  await page.getByRole("button", { name: "Test and discover fixture", exact: true }).click()
  await page
    .getByRole("button", { name: "Manage tool and MCP server permissions", exact: true })
    .click()
  await page.getByRole("button", { name: "MCP: fixture · 2 tools", exact: true }).click()
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
  await openDisclosure(page, "Approve an exact tool name")
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
  await page.getByRole("button", { name: "Unknown source · 1 tool", exact: true }).click()
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

test("bulk expansion persists per user and new groups start collapsed", async ({ page }) => {
  const state = await setup(page)
  await navigate(page, "Tool permissions")
  const builtin = page.getByRole("button", { name: "Built-in tools · 3 tools", exact: true })
  const fixture = page.getByRole("button", { name: "MCP: fixture · 1 tool", exact: true })
  await page.getByRole("button", { name: "Expand all", exact: true }).click()
  await expect(builtin).toHaveAttribute("aria-expanded", "true")
  await expect(fixture).toHaveAttribute("aria-expanded", "true")
  await page.reload()
  await expect(builtin).toHaveAttribute("aria-expanded", "true")
  await fixture.click()
  await page.reload()
  await expect(builtin).toHaveAttribute("aria-expanded", "true")
  await expect(fixture).toHaveAttribute("aria-expanded", "false")
  await page.getByRole("button", { name: "Collapse all", exact: true }).click()
  await page.reload()
  await expect(builtin).toHaveAttribute("aria-expanded", "false")
  await page.getByRole("button", { name: "Expand all", exact: true }).click()
  expect(state.writes).toEqual([])

  await setup(page, { actor: "43" })
  await navigate(page, "Tool permissions")
  await expect(builtin).toHaveAttribute("aria-expanded", "true")
  await expect(fixture).toHaveAttribute("aria-expanded", "false")

  await setup(page, {
    inventory: {
      tools: ["read", "bash", "write", "unattributed"],
      builtInTools: ["read", "bash", "write"],
      providers: [],
      mcp: [
        {
          name: "fixture",
          tools: ["mcp__fixture__read"],
          connection: "not tested",
          env: {},
          headers: {},
        },
        {
          name: "new-server",
          tools: ["plain-name"],
          connection: "not tested",
          env: {},
          headers: {},
        },
      ],
    },
  })
  await navigate(page, "Tool permissions")
  await expect(builtin).toHaveAttribute("aria-expanded", "true")
  await expect(fixture).toHaveAttribute("aria-expanded", "true")
  await expect(
    page.getByRole("button", { name: "MCP: new-server · 1 tool", exact: true }),
  ).toHaveAttribute("aria-expanded", "false")
  await expect(
    page.getByRole("button", { name: "Unknown source · 1 tool", exact: true }),
  ).toHaveAttribute("aria-expanded", "false")
})

test("duplicate tool names appear under both metadata servers and share existing name-based permissions", async ({
  page,
}) => {
  const inventory: Inventory = {
    tools: ["read", "bash", "write", "unattributed"],
    builtInTools: ["read", "bash", "write"],
    providers: [],
    mcp: [
      {
        name: "fixture",
        tools: ["mcp__fixture__read"],
        connection: "not tested",
        env: {},
        headers: {},
      },
      {
        name: "other",
        tools: ["mcp__fixture__read"],
        connection: "not tested",
        env: {},
        headers: {},
      },
    ],
  }
  await setup(page, { inventory })
  await navigate(page, "Tool permissions")
  await page.getByRole("button", { name: "Expand all", exact: true }).click()
  const first = page.getByRole("region", { name: "MCP: fixture", exact: true })
  const second = page.getByRole("region", { name: "MCP: other", exact: true })
  const permission = { name: "Default chat permission for tool mcp__fixture__read", exact: true }
  await expect(first.getByRole("checkbox", permission)).toBeChecked()
  await expect(second.getByRole("checkbox", permission)).toBeChecked()
  await first.getByRole("checkbox", permission).uncheck()
  await expect(second.getByRole("checkbox", permission)).not.toBeChecked()
  await page.getByRole("button", { name: "Collapse all", exact: true }).click()
  await page.getByRole("button", { name: "Expand all", exact: true }).click()
  await expect(first.getByRole("checkbox", permission)).not.toBeChecked()
  await expect(second.getByRole("checkbox", permission)).not.toBeChecked()
  await expect(
    page
      .getByRole("region", { name: "Unknown source", exact: true })
      .getByText("unattributed", { exact: true }),
  ).toBeVisible()
})

test("unavailable or malformed local storage does not block expansion", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("sumire:tool-permissions:expanded:v1:42", "{invalid")
    Storage.prototype.setItem = () => {
      throw new Error("Storage disabled")
    }
  })
  const state = await setup(page)
  await navigate(page, "Tool permissions")
  const group = page.getByRole("button", { name: "MCP: fixture · 1 tool", exact: true })
  await expect(group).toHaveAttribute("aria-expanded", "false")
  await group.click()
  await expect(group).toHaveAttribute("aria-expanded", "true")
  await page.getByRole("button", { name: "Collapse all", exact: true }).click()
  await expect(group).toHaveAttribute("aria-expanded", "false")
  expect(state.writes).toEqual([])
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
  await expect(page.getByRole("heading", { name: "Tool connections", exact: true })).toBeVisible()
  expect(state.writes).toEqual([])
})
