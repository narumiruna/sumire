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
  "MCP connections",
  "Model providers",
  "Audit",
]
export async function navigate(page: Page, name: string) {
  const link = page
    .getByRole("navigation", { name: "Administration sections" })
    .getByRole("link", { name, exact: true })
  if (!(await link.isVisible())) await page.getByRole("button", { name: /^Sections ·/ }).click()
  await link.click()
}
