import type { Inventory, McpObservation } from "@narumitw/sumire-contracts"
import { expect, type Page, test } from "@playwright/test"
import { inventory as baseline, basePolicy, sectionLabel } from "./admin-fixture.js"

function connection(
  name: string,
  observation?: McpObservation,
  tools: string[] = [],
): Inventory["mcp"][number] {
  return {
    name,
    observation,
    tools,
    connection: "connected",
    enabled: true,
    fields: ["command", "env"],
    env: { TOKEN: null },
    headers: {},
  }
}

async function setup(
  page: Page,
  servers: Inventory["mcp"],
  probe: "success" | "failure" | "lost" = "success",
) {
  const inventory = { ...structuredClone(baseline), mcp: servers }
  const saved = structuredClone(basePolicy)
  const writes: { path: string; data: unknown }[] = []
  let release: (() => void) | undefined
  await page.route("**/api/**", async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() !== "GET") writes.push({ path, data: request.postDataJSON() })
    if (path.endsWith("/discover")) {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      if (probe === "lost") return route.abort("failed")
      const server = servers[0]
      if (server) {
        server.observation =
          probe === "failure"
            ? { state: "failed", revision: 1, completedAt: 2000, reason: "listing" }
            : { state: "succeeded", revision: 1, completedAt: 2000 }
        server.tools = []
      }
      return route.fulfill({ json: {} })
    }
    if (path === "/api/mcp/fixture" && request.method() === "PUT")
      return route.fulfill({ json: {} })
    const data: Record<string, unknown> = {
      "/api/session": { actor: "42", csrf: "fixture" },
      "/api/settings": { revision: 1, applied: 1, epoch: 1, status: "applied", policy: saved },
      "/api/inventory": inventory,
      "/api/chats": [],
      "/api/imports": [],
      "/api/audit": [],
      "/api/runtime-config": {
        revision: 1,
        applied: 1,
        status: "applied",
        secretStatus: "ready",
        entries: [],
      },
    }
    return route.fulfill({ json: data[path] ?? [] })
  })
  await page.goto("/")
  await page.getByRole("link", { name: sectionLabel("MCP connections"), exact: true }).click()
  await expect(page.getByRole("heading", { name: "Saved connections", exact: true })).toBeVisible()
  return {
    saved,
    writes,
    release: async () => {
      await expect.poll(() => Boolean(release)).toBe(true)
      release?.()
    },
  }
}

test("MCP rows distinguish unknown, untested, checking, successful zero, published names, and failure", async ({
  page,
}) => {
  const state = await setup(page, [
    connection("legacy-empty"),
    connection("legacy-names", undefined, ["unverified-name"]),
    connection("untested", { state: "untested" }),
    connection("checking", { state: "checking", revision: 1, startedAt: 1000 }),
    connection("zero", { state: "succeeded", revision: 1, completedAt: 2000 }),
    connection("published", { state: "succeeded", revision: 1, completedAt: 2000 }, [
      "mcp__published__read",
    ]),
    connection("failed", { state: "failed", revision: 1, completedAt: 2000, reason: "transport" }),
    connection("stale", { state: "succeeded", revision: 0, completedAt: 1000 }),
  ])
  for (const name of ["legacy-empty", "legacy-names", "failed", "checking", "untested", "stale"]) {
    await expect(
      page.getByRole("region", { name: `${name} connection`, exact: true }),
    ).toContainText("Published tool names: Unknown")
  }
  await expect(
    page.getByRole("region", { name: "legacy-empty connection", exact: true }),
  ).toContainText("Connection test: Unknown")
  await expect(
    page.getByRole("region", { name: "untested connection", exact: true }),
  ).toContainText("Connection test: Not tested")
  await expect(
    page.getByRole("region", { name: "checking connection", exact: true }),
  ).toContainText("Connection test: Checking")
  await expect(page.getByRole("region", { name: "failed connection", exact: true })).toContainText(
    "Connection test: Failed",
  )
  const zero = page.getByRole("region", { name: "zero connection", exact: true })
  await expect(zero).toContainText("0 published tool names")
  await expect(
    zero.getByRole("button", { name: "Test and discover zero", exact: true }),
  ).toHaveText("Test & discover")
  await expect(
    zero.getByRole("button", { name: "Edit fields for zero", exact: true }),
  ).toContainText("Edit")
  await zero.locator("summary", { hasText: "Connection and permission details" }).click()
  await expect(zero).toContainText("Configuration revision 1")
  await expect(zero.locator("time")).toHaveAttribute("datetime", "1970-01-01T00:00:02.000Z")
  await zero.locator("summary", { hasText: "Published tool names" }).click()
  await expect(zero.getByText("No published tool names.", { exact: true })).toBeVisible()
  await expect(
    page.getByRole("region", { name: "published connection", exact: true }),
  ).toContainText("1 published tool name")
  expect(state.writes).toEqual([])
})

for (const outcome of ["success", "failure", "lost"] as const) {
  test(`explicit MCP test shows checking then ${outcome} without granting permission`, async ({
    page,
  }) => {
    const state = await setup(
      page,
      [connection("fixture", { state: "succeeded", revision: 1, completedAt: 1000 }, ["old-name"])],
      outcome,
    )
    const row = page.getByRole("region", { name: "fixture connection", exact: true })
    const before = structuredClone(state.saved)
    await row.getByRole("button", { name: "Test and discover fixture", exact: true }).click()
    await expect(row).toContainText("Connection test: Checking")
    await expect(row).toContainText("Published tool names: Unknown")
    await state.release()
    await expect(row).toContainText(
      `Connection test: ${outcome === "success" ? "Succeeded" : outcome === "failure" ? "Failed" : "Unknown"}`,
    )
    if (outcome !== "success") await expect(row).toContainText("Published tool names: Unknown")
    expect(state.writes.map(({ path }) => path)).toEqual(["/api/mcp/fixture/discover"])
    expect(state.saved).toEqual(before)
    expect(state.saved.servers).toEqual([])
    expect(state.saved.tools).not.toContain("old-name")
    expect(state.saved.defaults.tools).not.toContain("old-name")
  })
}

test("MCP existing edit sends only a masked patch and no permission write", async ({ page }) => {
  const state = await setup(page, [connection("fixture", { state: "untested" })])
  await page.getByRole("button", { name: "Edit fields for fixture", exact: true }).click()
  await page
    .locator("summary")
    .filter({ hasText: /^Advanced server configuration JSON$/ })
    .click()
  await expect(
    page.getByRole("textbox", { name: "Server configuration JSON", exact: true }),
  ).toHaveValue("{}")
  await page
    .getByRole("textbox", { name: "Server configuration JSON", exact: true })
    .fill('{"description":"updated"}')
  await page.getByRole("button", { name: "Save connection", exact: true }).click()
  await expect.poll(() => state.writes.length).toBe(1)
  expect(state.writes).toEqual([
    { path: "/api/mcp/fixture", data: { revision: 1, config: { description: "updated" } } },
  ])
  expect(state.saved.servers).toEqual([])
  expect(state.saved.tools).not.toContain("mcp__fixture__read")
})
