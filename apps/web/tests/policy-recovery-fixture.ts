import { policySchema, validateReferences } from "@narumitw/sumire-policy"
import { expect, type Page } from "@playwright/test"
import type { Policy, Snapshot } from "../src/api.js"
import { inventory as baseInventory, basePolicy } from "./admin-fixture.js"

/** Synthetic state only. Every API request is intercepted, including writes. */
export async function policyRecoveryFixture(page: Page) {
  let policy = policySchema.parse({
    ...structuredClone(basePolicy),
    tools: ["read_url_content", "bash"],
    skills: ["url-guide"],
  })
  let revision = 1
  const writes: { revision: number; policy: Policy }[] = []
  const reads: string[] = []
  const state = {
    expired: false,
    saveFailure: 0,
    loseSaveResponse: false,
    malformedSaveResponse: false,
    status: "applied",
    lag: 0,
    failedReads: new Set<string>(),
    gates: new Map<string, Promise<void>>(),
  }
  const snapshot = (): Snapshot => ({
    revision,
    applied: revision - state.lag,
    status: state.status,
    policy,
    epoch: revision,
  })
  const inventory = {
    ...structuredClone(baseInventory),
    skills: [{ name: "url-guide", description: "Read public pages." }],
    providers: baseInventory.providers.map((provider) => ({
      ...provider,
      configured: true,
      models: provider.models.map((model) => ({ ...model, thinking: ["off", "low", "high"] })),
    })),
  }
  await page.route("**/api/**", async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    await state.gates.get(`${request.method()} ${path}`)
    if (state.expired) return route.fulfill({ status: 401, json: { error: "Session expired" } })
    if (request.method() === "GET") {
      reads.push(path)
      if (state.failedReads.has(path))
        return route.fulfill({ status: 500, json: { error: "Fixture read failed" } })
    }
    if (request.method() === "PUT" && path === "/api/settings") {
      const input = request.postDataJSON()
      writes.push(structuredClone(input))
      if (state.saveFailure)
        return route.fulfill({
          status: state.saveFailure,
          json: { error: "Fixture save rejected" },
        })
      if (input.revision !== revision)
        return route.fulfill({ status: 409, json: { error: "Fixture revision advanced" } })
      try {
        const next = policySchema.parse(input.policy)
        validateReferences(next)
        policy = next
        revision++
      } catch {
        return route.fulfill({ status: 400, json: { error: "Invalid references" } })
      }
      if (state.loseSaveResponse) {
        state.loseSaveResponse = false
        return route.abort("failed")
      }
      return route.fulfill({ json: state.malformedSaveResponse ? {} : snapshot() })
    }
    const data: Record<string, unknown> = {
      "/api/session": { csrf: "fixture", actor: "42" },
      "/api/settings": snapshot(),
      "/api/inventory": inventory,
      "/api/chats": [{ id: 42, name: "Fixture chat", type: "private" }],
      "/api/audit": [],
      "/api/imports": [],
    }
    return route.fulfill({ json: data[path] ?? {} })
  })
  await page.goto("/")
  await expect(page.locator('#save-status[data-compact="true"]')).toBeVisible()
  return {
    state,
    writes,
    reads,
    snapshot,
    advance(change: (policy: Policy) => void) {
      const next = structuredClone(policy)
      change(next)
      policy = policySchema.parse(next)
      validateReferences(policy)
      revision++
    },
  }
}
