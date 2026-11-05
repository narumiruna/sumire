import { initialPolicy } from "@narumitw/sumire-policy"
import { expect, type Page } from "@playwright/test"

/** Synthetic data only. All requests are intercepted, including mutations. */
export async function chatCardsFixture(page: Page, count = 3) {
  const policy = {
    ...initialPolicy(),
    tools: ["read_url_content"],
    defaults: {
      tools: ["read_url_content"],
      servers: [],
      skills: [],
      model: "fixture/test",
      models: ["fixture/test"],
      thinking: "off",
    },
    models: ["fixture/test", "review/test"],
    privateUsers: [] as number[],
    groups: [-100, -101],
    chats: {
      "-101": {
        enabled: true,
        model: "review/test",
        models: ["review/test"],
        tools: null,
        servers: null,
        skills: null,
        thinking: null,
      },
    },
  }
  const chats = Array.from({ length: count }, (_, index) => ({
    id: -100 - index,
    name: ["專案機器人群", "開發討論群", "測試群組"][index] ?? `測試群組 ${index + 1}`,
    type: "supergroup",
  }))
  let snapshot = { revision: 1, applied: 1, status: "applied", policy }
  const writes: { method: string; path: string; body: unknown }[] = []
  const reads: string[] = []
  await page.route("**/api/**", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() !== "GET") {
      const body = request.postDataJSON()
      writes.push({ method: request.method(), path: url.pathname, body })
      expect(request.method()).toBe("PUT")
      expect(url.pathname).toBe("/api/settings")
      snapshot = {
        revision: snapshot.revision + 1,
        applied: snapshot.revision + 1,
        status: "applied",
        policy: body.policy,
      }
      await route.fulfill({ json: snapshot })
      return
    }
    reads.push(url.pathname + url.search)
    if (url.pathname === "/api/chats") {
      const id = url.searchParams.get("id")
      const query = (url.searchParams.get("q") ?? "").toLowerCase()
      const offset = Number(url.searchParams.get("offset") ?? 0)
      await route.fulfill({
        json: id
          ? chats.filter((chat) => String(chat.id) === id)
          : chats
              .filter(
                (chat) => chat.name.toLowerCase().includes(query) || String(chat.id) === query,
              )
              .slice(offset, offset + 100),
      })
      return
    }
    const provider = (id: string, configured: boolean) => ({
      id,
      name: id === "fixture" ? "Demo provider" : "Review provider",
      configured,
      apiKey: true,
      oauth: false,
      models: [
        { id: "test", name: "GPT-6.1 Sol", thinking: ["off"], reasoning: false, image: false },
      ],
    })
    const responses: Record<string, unknown> = {
      "/api/session": { csrf: "test-only", actor: "示意管理員" },
      "/api/settings": snapshot,
      "/api/inventory": {
        tools: ["read_url_content"],
        builtInTools: ["read_url_content"],
        providers: [provider("fixture", true), provider("review", false)],
        mcp: [],
      },
      "/api/runtime-config": {
        revision: 1,
        applied: 1,
        status: "applied",
        secretStatus: "ready",
        entries: [],
      },
      "/api/audit": [],
      "/api/imports": [],
    }
    await route.fulfill({ json: responses[url.pathname] ?? {} })
  })
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "Chats", exact: true })).toBeVisible()
  await expect(page.locator(".chat-card")).toHaveCount(Math.min(count, 100))
  return { writes, reads, policy: () => snapshot.policy }
}
