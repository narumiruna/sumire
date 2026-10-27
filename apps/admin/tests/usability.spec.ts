import { expect, type Page, test } from "@playwright/test"
import {
  closeConnectionEditor,
  openConnectionEditor,
  openDirectoryFilters,
  openDisclosure,
  openGlobalLimits,
  sectionLabel,
} from "./admin-fixture.js"
import { contrast } from "./contrast.js"

const basePolicy = {
  tools: ["read_url_content"],
  servers: [],
  models: ["fixture/test"],
  providers: [],
  defaults: {
    tools: ["read_url_content"],
    servers: [],
    models: ["fixture/test"],
    model: "fixture/test",
    thinking: "off",
  },
  privateUsers: [42],
  groups: [-100, -101],
  chats: {},
}
const inventory = {
  tools: ["read_url_content", "bash"],
  builtInTools: ["read_url_content", "bash"],
  providers: [
    {
      id: "fixture",
      name: "Fixture",
      configured: false,
      apiKey: true,
      oauth: false,
      models: [
        { id: "test", name: "Test", thinking: ["off"], reasoning: false, image: false },
        { id: "other", name: "Other", thinking: ["off"], reasoning: false, image: false },
      ],
    },
  ],
  mcp: [
    {
      name: "fixture",
      fields: ["command", "args", "env"],
      env: { OLD: null },
      headers: {},
      tools: [],
      connection: "not tested",
    },
  ],
}
async function fixture(page: Page) {
  let policy = structuredClone(basePolicy)
  let revision = 1
  let status = "applied"
  let conflict = false
  let expire = false
  const writes: { path: string; body: unknown }[] = []
  const auditQueries: URLSearchParams[] = []
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    const method = route.request().method()
    if (expire)
      return route.fulfill({ status: 401, json: { error: "Administrator session expired" } })
    if (method !== "GET") {
      writes.push({ path, body: route.request().postDataJSON() })
      if (conflict)
        return route.fulfill({ status: 409, json: { error: "Settings changed; reload" } })
    }
    if (path === "/api/settings" && method === "PUT") {
      policy = route.request().postDataJSON().policy
      revision++
    }
    if (path === "/api/apply") status = "applied"
    if (path === "/api/audit") {
      auditQueries.push(url.searchParams)
      const filtered = url.searchParams.get("actor") === "system"
      return route.fulfill({
        json: Array.from(
          { length: url.searchParams.get("offset") === "100" ? 1 : 100 },
          (_, i) => ({
            id: 200 - i,
            time: 1,
            actor: filtered ? "system" : "42",
            operation: "settings.apply",
            revision: i,
            outcome: "failed",
            target: "settings",
          }),
        ),
      })
    }
    const data: Record<string, unknown> = {
      "/api/session": { csrf: "fixture", actor: "42" },
      "/api/settings": { revision, applied: status === "applied" ? revision : 0, status, policy },
      "/api/inventory": inventory,
      "/api/imports": [],
      "/api/chats": [
        { id: 42, name: "Fixture chat", type: "private" },
        { id: -100, name: "", type: "supergroup" },
        { id: -101, name: "", type: "channel" },
      ],
    }
    await route.fulfill({ json: data[path] ?? {} })
  })
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "Chats", exact: true })).toBeVisible()
  return {
    writes,
    auditQueries,
    conflict: () => {
      conflict = true
    },
    fail: () => {
      status = "failed"
    },
    pending: () => {
      status = "pending"
    },
    expire: () => {
      expire = true
    },
  }
}
async function navigate(page: Page, name: string) {
  const link = page.getByRole("link", { name: sectionLabel(name), exact: true })
  const menu = page.getByRole("button", { name: /Sections ·/ })
  if (!(await link.isVisible()) && (await menu.isVisible())) await menu.click()
  await link.click()
  if (name === "Tool permissions") await openGlobalLimits(page)
  if (name === "MCP connections") await openConnectionEditor(page)
  if (name === "Audit") await openDisclosure(page, "Filters")
  if (name === "Defaults") await openDisclosure(page, "Advanced actions")
  if (name === "Tool permissions") {
    await openDisclosure(page, "Approve an exact tool name")
    await page.getByRole("button", { name: "Expand all", exact: true }).click()
  }
}
async function stagePolicy(page: Page) {
  await navigate(page, "Access")
  await page.getByRole("button", { name: "Revoke access for ID 42", exact: true }).click()
}
async function stageMcp(page: Page) {
  await navigate(page, "MCP connections")
  const blocked = await page
    .getByRole("button", { name: "Add connection", exact: true, includeHidden: true })
    .isDisabled()
  if (!blocked) {
    await closeConnectionEditor(page)
    await page.getByRole("button", { name: "Edit fields for fixture", exact: true }).click()
  } else await page.getByRole("textbox", { name: "MCP server name", exact: true }).fill("fixture")
  await page.getByRole("checkbox", { name: "Edit MCP description", exact: true }).check()
  await page
    .getByRole("textbox", { name: "MCP description replacement" })
    .fill("retained MCP draft")
}
async function stageProvider(page: Page) {
  await navigate(page, "Model providers")
  await page.getByRole("button", { name: /^Model: / }).click()
  await page.getByRole("option", { name: /Other/ }).click()
}

test("persistent scope status follows clean, single-scope, and mixed drafts through all sections", async ({
  page,
}) => {
  await fixture(page)
  const bar = page.getByRole("region", { name: "Save status and pending changes" })
  const tour = async (attention = true) => {
    for (const section of [
      "Chats",
      "Durable",
      "Access",
      "Defaults",
      "Tool permissions",
      "MCP connections",
      "Model providers",
      "Audit",
    ]) {
      await navigate(page, section)
      if (section === "Durable" && !attention) {
        await expect(bar).toBeHidden()
        continue
      }
      await expect(bar).toBeVisible()
      await expect(bar).toHaveAttribute("data-compact", String(!attention))
      if (!attention) {
        await expect(bar).toContainText("Settings saved and applied.")
        await expect(bar.getByRole("button")).toHaveCount(0)
        await expect(bar.getByText("How saving works", { exact: true })).toHaveCount(0)
        await expect(bar.getByText("Revision details", { exact: true })).toBeVisible()
      }
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      const changes = page.getByRole("region", { name: "Pending changes", exact: true })
      if (attention) {
        const box = await changes.boundingBox()
        expect(box?.y).toBeGreaterThanOrEqual(0)
        expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(900)
        expect(await changes.evaluate((element) => getComputedStyle(element).position)).toBe(
          "fixed",
        )
      } else await expect(changes).toHaveCount(0)
    }
  }
  await tour(false)
  await stageProvider(page)
  await expect(bar).toContainText("Provider: Unsaved")
  await tour()
  await navigate(page, "Model providers")
  await page.getByRole("button", { name: "Use saved selection" }).click()
  await stageMcp(page)
  await tour()
  await stagePolicy(page)
  await navigate(page, "MCP connections")
  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "Discard MCP draft", exact: true }).click()
  await tour()
  await stageMcp(page)
  await stageProvider(page)
  await tour()
  await expect(bar).toContainText("MCP: Unsaved")
  await expect(bar).toContainText("1 unsaved change")
  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "Discard settings changes", exact: true }).click()
  await expect(bar).not.toContainText("Policy: No changes")
  await expect(bar).toContainText("MCP: Unsaved")
  await expect(bar).toContainText("Provider: Unsaved")
})

test("Durable retains unfinished editor input and shows save chrome until it is cleared", async ({
  page,
}) => {
  await fixture(page)
  await navigate(page, "Access")
  const input = page.getByLabel("Telegram ID to approve", { exact: true })
  await input.fill("1234")
  await navigate(page, "Durable")
  const bar = page.getByRole("region", { name: "Save status and pending changes" })
  await expect(bar).toBeVisible()
  await expect(bar).toContainText("Continue editing: Chat access")
  await navigate(page, "Access")
  await expect(input).toHaveValue("1234")
  await input.clear()
  await navigate(page, "Durable")
  await expect(bar).toBeHidden()
})

test("Durable keeps pending or failed application and busy actions visible, then hides clean chrome", async ({
  page,
}) => {
  const state = await fixture(page)
  state.pending()
  await page.getByRole("button", { name: "Reload", exact: true }).click()
  await navigate(page, "Durable")
  await expect(page.getByRole("region", { name: "Save status and pending changes" })).toContainText(
    "Saved changes are waiting to apply.",
  )
  state.fail()
  await navigate(page, "Defaults")
  await page.getByRole("button", { name: "Reload", exact: true }).click()
  await navigate(page, "Durable")
  const bar = page.getByRole("region", { name: "Save status and pending changes" })
  await expect(bar).toContainText("Saved, but application failed.")
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route("**/api/apply", async (route) => {
    await gate
    await route.fallback()
  })
  try {
    await bar.getByRole("button", { name: "Retry application", exact: true }).click()
    await expect(bar).toContainText("Operation in progress…")
    await expect(bar.getByRole("button", { name: "Retry application", exact: true })).toBeDisabled()
  } finally {
    release()
  }
  await expect(bar).toBeHidden()
  await expect(
    page.getByRole("heading", { name: "Conversation records", exact: true }),
  ).toBeVisible()
})

test("guided and advanced MCP edits share a draft and a redacted transport-aware preview", async ({
  page,
}) => {
  const state = await fixture(page)
  await stageMcp(page)
  const json = page.getByLabel("Server configuration JSON")
  await expect(json).toHaveValue(/retained MCP draft/)
  const preview = page.getByRole("region", { name: "MCP change preview" })
  await expect(preview).toContainText("Preserved: command")
  await expect(preview).toContainText("Preserved: env.OLD")
  await expect(preview).not.toContainText("retained MCP draft")
  await page.getByText("Advanced server configuration JSON", { exact: true }).click()
  await json.fill('{"toolExposure":{"fixture_tool":"hidden"},"description":"advanced"}')
  await expect(page.getByRole("textbox", { name: "MCP description replacement" })).toHaveValue(
    "advanced",
  )
  await page.getByRole("textbox", { name: "MCP description replacement" }).fill("guided")
  await expect(json).toHaveValue(/fixture_tool/)
  await json.fill('{"unknown":true}')
  await expect(page.getByRole("button", { name: "Save connection" })).toBeDisabled()
  await expect(json).toHaveValue('{"unknown":true}')
  await json.fill('{"url":"https://example.test/opaque","headers":{}}')
  await expect(preview).toContainText("Removed by transport selection: command")
  await expect(preview).toContainText("Removed by transport selection: env")
  await expect(preview).not.toContainText("opaque")
  await page.getByRole("button", { name: "Save connection" }).click()
  expect(state.writes.at(-1)).toMatchObject({
    path: "/api/mcp/fixture",
    body: { revision: 1, config: { url: "https://example.test/opaque", headers: {} } },
  })
})

test("audit filters query all records without clearing cross-section policy drafts", async ({
  page,
}) => {
  const state = await fixture(page)
  await stagePolicy(page)
  await navigate(page, "Audit")
  await page.getByRole("textbox", { name: "Actor (exact)", exact: true }).fill("system")
  await page.getByRole("combobox", { name: "Operation type", exact: true }).click()
  await page.getByRole("option", { name: "Settings application", exact: true }).click()
  await page.getByRole("combobox", { name: "Result", exact: true }).click()
  await page.getByRole("option", { name: "Failed", exact: true }).click()
  await page.getByLabel("From date (UTC)", { exact: true }).fill("2026-10-16")
  await page.getByLabel("Through date (UTC)", { exact: true }).fill("2026-10-16")
  await page.getByRole("button", { name: "Apply audit filters" }).click()
  await expect(page.getByRole("list", { name: "Configuration activity" })).toContainText(
    "Actorsystem",
  )
  expect(state.auditQueries.at(-1)?.get("actor")).toBe("system")
  expect(state.auditQueries.at(-1)?.get("from")).toBe(String(Date.parse("2026-10-16T00:00:00Z")))
  await page.getByRole("button", { name: "Older", exact: true }).click()
  await expect(page.getByText("Showing records 101–101.", { exact: false })).toBeVisible()
  expect(state.auditQueries.at(-1)?.get("offset")).toBe("100")
  expect(state.auditQueries.at(-1)?.get("outcome")).toBe("failed")
  await expect(page.getByRole("region", { name: "Save status and pending changes" })).toContainText(
    "1 unsaved change",
  )
})

test("local provider checks distinguish failure and configuration from remote verification", async ({
  page,
}) => {
  await fixture(page)
  await navigate(page, "Model providers")
  await openDisclosure(page, "Credential checks")
  await page.route("**/api/providers/fixture/test", (route) =>
    route.fulfill({ status: 500, json: { error: "Fixture credential check failed" } }),
  )
  await page.getByRole("button", { name: "Check authentication", exact: true }).click()
  await expect(
    page.getByText("Local credential check: Check failed", { exact: true }),
  ).toBeVisible()
  await expect(page.getByText("Remote verification: Not checked.", { exact: false })).toBeVisible()
  await page.route("**/api/providers/fixture/test", (route) =>
    route.fulfill({ json: { configured: true } }),
  )
  await page.getByRole("button", { name: "Check authentication", exact: true }).click()
  await expect(
    page.getByText("Local credential check: Configured locally", { exact: true }),
  ).toBeVisible()
  await expect(page.getByText("Remote verification: Not checked.", { exact: false })).toBeVisible()
})

test("failed and stale audit queries cannot replace the current result or discard drafts", async ({
  page,
}) => {
  await fixture(page)
  await stagePolicy(page)
  await navigate(page, "Audit")
  await page.route("**/api/audit?*", async (route) => {
    if (new URL(route.request().url()).searchParams.get("actor") === "broken")
      return route.fulfill({ status: 500, json: { error: "Fixture audit failure" } })
    await route.fallback()
  })
  await page.getByLabel("Actor (exact)", { exact: true }).fill("broken")
  await page.getByRole("button", { name: "Apply audit filters" }).click()
  await expect(page.getByText("Could not load audit records. Retry the query.")).toBeVisible()
  await expect(page.getByRole("list", { name: "Configuration activity" })).toHaveCount(0)
  await page.getByRole("button", { name: "Clear audit filters" }).click()
  await expect(page.getByRole("list", { name: "Configuration activity" })).toContainText("Actor42")
  await expect(page.getByRole("alert")).toHaveCount(0)
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let started = () => {}
  const waiting = new Promise<void>((resolve) => {
    started = resolve
  })
  await page.route("**/api/audit?*", async (route) => {
    if (new URL(route.request().url()).searchParams.get("actor") !== "slow") return route.fallback()
    started()
    await gate
    return route.fulfill({
      json: [
        {
          id: 999,
          actor: "STALE",
          operation: "settings.apply",
          revision: 1,
          outcome: "failed",
          target: "settings",
          time: 1,
        },
      ],
    })
  })
  await page.getByLabel("Actor (exact)", { exact: true }).fill("slow")
  await page.getByRole("button", { name: "Apply audit filters" }).click()
  await waiting
  await page.getByRole("button", { name: "Clear audit filters" }).click()
  await expect(page.getByRole("list", { name: "Configuration activity" })).toContainText("Actor42")
  const stale = page.waitForResponse(
    (response) => new URL(response.url()).searchParams.get("actor") === "slow",
  )
  release()
  await stale
  await expect(page.getByRole("list", { name: "Configuration activity" })).not.toContainText(
    "STALE",
  )
  await expect(page.locator("#save-status")).toContainText("1 unsaved change")
})

test("audit retry clears the local error and HTTP 401 still clears the session", async ({
  page,
}) => {
  const state = await fixture(page)
  await navigate(page, "Audit")
  let failed = false
  await page.route("**/api/audit?*", async (route) => {
    if (!failed) {
      failed = true
      return route.fulfill({ status: 500, json: { error: "Fixture audit failure" } })
    }
    return route.fallback()
  })
  await page.getByRole("button", { name: "Apply audit filters" }).click()
  await expect(page.getByText("Could not load audit records. Retry the query.")).toBeVisible()
  await page.getByRole("button", { name: "Retry audit" }).click()
  await expect(page.getByRole("list", { name: "Configuration activity" })).toContainText("Actor42")
  await expect(page.getByRole("alert")).toHaveCount(0)
  state.expire()
  await page.getByRole("button", { name: "Apply audit filters" }).click()
  await expect(page.getByRole("button", { name: "Sign in with passkey" })).toBeVisible()
  await expect(page.locator("#save-status")).toHaveCount(0)
})

for (const change of ["url", "protocol"] as const) {
  test(`model discovery does not retain verification or IDs for a changed ${change}`, async ({
    page,
  }) => {
    await fixture(page)
    const custom = {
      id: "fixture",
      enabled: true,
      baseUrl: "https://models.example.test/v1",
      api: "openai-completions",
      models: [
        {
          id: "test",
          name: "Test",
          reasoning: false,
          image: false,
          contextWindow: 128000,
          maxTokens: 8192,
        },
      ],
    }
    await page.route("**/api/settings", (route) =>
      route.fulfill({
        json: {
          revision: 1,
          applied: 1,
          status: "applied",
          policy: { ...basePolicy, providers: [custom] },
        },
      }),
    )
    await page.route("**/api/providers/fixture/discover", (route) =>
      route.fulfill({ json: ["checked-endpoint-model"] }),
    )
    await page.reload()
    await navigate(page, "Model providers")
    await page.getByText("Model discovery", { exact: true }).click()
    const check = page.getByText("Model-list check:", { exact: false })
    await page.getByRole("button", { name: "Discover custom models" }).click()
    await expect(check).toContainText("Verified")
    await expect(page.getByText("checked-endpoint-model", { exact: true })).toBeVisible()
    await page.getByText("Custom endpoint", { exact: true }).click()
    await page.getByRole("button", { name: "Edit configuration fixture", exact: true }).click()
    if (change === "url")
      await page
        .getByLabel("API base URL", { exact: true })
        .fill("https://replacement.example.test/v1")
    else {
      await page.getByText("Advanced protocol", { exact: true }).click()
      await page.getByRole("combobox", { name: "API", exact: true }).click()
      await page.getByRole("option", { name: "openai-responses", exact: true }).click()
    }
    await page.getByRole("button", { name: "Set provider configuration", exact: true }).click()
    await expect(page.getByRole("button", { name: "Discover custom models" })).toBeDisabled()
    await expect(check).toHaveText("Model-list check: Not checked")
    await expect(page.getByText("checked-endpoint-model", { exact: true })).toHaveCount(0)
    page.once("dialog", (dialog) => dialog.accept())
    await page.getByRole("button", { name: "Discard settings changes", exact: true }).click()
    await expect(check).toContainText("Verified")
    await expect(page.getByText("checked-endpoint-model", { exact: true })).toBeVisible()
    await page.route("**/api/providers/fixture/discover", (route) =>
      route.fulfill({ status: 500, json: { error: "Discovery failed" } }),
    )
    await page.getByRole("button", { name: "Discover custom models" }).click()
    await expect(check).toHaveText("Model-list check: Check failed")
    await expect(page.getByText("checked-endpoint-model", { exact: true })).toHaveCount(0)
  })
}

test("audit groups show failed retries without hiding the underlying records", async ({ page }) => {
  await fixture(page)
  await page.route("**/api/audit?*", (route) =>
    route.fulfill({
      json: [
        {
          id: 3,
          time: 1,
          actor: "system",
          operation: "settings.apply",
          revision: 2,
          outcome: "applied",
          target: "settings",
        },
        {
          id: 2,
          time: 1,
          actor: "system",
          operation: "settings.apply",
          revision: 2,
          outcome: "failed",
          target: "settings",
        },
        {
          id: 1,
          time: 1,
          actor: "42",
          operation: "settings.update",
          revision: 2,
          outcome: "saved",
          target: "settings",
        },
      ],
    }),
  )
  await page.reload()
  await navigate(page, "Audit")
  await expect(page.getByText("1 failed application.", { exact: false })).toBeVisible()
  await expect(
    page.getByText("Individual save and application records", { exact: true }),
  ).toBeVisible()
  await expect(page.getByText("Raw audit record", { exact: true })).toHaveCount(3)
  await expect(page.getByRole("list", { name: "Configuration activity" })).toContainText("failed")
})

test("measures normal, muted, disabled, pending, error, and control-boundary contrast", async ({
  page,
}, testInfo) => {
  const state = await fixture(page)
  const measurements: Record<string, Awaited<ReturnType<typeof contrast>>> = {}
  measurements.normal = await contrast(page.locator("#current-section-heading"))
  measurements.muted = await contrast(page.locator(".directory-options summary"))
  await navigate(page, "Defaults")
  measurements.disabled = await contrast(
    page.getByRole("button", { name: "Reset all chats to inherit defaults", exact: true }),
  )
  await navigate(page, "Tool permissions")
  measurements.warning = await contrast(
    page.locator(".rt-CalloutText").filter({ hasText: "Shell and file tools" }),
  )
  const checkboxBoundary = await contrast(
    page.getByRole("checkbox", { name: "Globally allow tool bash", exact: true }),
  )
  expect(checkboxBoundary.borderWidth).toBeGreaterThan(0)
  expect(checkboxBoundary.border).toBeGreaterThanOrEqual(3)
  await testInfo.attach("checkbox-boundary-contrast", {
    contentType: "application/json",
    body: JSON.stringify(checkboxBoundary),
  })
  await stagePolicy(page)
  measurements.pending = await contrast(
    page.locator("#save-status .rt-Badge").filter({ hasText: /unsaved changes?/ }),
  )
  state.conflict()
  await page.getByRole("button", { name: "Review and save changes", exact: true }).click()
  await page.getByRole("button", { name: "Save changes", exact: true }).click()
  const error = page.getByRole("alert")
  await expect(error).toBeVisible()
  measurements.error = await contrast(error.locator(".rt-CalloutText"))
  await navigate(page, "Chats")
  await openDirectoryFilters(page)
  measurements.control = await contrast(page.getByLabel("Chat type", { exact: true }))
  await testInfo.attach("contrast-ratios", {
    contentType: "application/json",
    body: JSON.stringify(measurements, null, 2),
  })
  for (const [name, measurement] of Object.entries(measurements))
    expect(measurement.text, name).toBeGreaterThanOrEqual(4.5)
  expect(measurements.control?.borderWidth).toBeGreaterThan(0)
  expect(measurements.control?.border).toBeGreaterThanOrEqual(3)
})

for (const mode of [
  { width: 1440, zoom: 1 },
  { width: 320, zoom: 1 },
  { width: 640, zoom: 2 },
]) {
  test(`names, reflow, and focus at ${mode.width}px with ${mode.zoom}x CSS zoom`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: mode.width, height: 900 })
    await fixture(page)
    await page.evaluate((zoom) => {
      document.documentElement.style.zoom = String(zoom)
    }, mode.zoom)
    for (const section of ["Defaults", "Model providers"]) {
      await navigate(page, section)
      const controls = page.locator(
        'main :is(button, input, select, textarea, [role="checkbox"], [role="combobox"]):visible',
      )
      for (let index = 0; index < (await controls.count()); index++)
        await expect(controls.nth(index)).toHaveAccessibleName(/\S/)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      )
      const initial = page.getByRole("heading", { name: sectionLabel(section), exact: true })
      await initial.focus()
      for (let index = 0; index < 8; index++) {
        await page.keyboard.press("Tab")
        const active = page.locator(":focus")
        if (!(await active.count())) {
          // Tab can leave the last document control for browser chrome; the next Tab returns.
          await page.keyboard.press("Tab")
          await expect(page.locator(":focus")).toBeVisible()
          break
        }
        await expect(active).toBeVisible()
        const focused = await active.boundingBox()
        const bar = await page.locator("#save-status").boundingBox()
        if (
          focused &&
          bar &&
          !(await active.evaluate((element) => Boolean(element.closest("#save-status"))))
        )
          expect(focused.y).toBeGreaterThanOrEqual(bar.y + bar.height)
        expect(await active.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe(
          "none",
        )
      }
    }
  })
}
