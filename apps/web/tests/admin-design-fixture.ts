import { initialPolicy } from "@narumitw/sumire-policy"
import { expect, type Page } from "@playwright/test"
import type { Inventory } from "../src/api.js"
import { durableFixture } from "./durable-fixture.js"

/** All metadata is synthetic. No request can reach a production API. */
export async function adminDesignFixture(page: Page, historyMode: "reading" | "events" = "events") {
  const records = await durableFixture(page, undefined, { historyMode })
  const tools = ["read_url_content", "read", "bash", "write"]
  const policy = {
    ...initialPolicy(),
    tools,
    skills: ["public-url-guide", "review-notes"],
    servers: ["browser"],
    models: ["fixture/alpha", "review/beta"],
    privateUsers: [42],
    defaults: {
      model: "fixture/alpha",
      models: ["fixture/alpha"],
      thinking: "off",
      tools: ["read_url_content", "read"],
      skills: ["public-url-guide"],
      servers: ["browser"],
    },
  }
  const inventory: Inventory = {
    tools,
    builtInTools: tools,
    skills: [
      { name: "public-url-guide", description: "Read public pages and cite the source." },
      {
        name: "review-notes",
        description: "Write concise review notes without changing tool access.",
      },
    ],
    providers: [
      {
        id: "fixture",
        name: "示意供應商 Alpha",
        configured: true,
        apiKey: true,
        oauth: false,
        models: [
          {
            id: "alpha",
            name: "示意模型 Alpha",
            thinking: ["off", "low", "high"],
            reasoning: true,
            image: false,
          },
        ],
      },
      {
        id: "review",
        name: "示意供應商 Beta",
        configured: false,
        apiKey: true,
        oauth: false,
        models: [
          { id: "beta", name: "示意模型 Beta", thinking: ["off"], reasoning: false, image: false },
        ],
      },
    ],
    mcp: [
      {
        name: "browser",
        connection: "not tested",
        enabled: true,
        tools: [],
        fields: ["command", "args"],
        env: {},
        headers: {},
        observation: { state: "untested" },
      },
    ],
  }
  const methods: string[] = []
  await page.route("**/api/**", async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    methods.push(request.method())
    expect(request.method()).toBe("GET")
    if (path.endsWith("/durable")) return route.fallback()
    const responses: Record<string, unknown> = {
      "/api/session": { csrf: "fixture", actor: "示意管理員" },
      "/api/settings": { revision: 1, applied: 1, status: "applied", policy },
      "/api/inventory": inventory,
      "/api/chats": [{ id: 42, name: "設計驗收測試群", type: "private" }],
      "/api/runtime-config": {
        revision: 1,
        applied: 1,
        status: "applied",
        secretStatus: "ready",
        entries: [
          {
            name: "DEMO_SERVICE_TOKEN",
            kind: "secret",
            configured: true,
            revision: 1,
            updatedAt: 1790000000000,
          },
          {
            name: "DEMO_REGION",
            kind: "variable",
            value: "台灣",
            revision: 1,
            updatedAt: 1790000000000,
          },
        ],
      },
      "/api/github/connection": {
        revision: 1,
        applied: 1,
        status: "applied",
        secretStatus: "ready",
        mode: "none",
        reconnectRequired: false,
      },
      "/api/audit": [
        {
          id: 1,
          time: 1790000000000,
          actor: "示意管理員",
          operation: "settings.update",
          revision: 1,
          outcome: "saved",
          target: "settings",
        },
      ],
      "/api/imports": [],
    }
    await route.fulfill({ json: responses[path] ?? {} })
  })
  await page.goto("/?section=Chats")
  await expect(page.locator(".chat-card")).toBeVisible()
  return { methods, records, policy, inventory }
}
