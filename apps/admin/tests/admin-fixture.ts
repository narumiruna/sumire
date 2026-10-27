import { expect, type Page } from "@playwright/test"

export const basePolicy = {
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
export const inventory = {
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
export async function adminFixture(
  page: Page,
  audit: Record<string, unknown>[] = [],
  globalAudit = audit,
) {
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

export const sections = [
  "Chats",
  "Durable",
  "Access",
  "Defaults",
  "Tool permissions",
  "Skills",
  "MCP connections",
  "Model providers",
  "Audit",
]
export function sectionLabel(name: string): string {
  const labels: Record<string, string> = {
    Access: "Chat access",
    Defaults: "Shared defaults",
    Durable: "Conversation records",
    "MCP connections": "MCP Servers",
    "Model Providers": "Model providers",
  }
  return labels[name] ?? name
}

export async function openDisclosure(page: Page, label: string) {
  const summary = page.getByText(label, { exact: true }).and(page.locator("summary"))
  if ((await summary.locator("..").getAttribute("open")) === null) await summary.click()
}

export async function openGlobalLimits(page: Page) {
  const button = page.getByRole("button", { name: "Edit global limits", exact: true })
  if ((await button.getAttribute("aria-pressed")) !== "true") await button.click()
}

export async function closeConnectionEditor(page: Page) {
  const close = page.getByRole("button", { name: "Close connection editor", exact: true })
  if (await close.isVisible()) await close.click()
}

export async function openConnectionEditor(page: Page, existing = false) {
  if (!(await page.getByLabel("MCP server name", { exact: true }).isVisible())) {
    const resume = page.getByRole("button", { name: "Resume connection draft", exact: true })
    if (await resume.isVisible()) await resume.click()
    else if (existing)
      await page
        .getByRole("button", { name: /^Edit fields for / })
        .first()
        .click()
    else await page.getByRole("button", { name: "Add connection", exact: true }).click()
  }
  await openDisclosure(page, "Advanced connection fields")
  await openDisclosure(page, "Review field changes")
}

export async function openChatConfiguration(page: Page) {
  await page.getByRole("tab", { name: "Model & Tools", exact: true }).click()
  for (const summary of await page
    .locator(
      ".chat-view:not([hidden]) .policy-options > summary, .chat-view:not([hidden]) .configuration-summary > summary",
    )
    .all()) {
    if ((await summary.locator("..").getAttribute("open")) === null) await summary.click()
  }
}

export async function openDirectoryFilters(page: Page) {
  const summary = page.getByText("Filters and search scope", { exact: true })
  if ((await summary.locator("..").getAttribute("open")) === null) await summary.click()
}

export async function navigate(page: Page, name: string) {
  await expect(
    page.getByRole("complementary", { name: "Administration navigation", exact: true }),
  ).toBeVisible()
  const link = page
    .getByRole("navigation", { name: "Administration sections" })
    .getByRole("link", { name: sectionLabel(name), exact: true })
  const menu = page.getByRole("button", { name: /^Sections:/ })
  if (!(await link.isVisible()) && (await menu.isVisible())) await menu.click()
  await link.click()
}

export async function reviewPolicyRecovery(page: Page) {
  await page.getByRole("button", { name: "Load latest and review draft", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Review recovered settings draft", exact: true })
  await dialog.getByRole("button", { name: "Use recovered draft", exact: true }).click()
  await expect(
    page.getByRole("alertdialog", { name: "Save settings changes?", exact: true }),
  ).toBeVisible()
}
