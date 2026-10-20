import { expect, type Page, test } from "@playwright/test"

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
// Keep presentation checks on the same inventory and policy as usability.spec.ts.
// Every API request is intercepted; these tests cannot change a running service.
async function fixture(page: Page, audit: Record<string, unknown>[] = [], globalAudit = audit) {
  const requests: string[] = []
  let auditReads = 0
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url())
    requests.push(`${route.request().method()} ${url.pathname}`)
    expect(route.request().method()).toBe("GET")
    const data: Record<string, unknown> = {
      "/api/session": { csrf: "fixture", actor: "42" },
      "/api/settings": { revision: 1, applied: 1, status: "applied", policy: basePolicy },
      "/api/inventory": inventory,
      "/api/imports": [],
      "/api/audit": url.pathname === "/api/audit" && auditReads++ > 0 ? globalAudit : audit,
      "/api/chats": [
        { id: 42, name: "Fixture chat", type: "private" },
        { id: -100, name: "", type: "supergroup" },
        { id: -101, name: "", type: "channel" },
      ],
    }
    await route.fulfill({ json: data[url.pathname] ?? {} })
  })
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "Chats", exact: true })).toBeVisible()
  return requests
}

const sections = [
  "Chats",
  "Durable",
  "Access",
  "Defaults",
  "Tool permissions",
  "MCP connections",
  "Model providers",
  "Audit",
]
async function navigate(page: Page, name: string) {
  const link = page
    .getByRole("navigation", { name: "Administration sections" })
    .getByRole("link", { name, exact: true })
  if (!(await link.isVisible())) await page.getByRole("button", { name: /^Sections ·/ }).click()
  await link.click()
}

for (const width of [1440, 390, 320]) {
  test(`visual evidence at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 })
    await fixture(page)
    for (const section of sections) {
      await navigate(page, section)
      await expect(page.getByRole("heading", { name: section, exact: true })).toBeVisible()
      await expect(page).toHaveTitle(`${section} · Sumire`)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      )
      await page.screenshot({
        path: testInfo.outputPath(`${section.replaceAll(" ", "-").toLowerCase()}.png`),
        fullPage: true,
        animations: "disabled",
      })
    }
  })
}

test("document chrome, navigation icons, and assets remain local", async ({ page }) => {
  const external: string[] = []
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== "http://127.0.0.1:17466") external.push(request.url())
  })
  await fixture(page)
  await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /Manage Sumire/)
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#f8f9fa")
  const iconHref = await page.locator('link[rel="icon"]').getAttribute("href")
  expect(iconHref).toBeTruthy()
  const favicon = await page.request.get(iconHref ?? "")
  expect(favicon.ok()).toBe(true)
  expect(await favicon.text()).toContain("<title>Sumire</title>")
  const icons = page.locator('nav[aria-label="Administration sections"] a svg')
  await expect(icons).toHaveCount(8)
  for (const icon of await icons.all()) await expect(icon).toHaveAttribute("aria-hidden", "true")
  for (const section of sections) {
    await navigate(page, section)
    await expect(page.locator("main select")).toHaveCount(0)
    await expect(page.locator("main a:not(.rt-Link):not(.rt-Button)")).toHaveCount(0)
    const solidPrimary = page.locator(
      'main .rt-Button.rt-variant-solid[data-accent-color="teal"]:visible:not(:disabled)',
    )
    expect(await solidPrimary.count()).toBeLessThanOrEqual(1)
    const secondary = page.locator(
      'main .rt-Button:not(.rt-variant-solid):not([data-accent-color="red"]):visible',
    )
    for (const button of await secondary.all())
      await expect(button).toHaveAttribute("data-accent-color", "gray")
  }
  expect(external).toEqual([])
})

test("reduced motion disables transitions and animation without removing state labels", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await fixture(page)
  for (const section of sections) {
    await navigate(page, section)
    const motion = await page.locator(".radix-themes *:visible").evaluateAll((elements) =>
      elements
        .filter((element) => {
          const style = getComputedStyle(element)
          return (
            style.transitionDuration
              .split(",")
              .some((duration) => Number.parseFloat(duration) !== 0) ||
            style.animationName !== "none"
          )
        })
        .map((element) => element.className),
    )
    expect(motion, section).toEqual([])
  }
  await navigate(page, "Access")
  await expect(page.locator('[data-status="approved"]').first()).toContainText(
    /Approved|Saved revision applied/,
  )
  await page.getByRole("button", { name: "Revoke access for ID 42", exact: true }).click()
  await expect(page.locator('[data-status="pending"]').first()).toContainText(
    "pending policy change",
  )
  await page.emulateMedia({ forcedColors: "active" })
  await expect(page.getByText("Pending revocation", { exact: true })).toBeVisible()
})

test("ambiguous MCP results stay unknown in chat configuration", async ({ page }) => {
  await fixture(page)
  await page.route("**/api/settings", (route) =>
    route.fulfill({
      json: {
        revision: 1,
        applied: 1,
        status: "applied",
        policy: {
          ...basePolicy,
          servers: ["fixture"],
          defaults: { ...basePolicy.defaults, servers: ["fixture"] },
        },
      },
    }),
  )
  await page.route("**/api/inventory", (route) =>
    route.fulfill({
      json: {
        ...inventory,
        mcp: inventory.mcp.map((server) => ({
          ...server,
          connection: "no visible tools or unavailable",
        })),
      },
    }),
  )
  await page.reload()
  await page.getByRole("list", { name: "Chats on this page" }).getByRole("button").first().click()
  await page.getByRole("tab", { name: "Model & Tools", exact: true }).click()
  const result = page
    .locator(".chat-detail .status-badge")
    .filter({ hasText: "no visible tools or unavailable" })
  await expect(result).toHaveAttribute("data-status", "unknown")
})

for (const width of [1440, 320]) {
  test(`chat metadata reflows and copy feedback keeps its layout at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 })
    await fixture(page)
    await page.getByRole("list", { name: "Chats on this page" }).getByRole("button").first().click()
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async () => {} },
      })
    })
    const tabs = page.locator('.chat-detail [role="tablist"]')
    const before = await tabs.boundingBox()
    await page.getByRole("button", { name: "Copy chat ID", exact: true }).click()
    await expect(page.locator(".chat-detail .copy-confirmation")).toContainText("Chat ID copied.")
    const after = await tabs.boundingBox()
    expect(after?.y).toBe(before?.y)
    const lists = page.locator(".chat-detail .rt-DataListRoot:visible")
    expect(await lists.count()).toBeGreaterThan(0)
    for (const list of await lists.all()) {
      const label = await list.locator(".rt-DataListLabel").first().boundingBox()
      const value = await list.locator(".rt-DataListValue").first().boundingBox()
      if (!label || !value) throw new Error("Missing definition pair")
      if (width === 320) {
        expect(value.x).toBe(label.x)
        expect(value.y).toBeGreaterThan(label.y)
      } else {
        expect(value.x).toBeGreaterThan(label.x)
      }
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}

for (const loading of [
  { path: "session", label: "Loading administrator session…" },
  { path: "settings", label: "Loading settings…" },
]) {
  test(`${loading.path} loading has named progress and skeletons`, async ({ page }) => {
    await fixture(page)
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route(`**/api/${loading.path}`, async (route) => {
      await gate
      await route.fallback()
    })
    try {
      await page.reload({ waitUntil: "domcontentloaded" })
      const status = page.getByRole("status", { name: loading.label, exact: true })
      await expect(status).toBeVisible()
      await expect(status.locator(".rt-Spinner")).toHaveCount(1)
      await expect(status.locator(".rt-Skeleton")).toHaveCount(2)
    } finally {
      release()
    }
    await expect(page.getByRole("heading", { name: "Chats", exact: true })).toBeVisible()
  })
}
