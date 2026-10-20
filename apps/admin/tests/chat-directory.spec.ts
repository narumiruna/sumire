import type { Chat } from "@narumitw/sumire-contracts"
import { expect, type Page, type Route, test } from "@playwright/test"

const stored: Chat[] = [
  ...Array.from({ length: 205 }, (_, index) => ({
    id: -1000 - index,
    name: `Stored group ${index}`,
    type: "supergroup",
  })),
  { id: -1001234567890, name: "Beyond first page", type: "supergroup" },
  { id: -9001, name: "Same name", type: "group" },
  { id: -9002, name: "Same name", type: "channel" },
  { id: -9003, name: " -9003 ", type: "group" },
]

function directoryRows(url: URL, rows = stored) {
  const id = url.searchParams.get("id")
  if (id !== null) return rows.filter((row) => String(row.id) === id)
  const query = (url.searchParams.get("q") ?? "").trim().toLowerCase()
  const matches = rows.filter(
    (row) => row.name.toLowerCase().includes(query) || String(row.id) === query,
  )
  const offset = Number(url.searchParams.get("offset") ?? 0)
  return matches.slice(offset, offset + 100)
}

async function fixture(page: Page, href = "/?section=Durable") {
  const state = {
    rows: structuredClone(stored),
    directoryReads: [] as URL[],
    durableReads: [] as URL[],
    methods: [] as string[],
    handle: undefined as ((route: Route, url: URL) => Promise<boolean>) | undefined,
  }
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url())
    state.methods.push(route.request().method())
    if (url.pathname === "/api/chats") {
      state.directoryReads.push(url)
      if (await state.handle?.(route, url)) return
      await route.fulfill({ json: directoryRows(url, state.rows) })
      return
    }
    if (url.pathname.endsWith("/durable")) {
      state.durableReads.push(url)
      await route.fulfill({
        json: {
          version: 1,
          state: "not-loaded",
          readAt: "2026-10-19T12:00:00.000Z",
          view: url.searchParams.get("view") ?? "conversations",
          items: [],
          truncated: false,
        },
      })
      return
    }
    const data: Record<string, unknown> = {
      "/api/session": { csrf: "fixture", actor: "42" },
      "/api/settings": {
        revision: 1,
        applied: 1,
        status: "applied",
        policy: {
          tools: [],
          servers: [],
          models: [],
          providers: [],
          defaults: { tools: [], servers: [], models: [], model: null, thinking: "off" },
          privateUsers: [],
          groups: [-9001],
          chats: {},
        },
      },
      "/api/inventory": { tools: [], builtInTools: [], mcp: [], providers: [] },
      "/api/audit": [],
      "/api/imports": [],
      "/api/logout": {},
    }
    await route.fulfill({ json: data[url.pathname] ?? {} })
  })
  await page.goto(href)
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible()
  return state
}

const selector = (page: Page) => page.locator(".durable-chat-selector")
const inspector = (page: Page) =>
  page.getByRole("region", { name: "Durable Inspector", exact: true })
const rows = (page: Page) =>
  page.getByRole("list", { name: "Chats on this page", exact: true }).filter({ visible: true })
async function openSelector(page: Page) {
  const details = selector(page).locator("details")
  if ((await details.getAttribute("open")) === null) await details.locator("summary").click()
  await expect(selector(page).getByLabel("Search stored chats", { exact: true })).toBeVisible()
}
function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

for (const width of [1440, 390, 320]) {
  test(`Durable searches the stored directory beyond 100 with keyboard selection at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    const state = await fixture(page)
    await expect(selector(page).locator("details")).toHaveAttribute("open", "")
    await expect(
      inspector(page).getByRole("heading", { name: "Choose a chat", exact: true }),
    ).toBeVisible()
    await expect(rows(page).getByRole("button")).toHaveCount(100)
    expect(state.durableReads).toEqual([])
    const search = selector(page).getByLabel("Search stored chats", { exact: true })
    await search.fill("Beyond first page")
    const row = rows(page).getByRole("button", { name: /Beyond first page/ })
    await expect(row).toBeVisible()
    expect(
      state.directoryReads.some((url) => url.searchParams.get("q") === "Beyond first page"),
    ).toBe(true)
    await row.focus()
    expect(await row.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe("none")
    await row.press("Enter")
    await expect(page).toHaveURL(/chat=-1001234567890/)
    await expect(
      inspector(page).getByRole("heading", { name: "Beyond first page", exact: true }),
    ).toBeVisible()
    await openSelector(page)
    await expect(row).toHaveAttribute("aria-current", "true")
    expect(
      state.directoryReads.some((url) => url.searchParams.get("id") === "-1001234567890"),
    ).toBe(true)
    expect(state.methods.every((method) => method === "GET")).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}

test("searches complete IDs, retains duplicate names with separate IDs, and shares names with Chats", async ({
  page,
}) => {
  const state = await fixture(page)
  const search = selector(page).getByLabel("Search stored chats", { exact: true })
  await search.fill("-1001234567890")
  await expect(rows(page).getByRole("button")).toHaveCount(1)
  await expect(rows(page)).toContainText("Beyond first page")
  await search.fill("-100123456789")
  await expect(
    selector(page).getByText("No stored chats match this search.", { exact: true }),
  ).toBeVisible()
  await search.fill("Same name")
  await expect(rows(page).getByRole("button")).toHaveCount(2)
  for (const id of [-9001, -9002]) {
    const row = rows(page)
      .getByRole("button")
      .filter({ hasText: String(id) })
    await expect(row.locator("strong")).toHaveText("Same name")
    await row.click()
    await expect(
      inspector(page).getByRole("heading", { name: "Same name", exact: true }),
    ).toBeVisible()
    await expect(inspector(page).locator("header code")).toHaveText(String(id))
    await openSelector(page)
    await expect(row).toHaveAttribute("aria-current", "true")
  }
  await inspector(page).getByText("History and context", { exact: true }).click()
  await inspector(page).getByRole("button", { name: "Open chat settings", exact: true }).click()
  await expect(page.locator(".chat-header").getByRole("heading")).toHaveText("Same name")
  await expect(page.locator(".chat-header code")).toHaveText("-9002")
  state.rows = state.rows.map((row) =>
    row.id === -9002 ? { ...row, name: "Persisted rename" } : row,
  )
  await page.reload()
  await expect(page.locator(".chat-header").getByRole("heading")).toHaveText("Persisted rename")
  await page.getByRole("link", { name: "Inspect Durable", exact: true }).click()
  await expect(
    inspector(page).getByRole("heading", { name: "Persisted rename", exact: true }),
  ).toBeVisible()
})

test("paginates each global query independently and resets its offset on search", async ({
  page,
}) => {
  const state = await fixture(page)
  await expect(rows(page).getByRole("button")).toHaveCount(100)
  await selector(page).getByRole("button", { name: "Next chats", exact: true }).click()
  await expect(rows(page)).toContainText("Stored group 100")
  await expect(rows(page)).not.toContainText("Stored group 99")
  await expect(selector(page).getByText("Page 2", { exact: true })).toBeVisible()
  await selector(page).getByLabel("Search stored chats", { exact: true }).fill("Stored group")
  await expect(rows(page)).toContainText("Stored group 0")
  await expect(
    selector(page).getByRole("button", { name: "Previous chats", exact: true }),
  ).toBeDisabled()
  await selector(page).getByRole("button", { name: "Next chats", exact: true }).click()
  await expect(rows(page)).toContainText("Stored group 100")
  await selector(page).getByRole("button", { name: "Next chats", exact: true }).click()
  await expect(rows(page).getByRole("button")).toHaveCount(5)
  await expect(
    selector(page).getByRole("button", { name: "Next chats", exact: true }),
  ).toBeDisabled()
  expect(
    state.directoryReads.some(
      (url) =>
        url.searchParams.get("offset") === "200" && url.searchParams.get("q") === "Stored group",
    ),
  ).toBe(true)
  await selector(page).getByRole("button", { name: "Previous chats", exact: true }).click()
  await expect(rows(page)).toContainText("Stored group 100")
})

test("direct links load exact metadata independently of the visible page and survive refresh", async ({
  page,
}) => {
  const state = await fixture(
    page,
    "/?section=Durable&chat=-1001234567890&view=entries&conversationId=7&objectId=70",
  )
  await expect(
    inspector(page).getByRole("heading", { name: "Beyond first page", exact: true }),
  ).toBeVisible()
  expect(state.directoryReads.some((url) => url.searchParams.get("id") === "-1001234567890")).toBe(
    true,
  )
  expect(state.directoryReads.some((url) => url.searchParams.get("offset") === "0")).toBe(true)
  await expect(selector(page).locator("details")).not.toHaveAttribute("open", "")
  await page.reload()
  await expect(
    inspector(page).getByRole("heading", { name: "Beyond first page", exact: true }),
  ).toBeVisible()
  await expect(page).toHaveURL(/view=entries&conversationId=7&objectId=70/)
  expect(await page.evaluate(() => localStorage.length)).toBe(0)
  expect(state.methods.every((method) => method === "GET")).toBe(true)
})

for (const status of [200, 403, 500]) {
  test(`missing or failed exact metadata (${status}) does not block inspector links`, async ({
    page,
  }) => {
    const state = await fixture(page)
    const lookup = gate()
    state.handle = async (route, url) => {
      if (url.searchParams.get("id") !== "-777") return false
      await lookup.promise
      await route.fulfill(
        status === 200 ? { json: [] } : { status, json: { error: "Lookup failure" } },
      )
      return true
    }
    await page.goto("/?section=Durable&chat=-777&view=entries&conversationId=7&objectId=70")
    await expect(
      inspector(page).getByRole("heading", { name: "Loading chat name…", exact: true }),
    ).toBeVisible()
    await expect
      .poll(() => state.durableReads.some((url) => url.pathname.includes("/-777/")))
      .toBe(true)
    lookup.release()
    await expect(
      inspector(page).getByRole("heading", {
        name: status === 200 ? "Chat name unknown" : "Chat name unavailable",
        exact: true,
      }),
    ).toBeVisible()
    await expect(inspector(page).locator("header code")).toHaveText("-777")
    if (status !== 200) {
      await expect(
        inspector(page)
          .getByRole("alert")
          .filter({
            hasText: status === 403 ? "Permission denied" : "Could not read chat metadata",
          }),
      ).toBeVisible()
      state.handle = undefined
      state.rows.push({ id: -777, name: "Recovered metadata", type: "group" })
      const previousLookups = state.directoryReads.filter(
        (url) => url.searchParams.get("id") === "-777",
      ).length
      await inspector(page)
        .getByRole("button", { name: "Retry chat metadata", exact: true })
        .click()
      await expect
        .poll(
          () => state.directoryReads.filter((url) => url.searchParams.get("id") === "-777").length,
        )
        .toBeGreaterThan(previousLookups)
      await expect(
        inspector(page).getByRole("heading", { name: "Recovered metadata", exact: true }),
      ).toBeVisible()
    }
    await expect(page).toHaveURL(/view=entries&conversationId=7&objectId=70/)
  })
}

test("old queries and old pages cannot replace the current global search", async ({ page }) => {
  const state = await fixture(page)
  const oldQuery = gate()
  const oldPage = gate()
  const completed: Promise<void>[] = []
  state.handle = async (route, url) => {
    const query = url.searchParams.get("q")
    const pending =
      query === "old query"
        ? oldQuery
        : url.searchParams.get("offset") === "100" && !query
          ? oldPage
          : undefined
    if (!pending) return false
    const done = gate()
    completed.push(done.promise)
    await pending.promise
    try {
      await route.fulfill({ json: [{ id: -888, name: "Obsolete result", type: "group" }] })
    } finally {
      done.release()
    }
    return true
  }
  await selector(page).getByRole("button", { name: "Next chats", exact: true }).click()
  await expect(selector(page).getByRole("status")).toHaveText("Loading chats…")
  const search = selector(page).getByLabel("Search stored chats", { exact: true })
  await search.fill("old query")
  await expect
    .poll(() => state.directoryReads.some((url) => url.searchParams.get("q") === "old query"))
    .toBe(true)
  await search.fill("Beyond first page")
  await expect(rows(page)).toContainText("Beyond first page")
  oldPage.release()
  oldQuery.release()
  await Promise.all(completed)
  await expect(rows(page).getByRole("button")).toHaveCount(1)
  await expect(rows(page)).not.toContainText("Obsolete result")
  await expect(search).toHaveValue("Beyond first page")
  await expect(selector(page).getByText("Page 1", { exact: true })).toBeVisible()
})

test("rapid A→B→A switching rejects stale metadata and restores browser history", async ({
  page,
}) => {
  const state = await fixture(page)
  const delayedA = gate()
  const delayedB = gate()
  const finished = [gate(), gate()]
  let aReads = 0
  let bReads = 0
  state.handle = async (route, url) => {
    const id = url.searchParams.get("id")
    if (id !== "-9001" && id !== "-9002") return false
    if (id === "-9001" && ++aReads > 1) return false
    if (id === "-9002" && ++bReads > 1) return false
    const index = id === "-9001" ? 0 : 1
    await (index === 0 ? delayedA.promise : delayedB.promise)
    try {
      await route.fulfill(
        index === 0
          ? { json: [{ id: Number(id), name: `Obsolete ${id}`, type: "group" }] }
          : { status: 403, json: { error: "Obsolete lookup denial" } },
      )
    } finally {
      finished[index]?.release()
    }
    return true
  }
  await selector(page).getByLabel("Search stored chats", { exact: true }).fill("Same name")
  const a = rows(page).getByRole("button").filter({ hasText: "-9001" })
  const b = rows(page).getByRole("button").filter({ hasText: "-9002" })
  await a.click()
  await expect(
    inspector(page).getByRole("heading", { name: "Loading chat name…", exact: true }),
  ).toBeVisible()
  await openSelector(page)
  await b.click()
  await expect
    .poll(() => state.directoryReads.some((url) => url.searchParams.get("id") === "-9002"))
    .toBe(true)
  await openSelector(page)
  await a.click()
  await expect(
    inspector(page).getByRole("heading", { name: "Same name", exact: true }),
  ).toBeVisible()
  delayedB.release()
  delayedA.release()
  await Promise.all(finished.map((value) => value.promise))
  await expect(inspector(page).locator("header code")).toHaveText("-9001")
  await expect(inspector(page)).not.toContainText("Obsolete")
  await expect(inspector(page).getByRole("alert")).toHaveCount(0)
  await page.goBack()
  await expect(inspector(page).locator("header code")).toHaveText("-9002")
  await expect(
    inspector(page).getByRole("heading", { name: "Same name", exact: true }),
  ).toBeVisible()
  await page.goBack()
  await expect(inspector(page).locator("header code")).toHaveText("-9001")
  await page.goForward()
  await expect(inspector(page).locator("header code")).toHaveText("-9002")
  await page.reload()
  await expect(inspector(page).locator("header code")).toHaveText("-9002")
  await expect(
    inspector(page).getByRole("heading", { name: "Same name", exact: true }),
  ).toBeVisible()
})

test("explicitly choosing a different chat clears old inspector scope and object IDs", async ({
  page,
}) => {
  await fixture(
    page,
    "/?section=Durable&chat=-9001&view=documents&scope=task&conversationId=7&taskId=8&objectId=9",
  )
  await expect(
    inspector(page).getByRole("heading", { name: "Same name", exact: true }),
  ).toBeVisible()
  await openSelector(page)
  await selector(page).getByLabel("Search stored chats", { exact: true }).fill("Same name")
  await rows(page).getByRole("button").filter({ hasText: "-9001" }).click()
  await expect(page).toHaveURL(/objectId=9/)
  await rows(page).getByRole("button").filter({ hasText: "-9002" }).click()
  const url = new URL(page.url())
  expect(url.searchParams.get("chat")).toBe("-9002")
  for (const key of ["view", "scope", "conversationId", "taskId", "objectId"])
    expect(url.searchParams.has(key)).toBe(false)
  await page.goBack()
  await expect(page).toHaveURL(/chat=-9001.*objectId=9/)
})

test("neutral names keep IDs secondary and Chats filters use current policy drafts", async ({
  page,
}) => {
  await fixture(page, "/?section=Chats")
  const search = page.getByLabel("Search stored chats", { exact: true })
  await search.fill("-9003")
  const row = rows(page).getByRole("button")
  await expect(row.locator("strong")).toHaveText("Unnamed group")
  await expect(row.locator("small")).toContainText("-9003")
  await row.click()
  await expect(page.locator(".chat-header").getByRole("heading")).toHaveText("Unnamed group")
  await search.fill("Same name")
  await page.getByRole("combobox", { name: "Access status", exact: true }).click()
  await page.getByRole("option", { name: "Approved and enabled", exact: true }).click()
  await expect(rows(page).getByRole("button")).toHaveCount(1)
  await expect(rows(page)).toContainText("-9001")
  await rows(page).getByRole("button").click()
  await page.getByRole("tab", { name: "Access", exact: true }).click()
  await page
    .getByRole("tabpanel", { name: "Access", exact: true })
    .getByRole("button", { name: "Revoke access", exact: true })
    .click()
  await expect(
    page.getByText("No chats match the filters on this page.", { exact: true }),
  ).toBeVisible()
  await expect(page.locator(".pending-bar")).toContainText("1 pending policy change")
})

test("manual ID input stays a local draft until an explicit chat choice", async ({ page }) => {
  const state = await fixture(page, "/?section=Chats&chat=-9001")
  await expect(page.locator(".chat-header").getByRole("heading")).toHaveText("Same name")
  await page.locator(".configure-id summary").click()
  const input = page.getByLabel("Chat ID (can configure before first message)", { exact: true })
  const previousReads = state.directoryReads.length
  await input.fill("-9002")
  await expect(page).toHaveURL(/chat=-9001/)
  await expect(page.locator(".chat-header code")).toHaveText("-9001")
  expect(state.directoryReads.length).toBe(previousReads)
  await page.getByRole("button", { name: "Open chat details", exact: true }).click()
  await expect(page).toHaveURL(/chat=-9002/)
  await expect(page.locator(".chat-header code")).toHaveText("-9002")
  await page.goBack()
  await expect(page.locator(".chat-header code")).toHaveText("-9001")
  await expect(input).toHaveValue("-9001")
  expect(state.methods.every((method) => method === "GET")).toBe(true)
})

for (const trigger of ["directory", "lookup", "logout"] as const) {
  test(`${trigger} expiry clears cached names and blocks late directory results`, async ({
    page,
  }) => {
    const state = await fixture(page)
    await selector(page)
      .getByLabel("Search stored chats", { exact: true })
      .fill("Beyond first page")
    await rows(page).getByRole("button").click()
    await expect(
      inspector(page).getByRole("heading", { name: "Beyond first page", exact: true }),
    ).toBeVisible()
    if (trigger === "logout") {
      const pending = gate()
      const finished = gate()
      state.handle = async (route) => {
        await pending.promise
        try {
          await route.fulfill({
            json: [{ id: -1001234567890, name: "Late cached name", type: "group" }],
          })
        } finally {
          finished.release()
        }
        return true
      }
      await openSelector(page)
      await selector(page).getByLabel("Search stored chats", { exact: true }).fill("late query")
      await expect
        .poll(() => state.directoryReads.some((url) => url.searchParams.get("q") === "late query"))
        .toBe(true)
      await page.getByRole("button", { name: "Sign out", exact: true }).click()
      pending.release()
      await finished.promise
      await expect(page.getByText("Late cached name", { exact: true })).toHaveCount(0)
    } else {
      state.handle = async (route, url) => {
        if (trigger === "lookup" && !url.searchParams.has("id")) return false
        await route.fulfill({ status: 401, json: { error: "Session expired" } })
        return true
      }
      await openSelector(page)
      await selector(page).getByRole("button", { name: "Refresh chats", exact: true }).click()
    }
    await expect(
      page.getByRole("button", { name: "Sign in with passkey", exact: true }),
    ).toBeVisible()
    await expect(page.getByText("Beyond first page", { exact: true })).toHaveCount(0)
    await expect(page.locator(".chat-list button")).toHaveCount(0)
    if (trigger !== "logout")
      await expect(page.getByRole("alert")).toContainText(
        "Administrator session expired. Sign in again.",
      )
    expect(await page.evaluate(() => localStorage.length)).toBe(0)
  })
}
