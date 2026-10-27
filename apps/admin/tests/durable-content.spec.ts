import { expect, type Page, test } from "@playwright/test"
import { durableFixture, entries, entryContent, tasks, untrusted } from "./durable-fixture.js"
import { click, recordLink, reveal } from "./durable-ui.js"

const inspector = (page: Page) =>
  page.getByRole("region", { includeHidden: true, name: "Durable Inspector", exact: true })
const detail = (page: Page) =>
  inspector(page).getByRole("region", {
    includeHidden: true,
    name: "Selected item details",
    exact: true,
  })
const content = (page: Page) =>
  detail(page).getByRole("region", { includeHidden: true, name: "Entry content", exact: true })
const tree = (page: Page) =>
  inspector(page).getByRole("region", {
    includeHidden: true,
    name: "Relationship tree",
    exact: true,
  })

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
    const inspect = inspector(page).getByRole("link", {
      includeHidden: true,
      name: "Inspect entry 70",
      exact: true,
    })
    await expect(inspect).toHaveAttribute(
      "href",
      /view=entries&conversationId=7&taskId=8&objectId=70/,
    )
    await click(inspect)
    await expect(page).toHaveURL(/view=entries&conversationId=7&taskId=8&objectId=70/)
    await expect(content(page)).toBeVisible()
    await expect(content(page).getByRole("heading", { name: "System", exact: true })).toBeVisible()
    await expect(content(page).getByRole("heading", { name: "User", exact: true })).toBeVisible()
    await expect(
      content(page).getByRole("heading", { name: "Assistant", exact: true }),
    ).toBeVisible()
    await expect(content(page).getByText(untrusted, { exact: true }).first()).toBeVisible()
    await expect(
      content(page)
        .locator(".durable-message-text")
        .and(page.getByText(untrusted, { exact: true })),
    ).toBeVisible()
    await expect(content(page).locator(".durable-message-text pre")).toHaveCount(0)
    await expect(content(page).locator(".durable-tool-output").first()).toBeVisible()
    await expect(detail(page)).not.toContainText("Message content is available.")
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
    await expect(content(page).getByText("Recorded error", { exact: true })).toBeVisible()
    await expect(
      content(page).getByText("Recorded result · not an error", { exact: true }),
    ).toBeVisible()
    await expect(
      content(page).getByRole("heading", { name: "Arguments for fixture_tool", exact: true }),
    ).toBeVisible()
    await expect(content(page).getByText("JSON text", { exact: true })).toBeVisible()
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
    await click(inspector(page).getByText("Content JSON for entry 70", { exact: true }))
    await click(
      inspector(page).getByRole("button", {
        includeHidden: true,
        name: "Copy Content JSON for entry 70",
        exact: true,
      }),
    )
    await expect(inspector(page).getByText("JSON copied.", { exact: true })).toBeVisible()
    expect(
      JSON.parse((await page.evaluate(() => sessionStorage.getItem("copied"))) ?? "null"),
    ).toEqual(entryContent)
    await click(inspector(page).getByText("Metadata JSON for entry 70", { exact: true }))
    await click(
      inspector(page).getByRole("button", {
        includeHidden: true,
        name: "Copy Metadata JSON for entry 70",
        exact: true,
      }),
    )
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
    await reveal(
      inspector(page).getByRole("link", {
        includeHidden: true,
        name: "Inspect entry 70",
        exact: true,
      }),
    )
    await expect(
      inspector(page).getByRole("link", {
        includeHidden: true,
        name: "Inspect entry 70",
        exact: true,
      }),
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
  await click(
    inspector(page).getByRole("button", {
      includeHidden: true,
      name: "Refresh records",
      exact: true,
    }),
  )
  await expect(content(page).getByRole("status")).toContainText("Content truncated")
  await expect(content(page)).toContainText("No content blocks included in this response.")
  await expect(content(page)).not.toContainText("No content blocks recorded.")
  await expect(content(page).locator("pre")).toHaveText('{"partial":')
  state.entryContent = { messages: [], truncated: true }
  await click(
    inspector(page).getByRole("button", {
      includeHidden: true,
      name: "Refresh records",
      exact: true,
    }),
  )
  await expect(content(page)).toContainText("No message content included in this response.")
  await expect(content(page)).not.toContainText("No message content recorded.")
  state.entryContent = undefined
  await click(
    inspector(page).getByRole("button", {
      includeHidden: true,
      name: "Refresh records",
      exact: true,
    }),
  )
  await expect(content(page)).toHaveCount(0)
  await expect(detail(page)).toContainText("Only metadata is included.")
  await expect(inspector(page).getByText("Content JSON for entry 70", { exact: true })).toHaveCount(
    0,
  )
  await reveal(
    inspector(page).getByRole("link", {
      includeHidden: true,
      name: "Inspect entry 70",
      exact: true,
    }),
  )
  await expect(
    inspector(page).getByRole("link", {
      includeHidden: true,
      name: "Inspect entry 70",
      exact: true,
    }),
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
  await click(tree(page).getByRole("button", { name: "Expand Conversation 7", exact: true }))
  await expect(recordLink(tree(page), 8)).toContainText("Model response")
  await expect(recordLink(tree(page), 8)).toBeVisible()
  await expect(recordLink(tree(page), 82)).toBeVisible()
  await click(tree(page).getByRole("button", { name: "Expand Model response 8", exact: true }))
  await click(tree(page).getByRole("button", { name: "Expand fixture_tool 81", exact: true }))
  await expect(recordLink(tree(page), 71)).toContainText("Tool result · fixture_tool")
  await expect(recordLink(tree(page), 71)).toBeVisible()
  expect(state.requests.filter((url) => url.searchParams.get("view") === "documents")).toHaveLength(
    0,
  )
  await click(recordLink(tree(page), 71))
  await expect(
    detail(page).getByRole("heading", { name: "Tool result · fixture_tool", exact: true }),
  ).toBeVisible()
  await expect(recordLink(tree(page), 71)).toHaveAttribute("aria-current", "true")
  await expect(content(page)).toContainText("Tool output")
  await expect(recordLink(tree(page), 81)).toContainText("fixture_tool")
  await expect(recordLink(tree(page), 81)).toBeVisible()
  await click(tree(page).getByText("Documents for task 81", { exact: true }))
  await expect(
    tree(page).getByText("No documents on the loaded page.", { exact: true }),
  ).toBeVisible()
  expect(state.requests.at(-1)?.searchParams.get("scope")).toBe("task")
  expect(state.requests.at(-1)?.searchParams.get("taskId")).toBe("81")
  await click(tree(page).getByText("Entries without a loaded task", { exact: true }))
  await expect(recordLink(tree(page), 72)).toContainText("User message")
  await expect(recordLink(tree(page), 72)).toBeVisible()
  await click(tree(page).getByRole("button", { name: "Expand Model response 82", exact: true }))
  await expect(tree(page)).toContainText("Parent task 999 is not on the loaded pages.")
  await page.waitForTimeout(100)
  const reads = state.requests.length
  await click(tree(page).getByRole("button", { name: "Collapse Model response 82", exact: true }))
  await click(tree(page).getByRole("button", { name: "Expand Model response 82", exact: true }))
  expect(state.requests).toHaveLength(reads)
  expect(state.methods.every((method) => method === "GET")).toBe(true)
})

test("tree partial collections have explicit pagination, failure retry, and expiry clears content", async ({
  page,
}) => {
  const state = await durableFixture(page, "/?section=Durable")
  state.taskTruncated = true
  await page.goto("/?section=Durable&chat=42")
  await click(tree(page).getByRole("button", { name: "Expand Conversation 7", exact: true }))
  await expect(
    tree(page).getByText("Partial tasks: more records may exist.", { exact: true }),
  ).toBeVisible()
  await click(
    tree(page).getByRole("button", { includeHidden: true, name: "Load more tasks", exact: true }),
  )
  await expect(
    tree(page).getByRole("button", { includeHidden: true, name: "Load more tasks", exact: true }),
  ).toHaveCount(0)
  expect(
    state.requests.some((url) => url.searchParams.get("cursor") === "task-history-cursor"),
  ).toBe(true)
  state.failures.set("documents", 503)
  await click(tree(page).getByText("Documents in conversation 7", { exact: true }))
  await expect(tree(page).getByRole("alert")).toContainText("Read failed.")
  state.failures.delete("documents")
  await click(
    tree(page).getByRole("button", { includeHidden: true, name: "Retry documents", exact: true }),
  )
  await expect(recordLink(tree(page), 101)).toContainText("Model settings")
  await expect(recordLink(tree(page), 101)).toBeVisible()
  await expect(
    tree(page).getByText("This document is not approved for value inspection.", { exact: true }),
  ).toBeVisible()
  await expect(recordLink(tree(page), 102)).toHaveCount(0)
  state.expired = true
  await click(tree(page).getByText("Session documents", { exact: true }))
  await expect(
    page.getByRole("button", { includeHidden: true, name: "Sign in with passkey", exact: true }),
  ).toBeVisible()
  await expect(tree(page)).toHaveCount(0)
})

test("tree conversation pages are explicit, retained across selections, and cleared on permission failure", async ({
  page,
}) => {
  const state = await durableFixture(page)
  await click(
    tree(page).getByRole("button", {
      includeHidden: true,
      name: "Load more conversations",
      exact: true,
    }),
  )
  await expect(recordLink(tree(page), 9)).toContainText("Conversation")
  await expect(recordLink(tree(page), 9)).toBeVisible()
  await click(recordLink(tree(page), 9))
  await expect(detail(page)).toContainText("conversation #9")
  await expect(recordLink(tree(page), 9)).toHaveAttribute("aria-current", "true")
  await expect(recordLink(tree(page), 7)).toContainText("Persisted selection")
  await expect(recordLink(tree(page), 7)).toBeVisible()
  await click(recordLink(tree(page), 7))
  await expect(detail(page)).toContainText("conversation #7")
  await expect(recordLink(tree(page), 7)).toHaveAttribute("aria-current", "true")
  await expect(recordLink(tree(page), 9)).toBeVisible()
  // Refresh starts a new bounded tree. A denied page must hide old roots and their children.
  await click(
    inspector(page).getByRole("button", {
      includeHidden: true,
      name: "Refresh records",
      exact: true,
    }),
  )
  await expect(
    tree(page).getByRole("button", {
      includeHidden: true,
      name: "Load more conversations",
      exact: true,
    }),
  ).toBeVisible()
  state.failures.set("conversations", 403)
  await click(
    tree(page).getByRole("button", {
      includeHidden: true,
      name: "Load more conversations",
      exact: true,
    }),
  )
  await expect(tree(page).getByRole("alert")).toContainText("Permission denied.")
  await expect(recordLink(tree(page), 7)).toHaveCount(0)
  state.failures.delete("conversations")
  await click(
    tree(page).getByRole("button", {
      includeHidden: true,
      name: "Retry conversations",
      exact: true,
    }),
  )
  await expect(recordLink(tree(page), 9)).toBeVisible()
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
    await click(tree(page).getByRole("button", { name: "Expand Conversation 7", exact: true }))
    await expect(tree(page).getByText("Loading tasks…", { exact: true })).toBeVisible()
    await page.evaluate(() => {
      window.history.pushState(null, "", "?section=Durable&chat=43")
      window.dispatchEvent(new PopStateEvent("popstate"))
    })
    await aborted
    await expect(recordLink(tree(page), 17)).toBeVisible()
    await expect(recordLink(tree(page), 7)).toHaveCount(0)
  } finally {
    release()
  }
  expect(
    state.requests.filter(
      (url) => url.pathname.includes("/42/") && url.searchParams.get("view") === "entries",
    ),
  ).toHaveLength(0)
})
