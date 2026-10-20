import { expect, type Page, test } from "@playwright/test"
import { durableFixture, entries, entryContent, tasks, untrusted } from "./durable-fixture.js"

const inspector = (page: Page) =>
  page.getByRole("region", { name: "Durable Inspector", exact: true })
const detail = (page: Page) =>
  inspector(page).getByRole("region", { name: "Selected item details", exact: true })
const content = (page: Page) =>
  detail(page).getByRole("region", { name: "Entry content", exact: true })
const tree = (page: Page) =>
  inspector(page).getByRole("region", { name: "Relationship tree", exact: true })

for (const width of [1440, 320])
  test(`entry detail renders literal content and copies separate JSON at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    const remote: string[] = []
    page.on("request", (request) => {
      if (request.url().includes("untrusted.invalid")) remote.push(request.url())
    })
    const state = await durableFixture(
      page,
      "/?section=Durable&chat=42&view=entries&conversationId=7&taskId=8",
    )
    await expect(detail(page)).toContainText("Only metadata is included.")
    await expect(content(page)).toHaveCount(0)
    expect(state.requests.at(-1)?.searchParams.has("objectId")).toBe(false)
    const inspect = inspector(page).getByRole("link", { name: "Inspect entry 70", exact: true })
    await expect(inspect).toHaveAttribute(
      "href",
      /view=entries&conversationId=7&taskId=8&objectId=70/,
    )
    await inspect.click()
    await expect(page).toHaveURL(/view=entries&conversationId=7&taskId=8&objectId=70/)
    await expect(content(page)).toBeVisible()
    await expect(
      content(page).getByRole("heading", { name: "Message 1 · System", exact: true }),
    ).toBeVisible()
    await expect(
      content(page).getByRole("heading", { name: "Message 2 · User", exact: true }),
    ).toBeVisible()
    await expect(
      content(page).getByRole("heading", { name: "Message 3 · Assistant", exact: true }),
    ).toBeVisible()
    await expect(content(page).getByText(untrusted, { exact: true }).first()).toBeVisible()
    await expect(
      content(page).getByText(`Private reasoning ${untrusted}`, { exact: true }),
    ).toBeHidden()
    await content(page).getByText("Thinking", { exact: true }).focus()
    const reads = state.requests.length
    await content(page).getByText("Thinking", { exact: true }).press("Enter")
    await expect(
      content(page).getByText(`Private reasoning ${untrusted}`, { exact: true }),
    ).toBeVisible()
    await expect(content(page)).toContainText(
      "Image omitted · image/png. Image bytes are not sent.",
    )
    await expect(content(page)).toContainText("call-70")
    await expect(content(page)).toContainText("fixture_tool")
    await expect(content(page)).toContainText("Tool output")
    await expect(content(page).getByText("Error", { exact: true })).toBeVisible()
    await expect(content(page).getByText("Not an error", { exact: true })).toBeVisible()
    await expect(content(page).getByText("Arguments (JSON text)", { exact: true })).toBeVisible()
    await expect(inspector(page).locator(".durable-json pre:visible")).toHaveCount(0)
    await page.evaluate(() =>
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            sessionStorage.setItem("copied", text)
          },
        },
      }),
    )
    await inspector(page).getByText("Content JSON for entry 70", { exact: true }).click()
    await inspector(page)
      .getByRole("button", { name: "Copy Content JSON for entry 70", exact: true })
      .click()
    await expect(inspector(page).getByText("JSON copied.", { exact: true })).toBeVisible()
    expect(
      JSON.parse((await page.evaluate(() => sessionStorage.getItem("copied"))) ?? "null"),
    ).toEqual(entryContent)
    await inspector(page).getByText("Metadata JSON for entry 70", { exact: true }).click()
    await inspector(page)
      .getByRole("button", { name: "Copy Metadata JSON for entry 70", exact: true })
      .click()
    const copied = JSON.parse(
      (await page.evaluate(() => sessionStorage.getItem("copied"))) ?? "null",
    )
    expect(copied.id).toBe(70)
    expect(copied.content).toBeUndefined()
    expect(state.requests).toHaveLength(reads)
    expect(remote).toEqual([])
    expect(await inspector(page).locator("img,iframe,script").count()).toBe(0)
    expect(await page.evaluate(() => Object.hasOwn(window, "inspectorInjected"))).toBe(false)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.goBack()
    await expect(content(page)).toHaveCount(0)
    await expect(
      inspector(page).getByRole("link", { name: "Inspect entry 70", exact: true }),
    ).toBeVisible()
  })

test("empty, truncated, and old metadata-only entry details stay distinct", async ({ page }) => {
  const state = await durableFixture(page, "/?section=Durable")
  state.entryContent = { messages: [], truncated: false }
  await page.goto("/?section=Durable&chat=42&view=entries&conversationId=7&objectId=70")
  await expect(content(page)).toContainText("No message content recorded.")
  await expect(content(page)).not.toContainText("Content truncated")
  state.entryContent = {
    truncated: true,
    messages: [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "tool", arguments: '{"partial":' }],
      },
      { role: "toolResult", content: [] },
    ],
  }
  await inspector(page).getByRole("button", { name: "Refresh Durable", exact: true }).click()
  await expect(content(page).getByRole("status")).toContainText("Content truncated")
  await expect(content(page)).toContainText("No content blocks included in this response.")
  await expect(content(page)).not.toContainText("No content blocks recorded.")
  await expect(content(page).locator("pre")).toHaveText('{"partial":')
  state.entryContent = { messages: [], truncated: true }
  await inspector(page).getByRole("button", { name: "Refresh Durable", exact: true }).click()
  await expect(content(page)).toContainText("No message content included in this response.")
  await expect(content(page)).not.toContainText("No message content recorded.")
  state.entryContent = undefined
  await inspector(page).getByRole("button", { name: "Refresh Durable", exact: true }).click()
  await expect(content(page)).toHaveCount(0)
  await expect(detail(page)).toContainText("Only metadata is included.")
  await expect(inspector(page).getByText("Content JSON for entry 70", { exact: true })).toHaveCount(
    0,
  )
  await expect(
    inspector(page).getByRole("link", { name: "Inspect entry 70", exact: true }),
  ).toBeVisible()
})

test("relationship tree groups child tasks and tool results, keeps context visible, and reads documents lazily", async ({
  page,
}) => {
  const state = await durableFixture(page, "/?section=Durable")
  const baseTask = tasks[0]
  if (baseTask?.type !== "task") throw new Error("Missing fixture task")
  state.taskItems = [
    baseTask,
    { ...baseTask, id: 81, kind: "pi.tool", ownerTaskId: 8 },
    { ...baseTask, id: 82, ownerTaskId: 999 },
  ]
  state.entryItems = [
    ...entries,
    {
      type: "entry",
      id: 71,
      conversationId: 7,
      kind: "message",
      byTaskId: 81,
      role: "toolResult",
      toolName: "fixture_tool",
      toolCallId: "call-70",
      isError: false,
    },
    { type: "entry", id: 72, conversationId: 7, kind: "message", role: "user" },
  ]
  await page.goto("/?section=Durable&chat=42")
  await expect(tree(page)).toBeVisible()
  await expect.poll(() => state.requests.length).toBe(2)
  await tree(page).getByText("Conversation 7 · persisted selection", { exact: true }).click()
  await expect(tree(page).getByText("Task 8 · Model response", { exact: true })).toBeVisible()
  await expect(tree(page).getByText("Task 82 · Model response", { exact: true })).toBeVisible()
  await tree(page).getByText("Task 8 · Model response", { exact: true }).click()
  await tree(page).getByText("Task 81 · Tool call · fixture_tool", { exact: true }).click()
  await expect(
    tree(page).getByRole("link", { name: "Entry 71 · Tool result: fixture_tool", exact: true }),
  ).toBeVisible()
  expect(state.requests.filter((url) => url.searchParams.get("view") === "documents")).toHaveLength(
    0,
  )
  await tree(page)
    .getByRole("link", { name: "Entry 71 · Tool result: fixture_tool", exact: true })
    .click()
  await expect(
    detail(page).getByRole("heading", { name: "Tool result: fixture_tool", exact: true }),
  ).toBeVisible()
  await expect(content(page)).toContainText("Tool output")
  await expect(
    tree(page).getByText("Task 81 · Tool call · fixture_tool", { exact: true }),
  ).toBeVisible()
  await tree(page).getByText("Documents for task 81", { exact: true }).click()
  await expect(
    tree(page).getByText("No documents on the loaded page.", { exact: true }),
  ).toBeVisible()
  expect(state.requests.at(-1)?.searchParams.get("scope")).toBe("task")
  expect(state.requests.at(-1)?.searchParams.get("taskId")).toBe("81")
  await tree(page).getByText("Entries without a loaded task", { exact: true }).click()
  await expect(
    tree(page).getByRole("link", { name: "Entry 72 · User message record", exact: true }),
  ).toBeVisible()
  await tree(page).getByText("Task 82 · Model response", { exact: true }).click()
  await expect(tree(page)).toContainText("Parent task 999 is not on the loaded pages.")
  await page.waitForTimeout(100)
  const reads = state.requests.length
  await tree(page).getByText("Task 82 · Model response", { exact: true }).click()
  await tree(page).getByText("Task 82 · Model response", { exact: true }).click()
  expect(state.requests).toHaveLength(reads)
  expect(state.methods.every((method) => method === "GET")).toBe(true)
})

test("tree partial collections have explicit pagination, failure retry, and expiry clears content", async ({
  page,
}) => {
  const state = await durableFixture(page, "/?section=Durable")
  state.taskTruncated = true
  await page.goto("/?section=Durable&chat=42")
  await tree(page).getByText("Conversation 7 · persisted selection", { exact: true }).click()
  await expect(
    tree(page).getByText("Partial tasks · more records may exist.", { exact: true }),
  ).toBeVisible()
  await tree(page).getByRole("button", { name: "Load more tasks", exact: true }).click()
  await expect(
    tree(page).getByRole("button", { name: "Load more tasks", exact: true }),
  ).toHaveCount(0)
  expect(
    state.requests.some((url) => url.searchParams.get("cursor") === "task-history-cursor"),
  ).toBe(true)
  state.failures.set("documents", 503)
  await tree(page).getByText("Documents in conversation 7", { exact: true }).click()
  await expect(tree(page).getByRole("alert")).toContainText("Read failed.")
  state.failures.delete("documents")
  await tree(page).getByRole("button", { name: "Retry documents", exact: true }).click()
  await expect(
    tree(page).getByRole("link", { name: "Model settings · document 101", exact: true }),
  ).toBeVisible()
  await expect(
    tree(page).getByText("This document is not approved for value inspection.", { exact: true }),
  ).toBeVisible()
  await expect(
    tree(page).getByRole("link", { name: "Document · document 102", exact: true }),
  ).toHaveCount(0)
  state.expired = true
  await tree(page).getByText("Session documents", { exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Sign in with passkey", exact: true }),
  ).toBeVisible()
  await expect(tree(page)).toHaveCount(0)
})

test("tree conversation pages are explicit, retained across selections, and cleared on permission failure", async ({
  page,
}) => {
  const state = await durableFixture(page)
  await tree(page).getByRole("button", { name: "Load more conversations", exact: true }).click()
  await expect(tree(page).getByText("Conversation 9", { exact: true })).toBeVisible()
  await tree(page).getByText("Conversation 9", { exact: true }).click()
  await tree(page).getByRole("link", { name: "Inspect conversation 9", exact: true }).click()
  await expect(detail(page)).toContainText("conversation #9")
  await expect(
    tree(page).getByText("Conversation 7 · persisted selection", { exact: true }),
  ).toBeVisible()
  await tree(page).getByText("Conversation 7 · persisted selection", { exact: true }).click()
  await tree(page).getByRole("link", { name: "Inspect conversation 7", exact: true }).click()
  await expect(detail(page)).toContainText("conversation #7")
  await expect(
    tree(page).getByRole("link", { name: "Inspect conversation 9", exact: true }),
  ).toBeVisible()
  // Refresh starts a new bounded tree. A denied page must hide old roots and their children.
  await inspector(page).getByRole("button", { name: "Refresh Durable", exact: true }).click()
  await expect(
    tree(page).getByRole("button", { name: "Load more conversations", exact: true }),
  ).toBeVisible()
  state.failures.set("conversations", 403)
  await tree(page).getByRole("button", { name: "Load more conversations", exact: true }).click()
  await expect(tree(page).getByRole("alert")).toContainText("Permission denied.")
  await expect(
    tree(page).getByText("Conversation 7 · persisted selection", { exact: true }),
  ).toHaveCount(0)
  state.failures.delete("conversations")
  await tree(page).getByRole("button", { name: "Retry conversations", exact: true }).click()
  await expect(tree(page).getByText("Conversation 9", { exact: true })).toBeVisible()
})

test("tree cancels pending collection reads on chat switch and does not keep old roots", async ({
  page,
}) => {
  const state = await durableFixture(page)
  await expect(detail(page)).toContainText("conversation #7")
  let release = () => {}
  state.gates.set(
    "/api/chats/42/durable:list",
    new Promise<void>((resolve) => {
      release = resolve
    }),
  )
  const aborted = page.waitForEvent("requestfailed", (request) =>
    request.url().includes("view=tasks"),
  )
  try {
    await tree(page).getByText("Conversation 7 · persisted selection", { exact: true }).click()
    await expect(tree(page).getByText("Loading tasks…", { exact: true })).toBeVisible()
    await page.evaluate(() => {
      window.history.pushState(null, "", "?section=Durable&chat=43")
      window.dispatchEvent(new PopStateEvent("popstate"))
    })
    await aborted
    await expect(tree(page).getByText("Conversation 17", { exact: true })).toBeVisible()
    await expect(
      tree(page).getByText("Conversation 7 · persisted selection", { exact: true }),
    ).toHaveCount(0)
  } finally {
    release()
  }
  expect(
    state.requests.filter(
      (url) => url.pathname.includes("/42/") && url.searchParams.get("view") === "entries",
    ),
  ).toHaveLength(0)
})
