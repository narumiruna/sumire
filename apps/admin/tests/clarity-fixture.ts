import { inherited } from "@narumitw/sumire-policy"
import { expect, type Page } from "@playwright/test"
import { remediationFixture } from "./remediation-fixture.js"

/** Synthetic stress data only; every API request stays intercepted. */
export async function clarityFixture(page: Page) {
  const state = await remediationFixture(page)
  const policy = state.policy()
  const builtin = Array.from({ length: 100 }, (_, i) => `builtin_${i}`)
  const remote = Array.from({ length: 100 }, (_, i) => `mcp__example__tool_${i}`)
  state.inventory.tools = [...builtin, "source_not_known"]
  state.inventory.builtInTools = builtin
  state.inventory.toolAvailability = {
    builtin_0: {
      available: false,
      reason: "Requires local credentials; remote access not checked.",
    },
  }
  state.inventory.mcp = [
    { name: "example", tools: remote, connection: "not tested", env: {}, headers: {} },
    {
      name: "second",
      tools: ["mcp__example__tool_0"],
      connection: "not tested",
      env: {},
      headers: {},
    },
  ]
  state.inventory.providers.push({
    id: "second",
    name: "Second",
    configured: false,
    apiKey: true,
    oauth: false,
    models: [
      {
        id: "model",
        name: "Second model",
        thinking: ["off", "high"],
        reasoning: true,
        image: false,
      },
    ],
  })
  policy.tools = [...builtin, ...remote, "source_not_known", "stored_missing"]
  policy.defaults.tools = [...policy.tools]
  policy.servers = ["example", "second"]
  policy.defaults.servers = [...policy.servers]
  policy.models = ["fixture/test", "fixture/other", "second/model"]
  policy.chats["43"] = {
    ...inherited,
    enabled: true,
    model: "second/model",
    models: ["second/model"],
  }
  policy.chats["44"] = { ...inherited, enabled: true, tools: [] }
  policy.privateUsers = Array.from({ length: 100 }, (_, i) => 42 + i)
  const chats = policy.privateUsers.map((id) => ({
    id,
    name: id < 44 ? "Duplicate name" : `Example chat ${id}`,
    type: "private",
  }))
  await page.route("**/api/chats?*", async (route) => {
    const params = new URL(route.request().url()).searchParams
    const query = params.get("q")?.toLowerCase()
    const selected = params.get("id")
    const filtered = chats.filter((chat) =>
      selected
        ? String(chat.id) === selected
        : !query || chat.name.toLowerCase().includes(query) || String(chat.id) === query,
    )
    const offset = Number(params.get("offset") ?? 0)
    await route.fulfill({ json: filtered.slice(offset, offset + 100) })
  })
  await page.reload()
  await expect(page.locator("#save-status")).toBeVisible()
  return { ...state, chats }
}
