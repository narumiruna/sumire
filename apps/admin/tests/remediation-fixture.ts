import { policySchema, validateReferences } from "@narumitw/sumire-policy"
import { expect, type Page } from "@playwright/test"
import type { Inventory, Policy } from "../src/api.js"
import { inventory as baseInventory, basePolicy } from "./admin-fixture.js"

export async function remediationFixture(page: Page) {
  let policy: Policy = {
    ...structuredClone(basePolicy),
    skills: ["url-guide"],
    defaults: { ...basePolicy.defaults, thinking: "off", skills: ["url-guide"] },
  }
  const inventory: Inventory = {
    ...structuredClone(baseInventory),
    skills: [{ name: "url-guide", description: "Read public pages." }],
    providers: baseInventory.providers.map((provider) => ({ ...provider, configured: true })),
  }
  let revision = 1
  let fail = false
  const writes: { path: string; body: unknown }[] = []
  const queries: URLSearchParams[] = []
  await page.route("**/api/**", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() !== "GET") {
      writes.push({ path: url.pathname, body: request.postDataJSON() })
      if (fail) return route.fulfill({ status: 409, json: { error: "Settings changed; reload" } })
      if (url.pathname === "/api/settings") {
        const next = policySchema.parse(request.postDataJSON().policy)
        try {
          validateReferences(next)
        } catch {
          return route.fulfill({ status: 400, json: { error: "Invalid references" } })
        }
        policy = next
        revision++
      }
    }
    if (url.pathname === "/api/audit") queries.push(url.searchParams)
    const responses: Record<string, unknown> = {
      "/api/session": { csrf: "fixture", actor: "42" },
      "/api/settings": { revision, applied: revision, status: "applied", policy },
      "/api/inventory": inventory,
      "/api/imports": [],
      "/api/chats": [{ id: 42, name: "Fixture chat", type: "private" }],
      "/api/audit": [
        {
          id: 1,
          time: 1,
          actor: "42",
          operation: "settings.update",
          revision: 1,
          outcome: "saved",
          target: "settings",
        },
      ],
    }
    await route.fulfill({ json: responses[url.pathname] ?? {} })
  })
  await page.goto("/")
  await expect(page.locator('#save-status[data-compact="true"]')).toBeVisible()
  return {
    writes,
    queries,
    policy: () => policy,
    fail: (value = true) => {
      fail = value
    },
    inventory,
  }
}
