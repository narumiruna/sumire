import { expect, test } from "@playwright/test"
import { durableFixture, navigateSection, untrusted } from "./durable-fixture.js"

for (const width of [1440, 390, 320]) {
  test(`loaded, idle, and unloaded chat smoke at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const state = await durableFixture(page)
    const inspector = page.getByRole("region", { name: "Durable Inspector", exact: true })
    await expect(
      inspector.getByText("Persisted selected conversation", { exact: true }),
    ).toBeVisible()
    await expect(
      inspector
        .getByRole("region", { name: "Persisted selection", exact: true })
        .getByText(/Read time:/),
    ).toContainText("2026-10-19T12:00:00.000Z")
    await expect(inspector.getByRole("heading", { name: "Loaded chat", exact: true })).toBeVisible()
    await expect(
      inspector.getByRole("region", { name: "Selected conversation task history", exact: true }),
    ).toContainText("1 task record on the loaded page")
    await expect(inspector.getByText(/Truncated · the server read limit/)).toBeVisible()
    await page.getByRole("button", { name: "Open chat settings", exact: true }).click()
    const back = page.getByRole("button", { name: "Back to chat directory", exact: true })
    if (await back.isVisible()) await back.click()
    await page
      .getByRole("list", { name: "Chats on this page" })
      .getByRole("button", { name: /Idle chat/ })
      .click()
    await page.getByRole("link", { name: "Inspect Durable", exact: true }).click()
    await expect(inspector.getByText("Historical conversation", { exact: true })).toBeVisible()
    await expect(inspector.getByRole("heading", { name: "conversation #17" })).toBeVisible()
    await page.getByRole("button", { name: "Open chat settings", exact: true }).click()
    if (await back.isVisible()) await back.click()
    await page
      .getByRole("list", { name: "Chats on this page" })
      .getByRole("button", { name: /Unloaded chat/ })
      .click()
    await page.getByRole("link", { name: "Inspect Durable", exact: true }).click()
    await expect(inspector.getByRole("heading", { name: "Not loaded", exact: true })).toBeVisible()
    await expect(inspector).toContainText("Inspection will not open its database")
    expect(state.methods.every((method) => method === "GET")).toBe(true)
    await page.waitForTimeout(150)
    expect(state.requests).toHaveLength(4)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}

test("all four views, approved JSON, scope, owner and parent links, and safe text", async ({
  page,
}) => {
  const state = await durableFixture(page)
  const inspector = page.getByRole("region", { name: "Durable Inspector", exact: true })
  await inspector.getByText("Metadata JSON for conversation 7", { exact: true }).click()
  await expect(inspector.locator("pre")).toContainText('"active": true')
  await expect(
    inspector.getByRole("link", { name: "Conversation 6", exact: true }),
  ).toHaveAttribute("href", /view=conversations&objectId=6/)
  await inspector.getByRole("link", { name: "Tasks in conversation 7", exact: true }).click()
  await expect(page).toHaveURL(/view=tasks&conversationId=7/)
  await expect(inspector.getByText("terminal · completed", { exact: true })).toBeVisible()
  await inspector.getByText("Metadata JSON for task 8", { exact: true }).click()
  await expect(inspector.locator("pre")).toContainText('"outcome": "completed"')
  await inspector.getByRole("link", { name: "Documents for task 8", exact: true }).click()
  await expect(
    inspector.getByRole("combobox", { name: "Document scope", exact: true }),
  ).toHaveValue("task")
  await expect(
    inspector.getByText("Empty · no records in this view.", { exact: true }),
  ).toBeVisible()
  expect(state.requests.at(-1)?.searchParams.get("taskId")).toBe("8")
  await expect(inspector.getByRole("link", { name: /Inspect document/ })).toHaveCount(0)
  await inspector
    .getByRole("combobox", { name: "Document scope", exact: true })
    .selectOption("conversation")
  await inspector.getByRole("button", { name: "Select document 102", exact: true }).click()
  await expect(inspector.getByText(/Value withheld · Kind is not approved/)).toBeVisible()
  await expect(
    inspector.getByRole("link", { name: "Inspect document 102", exact: true }),
  ).toHaveCount(0)
  const beforeExpand = state.requests.length
  await inspector.getByText("Metadata JSON for document 102", { exact: true }).click()
  await expect(inspector.locator("details[open] pre")).toContainText(
    '"withheldReason": "unknown-kind"',
  )
  expect(state.requests).toHaveLength(beforeExpand)
  await inspector.getByRole("link", { name: "Inspect document 103", exact: true }).click()
  await expect(inspector.getByText("Retired or unavailable", { exact: true })).toBeVisible()
  await inspector.getByRole("link", { name: "Back to documents", exact: true }).click()
  await inspector.getByRole("link", { name: "Inspect document 101", exact: true }).click()
  await expect(inspector.getByText("Server-approved projection", { exact: true })).toBeVisible()
  await inspector.getByText("Approved value JSON for document 101", { exact: true }).click()
  await expect(inspector.locator("pre").last()).toContainText("untrusted.invalid")
  expect(await inspector.locator("img, iframe, script").count()).toBe(0)
  expect(await page.evaluate(() => Object.hasOwn(window, "inspectorInjected"))).toBe(false)
  state.documentLimit = true
  await inspector.getByRole("button", { name: "Refresh Durable", exact: true }).click()
  await expect(inspector.getByText(/Truncated: value exceeds limits/)).toBeVisible()
  await inspector.getByRole("tab", { name: "Entries", exact: true }).click()
  await expect(inspector.getByText("message / assistant", { exact: true })).toBeVisible()
  await inspector.getByText("Metadata JSON for entry 70", { exact: true }).click()
  await expect(inspector.locator("pre")).toContainText('"role": "assistant"')
  await inspector.getByRole("link", { name: "8", exact: true }).click()
  await expect(page).toHaveURL(/view=tasks&conversationId=7&objectId=8/)
  expect(state.requests.every((url) => url.searchParams.get("limit") === "25")).toBe(true)
  expect(state.methods.every((method) => method === "GET")).toBe(true)
  expect(untrusted).toContain("untrusted.invalid")
})

test("opaque pagination, previous page, manual refresh, and browser back", async ({ page }) => {
  const state = await durableFixture(page)
  const inspector = page.getByRole("region", { name: "Durable Inspector", exact: true })
  const previous = inspector.getByRole("button", { name: "Previous objects", exact: true })
  await expect(previous).toBeDisabled()
  await inspector.getByRole("button", { name: "Next objects", exact: true }).click()
  await expect(inspector.getByRole("heading", { name: "conversation #9" })).toBeVisible()
  expect(
    state.requests
      .filter((url) => url.searchParams.get("view") === "conversations")
      .at(-1)
      ?.searchParams.get("cursor"),
  ).toBe("opaque+/=token")
  await expect(inspector.getByRole("button", { name: "Next objects", exact: true })).toBeDisabled()
  await previous.click()
  await expect(inspector.getByRole("heading", { name: "conversation #7" })).toBeVisible()
  await inspector.getByRole("button", { name: "Next objects", exact: true }).click()
  await expect(inspector.getByRole("heading", { name: "conversation #9" })).toBeVisible()
  await inspector.getByRole("button", { name: "Refresh Durable", exact: true }).click()
  await expect(inspector.getByRole("heading", { name: "conversation #7" })).toBeVisible()
  await expect(previous).toBeDisabled()
  const count = state.requests.length
  await page.waitForTimeout(250)
  expect(state.requests).toHaveLength(count)
  await inspector.getByRole("link", { name: "Entries in conversation 7", exact: true }).click()
  await expect(inspector.getByRole("heading", { name: "entry #70" })).toBeVisible()
  await page.goBack()
  await expect(inspector.getByRole("heading", { name: "conversation #7" })).toBeVisible()
})

test("deep links, context validation, distinct empty and read failure states", async ({ page }) => {
  const state = await durableFixture(
    page,
    "/?section=Durable&chat=42&view=documents&scope=session&objectId=201",
  )
  const inspector = page.getByRole("region", { name: "Durable Inspector", exact: true })
  await expect(inspector.getByText("Server-approved projection", { exact: true })).toBeVisible()
  state.selectedConversation = null
  await inspector.getByRole("button", { name: "Refresh Durable", exact: true }).click()
  await expect(
    inspector.getByText("No selected-conversation metadata available.", { exact: true }),
  ).toBeVisible()
  await inspector.getByRole("tab", { name: "Tasks", exact: true }).click()
  await expect(
    inspector.getByText("Select a conversation to inspect this view.", { exact: true }),
  ).toBeVisible()
  await expect(
    inspector.getByText("No selected-conversation metadata available.", { exact: true }),
  ).toBeVisible()
  const beforeInvalid = state.requests.length
  await inspector.getByText("Advanced inspection", { exact: true }).click()
  await inspector.getByLabel("Conversation ID", { exact: true }).fill("07")
  await inspector.getByRole("button", { name: "Inspect IDs", exact: true }).click()
  await expect(inspector.getByRole("alert")).toContainText("positive whole-number")
  expect(state.requests).toHaveLength(beforeInvalid)
  state.empty = true
  await inspector.getByLabel("Conversation ID", { exact: true }).fill("7")
  await inspector.getByRole("button", { name: "Inspect IDs", exact: true }).click()
  await expect(
    inspector.getByText("Empty · no records in this view.", { exact: true }),
  ).toBeVisible()
  state.failed = true
  await inspector.getByRole("button", { name: "Refresh Durable", exact: true }).click()
  await expect(inspector.getByRole("alert").last()).toHaveText("Read failed. Refresh to retry.")
  state.failed = false
  state.empty = false
  await inspector.getByRole("button", { name: "Refresh Durable", exact: true }).click()
  await expect(inspector.getByRole("heading", { name: "task #8" })).toBeVisible()
})

test("session expiry clears loaded metadata and asks App to reauthenticate", async ({ page }) => {
  const state = await durableFixture(
    page,
    "/?section=Durable&chat=42&view=documents&scope=conversation&conversationId=7&objectId=101",
  )
  await page.getByText("Approved value JSON for document 101", { exact: true }).click()
  await expect(page.locator(".durable-inspector pre").last()).toContainText("untrusted.invalid")
  state.expired = true
  await page.getByRole("button", { name: "Refresh Durable", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Sign in with passkey", exact: true }),
  ).toBeVisible()
  await expect(page.getByRole("alert")).toHaveText("Administrator session expired. Sign in again.")
  await expect(page.locator(".durable-inspector")).toHaveCount(0)
  await expect(page.getByText(/untrusted.invalid/)).toHaveCount(0)
  await page.goBack()
  await expect(page.locator(".durable-inspector")).toHaveCount(0)
})

test("cancels delayed reads on object switch, chat switch, and unmount without stale data", async ({
  page,
}) => {
  const state = await durableFixture(
    page,
    "/?section=Durable&chat=42&view=documents&scope=conversation&conversationId=7",
  )
  await expect(page.getByRole("link", { name: "Inspect document 101", exact: true })).toBeVisible()
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  state.gates.set("/api/chats/42/durable:101", gate)
  const aborted: string[] = []
  page.on("requestfailed", (request) => aborted.push(request.url()))
  try {
    await page.getByRole("link", { name: "Inspect document 101", exact: true }).click()
    await expect(page.getByText("Loading Durable…", { exact: true })).toBeVisible()
    await expect
      .poll(() => state.requests.filter((url) => url.searchParams.get("objectId") === "101").length)
      .toBe(1)
    await page.getByRole("tab", { name: "Entries", exact: true }).click()
    await expect(page.getByRole("heading", { name: "entry #70" })).toBeVisible()
    await expect.poll(() => aborted.length).toBe(1)
    await page.getByRole("tab", { name: "Documents", exact: true }).click()
    await page.getByRole("link", { name: "Inspect document 101", exact: true }).click()
    await expect(page.getByText("Loading Durable…", { exact: true })).toBeVisible()
    await expect
      .poll(() => state.requests.filter((url) => url.searchParams.get("objectId") === "101").length)
      .toBe(2)
    await page.getByRole("button", { name: "Open chat settings", exact: true }).click()
    await expect.poll(() => aborted.length).toBe(2)
    await page
      .getByRole("list", { name: "Chats on this page" })
      .getByRole("button", { name: /Idle chat/ })
      .click()
    await page.getByRole("link", { name: "Inspect Durable", exact: true }).click()
    await expect(page.getByRole("heading", { name: "conversation #17" })).toBeVisible()
  } finally {
    release()
  }
  await expect(page.getByText("Approved value JSON for document 101", { exact: true })).toHaveCount(
    0,
  )
  await expect(page.getByRole("heading", { name: "entry #70" })).toHaveCount(0)
})

test("policy drafts and the discard confirmation survive Inspector navigation", async ({
  page,
}) => {
  await durableFixture(page, "/?section=Chats&chat=42")
  await page.getByRole("tab", { name: "Access", exact: true }).click()
  await page.getByRole("button", { name: "Revoke access", exact: true }).click()
  await expect(page.getByText("Pending access revocation", { exact: true })).toBeVisible()
  await page.getByRole("link", { name: "Inspect Durable", exact: true }).click()
  await expect(page.getByRole("heading", { name: "conversation #7" })).toBeVisible()
  await expect(page.locator(".pending-bar")).toContainText("pending policy changes")
  await page.getByRole("button", { name: "Open chat settings", exact: true }).click()
  await expect(page.getByText("Pending access revocation", { exact: true })).toBeVisible()
  await expect(page.locator(".chat-header code")).toHaveText("42")
  await navigateSection(page, "Durable")
  const dialog = page.waitForEvent("dialog")
  const clicking = page.getByRole("button", { name: "Sign out", exact: true }).click()
  const prompt = await dialog
  expect(prompt.message()).toBe("Discard pending changes and leave?")
  await prompt.dismiss()
  await clicking
  await expect(page.getByRole("region", { name: "Durable Inspector", exact: true })).toBeVisible()
  await expect(page.locator(".pending-bar")).toContainText("pending policy changes")
})

test("a chat change in history cancels the old chat read and clears object context", async ({
  page,
}) => {
  const state = await durableFixture(
    page,
    "/?section=Durable&chat=42&view=documents&scope=conversation&conversationId=7",
  )
  let release = () => {}
  state.gates.set(
    "/api/chats/42/durable:101",
    new Promise<void>((resolve) => {
      release = resolve
    }),
  )
  const aborted = page.waitForEvent("requestfailed", (request) =>
    request.url().includes("objectId=101"),
  )
  try {
    await page.getByRole("link", { name: "Inspect document 101", exact: true }).click()
    await expect(page.getByText("Loading Durable…", { exact: true })).toBeVisible()
    await expect
      .poll(() => state.requests.some((url) => url.searchParams.get("objectId") === "101"))
      .toBe(true)
    await page.evaluate(() => {
      window.history.pushState(null, "", "?section=Durable&chat=43")
      window.dispatchEvent(new PopStateEvent("popstate"))
    })
    await expect(page.getByRole("heading", { name: "conversation #17" })).toBeVisible()
    await aborted
  } finally {
    release()
  }
  await expect(page.getByRole("heading", { name: "Idle chat", exact: true })).toBeVisible()
  await page.getByText("Advanced inspection", { exact: true }).click()
  await expect(page.getByLabel("Conversation ID", { exact: true })).toHaveValue("")
  await expect(page.getByText("Approved value JSON for document 101", { exact: true })).toHaveCount(
    0,
  )
})

test("no selected chat performs no inspection read; missing detail is unavailable", async ({
  page,
}) => {
  const state = await durableFixture(page, "/?section=Durable")
  await expect(
    page.getByText("Select a chat above to inspect Durable.", { exact: true }),
  ).toBeVisible()
  expect(state.requests).toHaveLength(0)
  await page.goto("/?section=Durable&chat=42&view=tasks&conversationId=7&objectId=999")
  await expect(page.getByText("Retired or unavailable", { exact: true })).toBeVisible()
  await page.route("**/api/chats/42/durable?*", (route) =>
    route.fulfill({ status: 404, json: { error: "Unavailable" } }),
  )
  await page.getByRole("button", { name: "Refresh Durable", exact: true }).click()
  await expect(
    page.getByRole("status").filter({
      hasText: "Retired or unavailable. The object is no longer available in this scope.",
    }),
  ).toBeVisible()
})

test("off-page persisted selection is separate from the inspection target and uses bounded historical evidence", async ({
  page,
}) => {
  const state = await durableFixture(page, "/?section=Durable&chat=42&conversationId=7")
  const inspector = page.getByRole("region", { name: "Durable Inspector", exact: true })
  await expect(
    inspector.getByRole("heading", { name: "conversation #7", exact: true }),
  ).toBeVisible()
  expect(state.requests).toHaveLength(2)
  state.taskTruncated = true
  state.selectedConversation = {
    type: "conversation",
    id: 99,
    active: true,
    parent: { conversationId: 6, at: 60 },
  }
  state.taskItems = [
    {
      type: "task",
      id: 8,
      conversationId: 99,
      kind: "model",
      version: 1,
      status: "running",
      background: false,
      abortRequested: false,
    },
  ]
  await inspector.getByRole("button", { name: "Refresh Durable", exact: true }).click()
  const selection = inspector.getByRole("region", { name: "Persisted selection", exact: true })
  const history = inspector.getByRole("region", {
    name: "Selected conversation task history",
    exact: true,
  })
  await expect(selection.getByText("Conversation 99", { exact: true })).toBeVisible()
  await expect(selection).toContainText("Inspection target: conversation 7")
  await expect(history).toContainText("1 task record on the loaded page · more may exist")
  await expect(history).toContainText("historical running")
  await expect(history).toContainText("2026-10-19T12:00:01.000Z")
  await expect(selection).toContainText("2026-10-19T12:00:00.000Z")
  await expect(
    inspector.getByRole("heading", { name: "conversation #7", exact: true }),
  ).toBeVisible()
  expect(state.requests).toHaveLength(4)
  expect(state.requests.at(-1)?.searchParams.get("conversationId")).toBe("99")
  await expect(inspector.getByLabel("Conversation ID", { exact: true })).toBeHidden()
  await expect(inspector.locator("pre")).toBeHidden()
  await expect(
    inspector.getByText("Read-only persisted data; not live execution state", { exact: true }),
  ).toBeVisible()
  await expect(inspector).not.toContainText(/healthy|idle execution|currently running/i)
  state.selectedConversation = null
  await inspector.getByRole("button", { name: "Refresh Durable", exact: true }).click()
  await expect(selection).toContainText("No selected-conversation metadata available.")
  await expect(history).toContainText("No selected-conversation metadata to read.")
  expect(state.requests).toHaveLength(5)
})

test("a partial history failure keeps selection and inspection with independent read times and a three-read budget", async ({
  page,
}) => {
  const state = await durableFixture(
    page,
    "/?section=Durable&chat=42&view=documents&scope=session&objectId=201",
  )
  const inspector = page.getByRole("region", { name: "Durable Inspector", exact: true })
  await expect(inspector.getByText("Server-approved projection", { exact: true })).toBeVisible()
  expect(state.requests).toHaveLength(3)
  state.failures.set("tasks", 503)
  await inspector.getByRole("button", { name: "Refresh Durable", exact: true }).click()
  const history = inspector.getByRole("region", {
    name: "Selected conversation task history",
    exact: true,
  })
  await expect(history.getByRole("alert")).toHaveText("Read failed. Refresh to retry.")
  await expect(
    inspector.getByRole("region", { name: "Persisted selection", exact: true }),
  ).toContainText("Conversation 7")
  await expect(inspector.getByText("Server-approved projection", { exact: true })).toBeVisible()
  await expect(history.locator("time")).toHaveCount(0)
  expect(state.requests).toHaveLength(6)
  await page.waitForTimeout(250)
  expect(state.requests).toHaveLength(6)
  state.failures.delete("tasks")
  state.taskItems = []
  await inspector.getByRole("button", { name: "Refresh Durable", exact: true }).click()
  await expect(history).toContainText("No task history on this page.")
  expect(state.requests).toHaveLength(9)
  state.failures.set("tasks", 403)
  await inspector.getByRole("button", { name: "Refresh Durable", exact: true }).click()
  await expect(history.getByRole("alert")).toHaveText(
    "Permission denied. This data could not be read.",
  )
  await expect(inspector.getByText("Server-approved projection", { exact: true })).toBeVisible()
  expect(state.requests).toHaveLength(12)
  state.failures.delete("tasks")
  state.failures.set("conversations", 503)
  await inspector.getByRole("button", { name: "Refresh Durable", exact: true }).click()
  await expect(
    inspector.getByRole("region", { name: "Persisted selection", exact: true }).getByRole("alert"),
  ).toHaveText("Read failed. Refresh to retry.")
  await expect(history).toContainText("Unavailable: selection could not be read.")
  await expect(inspector.getByText("Server-approved projection", { exact: true })).toBeVisible()
  expect(state.requests).toHaveLength(14)
})

test("chat IDs and collapsed approved JSON can be copied, with explicit copy failures and no extra reads", async ({
  page,
}) => {
  const state = await durableFixture(
    page,
    "/?section=Durable&chat=42&view=documents&scope=conversation&conversationId=7&objectId=101",
  )
  const inspector = page.getByRole("region", { name: "Durable Inspector", exact: true })
  await expect(inspector.getByText("Server-approved projection", { exact: true })).toBeVisible()
  await expect(inspector.locator("pre:visible")).toHaveCount(0)
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          sessionStorage.setItem("copied-fixture", text)
        },
      },
    }),
  )
  await inspector.getByRole("button", { name: "Copy chat ID", exact: true }).click()
  await expect(inspector.getByText("Chat ID copied.", { exact: true })).toBeVisible()
  expect(await page.evaluate(() => sessionStorage.getItem("copied-fixture"))).toBe("42")
  await inspector.getByText("Approved value JSON for document 101", { exact: true }).click()
  await inspector
    .getByRole("button", { name: "Copy Approved value JSON for document 101", exact: true })
    .click()
  await expect(inspector.getByText("JSON copied.", { exact: true })).toBeVisible()
  const copied = await page.evaluate(() => sessionStorage.getItem("copied-fixture"))
  expect(JSON.parse(copied ?? "null")).toEqual({
    kind: "pi.agent",
    model: { provider: "fixture", modelId: untrusted },
    thinkingLevel: "low",
  })
  await inspector.getByText("Metadata JSON for document 101", { exact: true }).click()
  await inspector
    .getByRole("button", { name: "Copy Metadata JSON for document 101", exact: true })
    .click()
  const metadata = JSON.parse(
    (await page.evaluate(() => sessionStorage.getItem("copied-fixture"))) ?? "null",
  )
  expect(metadata.id).toBe(101)
  expect(metadata.value).toBeUndefined()
  expect(metadata.body).toBeUndefined()
  expect(metadata.output).toBeUndefined()
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("Clipboard denied")
        },
      },
    }),
  )
  await inspector
    .getByRole("button", { name: "Copy Approved value JSON for document 101", exact: true })
    .click()
  await expect(
    inspector.getByText("Copy failed. Select and copy the JSON below.", { exact: true }),
  ).toBeVisible()
  await expect(inspector.locator("details[open] pre").last()).toBeVisible()
  expect(state.requests).toHaveLength(3)
  expect(await inspector.locator("img, iframe, script").count()).toBe(0)
})

for (const width of [390, 320])
  test(`long names and safe-integer IDs wrap at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const state = await durableFixture(page)
    await expect(page.getByRole("heading", { name: "conversation #7", exact: true })).toBeVisible()
    const id = 9007199254740991
    const name = `A persisted chat name with a very long uninterrupted suffix ${"long".repeat(35)}`
    state.chats.push({ id: -id, name, type: "supergroup" })
    state.selectedConversation = { type: "conversation", id, active: true }
    state.taskItems = [
      {
        type: "task",
        id,
        conversationId: id,
        kind: "model",
        version: 1,
        status: "terminal",
        outcome: "completed",
        background: false,
        abortRequested: false,
      },
    ]
    await page.goto(`/?section=Durable&chat=-${id}&view=tasks&conversationId=${id}`)
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible()
    await expect(page.getByRole("heading", { name: `task #${id}`, exact: true })).toBeVisible()
    await page.getByText(`Metadata JSON for task ${id}`, { exact: true }).click()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })

test("keyboard tabs, JSON expansion, and narrow layout are usable", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 })
  await durableFixture(page, "/?section=Durable&chat=42&conversationId=7")
  const tab = page.getByRole("tab", { name: "Conversations", exact: true })
  await tab.focus()
  await tab.press("ArrowRight")
  await expect(page.getByRole("tab", { name: "Tasks", exact: true })).toBeFocused()
  await expect(page.getByRole("heading", { name: "task #8" })).toBeVisible()
  const summary = page.getByText("Metadata JSON for task 8", { exact: true })
  await summary.focus()
  await summary.press("Enter")
  await expect(page.locator(".durable-inspector pre")).toBeVisible()
  expect(await summary.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe(
    "none",
  )
  await page.getByRole("tab", { name: "Tasks", exact: true }).press("End")
  await expect(page.getByRole("tab", { name: "Entries", exact: true })).toBeFocused()
  await expect(page.getByRole("heading", { name: "entry #70" })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
