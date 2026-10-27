import { expect, type Locator, type Page, test } from "@playwright/test"
import {
  conversations,
  durableFixture,
  historicalConversation,
  navigateSection,
  untrusted,
} from "./durable-fixture.js"
import { click, openDisclosure, rawTab, reveal } from "./durable-ui.js"

const inspectorFor = (page: Page) =>
  page.getByRole("region", { includeHidden: true, name: "Durable Inspector", exact: true })
const detailsFor = (page: Page) =>
  inspectorFor(page).getByRole("region", {
    includeHidden: true,
    name: "Selected item details",
    exact: true,
  })
const contextFor = (page: Page) =>
  inspectorFor(page).getByRole("region", {
    includeHidden: true,
    name: "Inspection context",
    exact: true,
  })
const field = (scope: Locator, label: string) =>
  scope
    .locator("dt")
    .filter({ hasText: new RegExp(`^${label}$`) })
    .locator("+ dd")
const expectRecord = async (page: Page, title: string, identifier: string) => {
  await expect(detailsFor(page).getByRole("heading", { name: title, exact: true })).toBeVisible()
  const identifierLocator =
    (page.viewportSize()?.width ?? 1280) >= 1100
      ? detailsFor(page).getByText(identifier, { exact: true })
      : inspectorFor(page).locator(".durable-browse-current")
  await expect(identifierLocator).toHaveText(identifier)
  await expect(identifierLocator).toBeVisible()
}

for (const width of [1440, 390, 320]) {
  test(`record browser and secondary disclosures keep their defaults at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    const state = await durableFixture(page)
    await expectRecord(page, "Conversation", "conversation #7")
    const inspector = inspectorFor(page)
    const compactSelection = inspector.getByRole("region", {
      name: "Persisted selection",
      exact: true,
    })
    await expect(compactSelection).toBeVisible()
    await expect(compactSelection).toContainText("Conversation 7")
    const browser = inspector.locator(".durable-record-browser")
    if (width >= 1100) await expect(browser).toHaveAttribute("open", "")
    else await expect(browser).not.toHaveAttribute("open", "")
    for (const selector of [
      ".durable-history-context",
      ".durable-raw-collections",
      ".durable-record-details",
      ".durable-raw-data",
      ".durable-advanced",
      ".durable-limits",
    ])
      await expect(inspector.locator(selector)).not.toHaveAttribute("open", "")
    const reads = state.requests.length
    await reveal(
      inspector.getByRole("region", {
        name: "Relationship tree",
        includeHidden: true,
        exact: true,
      }),
    )
    await expect(
      inspector.getByRole("region", { name: "Relationship tree", exact: true }),
    ).toBeVisible()
    await openDisclosure(inspector.locator(".durable-raw-collections"))
    await expect(
      inspector.getByRole("tablist", { name: "Durable object views", exact: true }),
    ).toBeVisible()
    await expect(
      inspector.getByRole("region", { name: "Selected item details", exact: true }),
    ).toHaveCount(1)
    await page.waitForTimeout(150)
    expect(state.requests).toHaveLength(reads)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })

  test(`loaded, idle, and unloaded chat smoke at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const state = await durableFixture(page)
    const inspector = inspectorFor(page)
    await expectRecord(page, "Conversation", "conversation #7")
    await openDisclosure(inspector.locator(".durable-history-context"))
    await expect(
      inspector.getByRole("region", {
        includeHidden: true,
        name: "Persisted selection details",
        exact: true,
      }),
    ).toContainText("2026-10-19 12:00:00 UTC")
    await expect(inspector.getByRole("heading", { name: "Loaded chat", exact: true })).toBeVisible()
    await expect(
      inspector.getByRole("region", {
        includeHidden: true,
        name: "Selected conversation task history",
        exact: true,
      }),
    ).toContainText("1 task record on the loaded page")
    await expect(
      inspector.getByText(/Truncated: the server read limit/).filter({ visible: true }),
    ).toBeVisible()
    await click(
      page.getByRole("button", { includeHidden: true, name: "Open chat settings", exact: true }),
    )
    const back = page.getByRole("button", {
      includeHidden: true,
      name: "Back to chat directory",
      exact: true,
    })
    if (await back.isVisible()) await back.click()
    await click(
      page
        .getByRole("list", { includeHidden: true, name: "Chats on this page" })
        .getByRole("button", { includeHidden: true, name: /Idle chat/ }),
    )
    if (width <= 850) {
      await page.getByRole("button", { name: "Chat actions", exact: true }).click()
      await page.getByRole("menuitem", { name: "View conversation records", exact: true }).click()
    } else await page.getByRole("link", { name: "View conversation records", exact: true }).click()
    await expectRecord(page, "Conversation", "conversation #17")
    await click(
      page.getByRole("button", { includeHidden: true, name: "Open chat settings", exact: true }),
    )
    if (await back.isVisible()) await back.click()
    await click(
      page
        .getByRole("list", { includeHidden: true, name: "Chats on this page" })
        .getByRole("button", { includeHidden: true, name: /Unloaded chat/ }),
    )
    if (width <= 850) {
      await page.getByRole("button", { name: "Chat actions", exact: true }).click()
      await page.getByRole("menuitem", { name: "View conversation records", exact: true }).click()
    } else await page.getByRole("link", { name: "View conversation records", exact: true }).click()
    await expect(inspector.getByRole("heading", { name: "Not loaded", exact: true })).toBeVisible()
    await expect(inspector).toContainText("Inspection will not open its database")
    expect(state.methods.every((method) => method === "GET")).toBe(true)
    await page.waitForTimeout(150)
    expect(state.requests).toHaveLength(4)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}

test("default reading answers context, selection, recorded outcomes, and related navigation without JSON or new reads", async ({
  page,
}) => {
  const state = await durableFixture(page)
  const inspector = inspectorFor(page)
  const context = contextFor(page)
  const detail = detailsFor(page)
  const history = inspector.getByRole("region", {
    includeHidden: true,
    name: "Selected conversation task history",
    exact: true,
  })
  for (const selector of [
    ".durable-history-context",
    ".durable-raw-collections",
    ".durable-record-details",
    ".durable-raw-data",
    ".durable-advanced",
    ".durable-limits",
  ])
    await expect(inspector.locator(selector)).not.toHaveAttribute("open", "")
  await expect(context).toBeHidden()
  await expect(detail.locator(".durable-detail-heading")).toBeVisible()
  await reveal(context)
  await expect(context.getByRole("heading", { name: "Inspecting conversation 7" })).toBeVisible()
  await expect(context).toContainText("This is the persisted selected conversation.")
  await expect(context).toContainText("Selection does not mean work is running.")
  await expect(history).toContainText("Model response, Recorded outcome: Completed")
  await expect(history).toContainText("1 task record on the loaded page")
  // The requested conversation page reuses the selection response, not a third read block.
  await expect(inspector.locator(".durable-read-time")).toHaveCount(2)
  await expect(
    history.getByRole("link", { includeHidden: true, name: "Task 8", exact: true }),
  ).toHaveAttribute("href", /view=tasks&conversationId=7&objectId=8/)
  await expect(detail).toContainText("Branched from conversation 6 at entry 60.")
  for (const name of ["Tasks", "Documents", "Entries"])
    await expect(
      detail.getByRole("link", {
        includeHidden: true,
        name: `${name} in conversation 7`,
        exact: true,
      }),
    ).toBeVisible()
  await reveal(
    detail.getByRole("link", { includeHidden: true, name: "Fork entry 60", exact: true }),
  )
  await expect(
    detail.getByRole("link", { includeHidden: true, name: "Fork entry 60", exact: true }),
  ).toBeVisible()
  await expect(
    detail.getByRole("link", {
      includeHidden: true,
      name: "Task 4 in conversation 6",
      exact: true,
    }),
  ).toBeVisible()
  await expect(inspector.locator("pre:visible")).toHaveCount(0)
  await expect(inspector.getByLabel("Conversation ID", { exact: true })).toBeHidden()
  expect(state.requests).toHaveLength(2)
  for (const label of ["Data scope and limits", "Advanced inspection"])
    await click(inspector.getByText(label, { exact: true }))
  await openDisclosure(inspector.locator(".durable-record-details"))
  await expect(inspector).toContainText("at most one conversation page")
  await expect(inspector.locator("pre:visible")).toHaveCount(0)
  await click(inspector.getByText("Metadata JSON for conversation 7", { exact: true }))
  await expect(inspector.locator("pre")).toContainText('"active": true')
  await page.waitForTimeout(150)
  expect(state.requests).toHaveLength(2)
  expect(state.requests.every((url) => !url.searchParams.has("objectId"))).toBe(true)
})

test("all four views, approved fields and JSON, scopes, named relationships, and safe text", async ({
  page,
}) => {
  const state = await durableFixture(page)
  const inspector = inspectorFor(page)
  await click(inspector.getByText("Metadata JSON for conversation 7", { exact: true }))
  await expect(inspector.locator("pre")).toContainText('"active": true')
  await expect(
    detailsFor(page).getByRole("link", {
      includeHidden: true,
      name: "Conversation 6",
      exact: true,
    }),
  ).toHaveAttribute("href", /view=conversations&objectId=6/)
  await click(
    inspector.getByRole("link", {
      includeHidden: true,
      name: "Tasks in conversation 7",
      exact: true,
    }),
  )
  await expect(page).toHaveURL(/view=tasks&conversationId=7/)
  await expectRecord(page, "Model response", "task #8")
  await expect(detailsFor(page)).toContainText("Recorded outcome: completed")
  await openDisclosure(inspector.locator(".durable-record-details"))
  await expect(field(detailsFor(page), "Started")).toHaveText("2026-10-19 11:59:00 UTC")
  await expect(field(detailsFor(page), "Ended")).toHaveText("2026-10-19 11:59:30 UTC")
  await reveal(
    detailsFor(page).getByRole("link", { includeHidden: true, name: "Task 5", exact: true }),
  )
  await expect(
    detailsFor(page).getByRole("link", { includeHidden: true, name: "Task 5", exact: true }),
  ).toBeVisible()
  await click(inspector.getByText("Metadata JSON for task 8", { exact: true }))
  await expect(inspector.locator("pre")).toContainText('"outcome": "completed"')
  await click(
    inspector.getByRole("link", { includeHidden: true, name: "Documents for task 8", exact: true }),
  )
  await expect(
    inspector.getByRole("combobox", { includeHidden: true, name: "Document scope", exact: true }),
  ).toHaveText("Task")
  await expect(
    inspector
      .locator(".durable-selected-area > div")
      .getByText("No records in this view.", { exact: true }),
  ).toBeVisible()
  expect(state.requests.at(-1)?.searchParams.get("taskId")).toBe("8")
  await expect(
    inspector.getByRole("link", { includeHidden: true, name: /Inspect document/ }),
  ).toHaveCount(0)
  await click(
    inspector.getByRole("combobox", { includeHidden: true, name: "Document scope", exact: true }),
  )
  await click(page.getByRole("option", { includeHidden: true, name: "Conversation", exact: true }))
  await click(
    inspector.getByRole("button", {
      includeHidden: true,
      name: "Select Document (document 102)",
      exact: true,
    }),
  )
  await expect(detailsFor(page)).toContainText(
    "This document is not approved for value inspection.",
  )
  await expect(
    inspector.getByRole("link", { includeHidden: true, name: "Inspect document 102", exact: true }),
  ).toHaveCount(0)
  const beforeExpand = state.requests.length
  await click(inspector.getByText("Metadata JSON for document 102", { exact: true }))
  await expect(inspector.locator(".durable-json[open] > pre")).toContainText(
    '"withheldReason": "unknown-kind"',
  )
  expect(state.requests).toHaveLength(beforeExpand)
  await click(
    inspector.getByRole("link", { includeHidden: true, name: "Inspect document 103", exact: true }),
  )
  await expectRecord(page, "Model usage", "document #103")
  await expect(detailsFor(page)).toContainText("The document value is unavailable.")
  await expect(
    inspector.getByRole("region", { includeHidden: true, name: "Approved document fields" }),
  ).toHaveCount(0)
  await click(
    inspector
      .locator(".durable-raw-collections")
      .getByRole("link", { includeHidden: true, name: "Back to documents", exact: true }),
  )
  await click(
    inspector.getByRole("link", { includeHidden: true, name: "Inspect document 101", exact: true }),
  )
  await expectRecord(page, "Model settings", "document #101")
  const approved = inspector.getByRole("region", {
    includeHidden: true,
    name: "Approved document fields",
    exact: true,
  })
  await expect(field(approved, "Model provider")).toHaveText("fixture")
  await expect(field(approved, "Model")).toHaveText(untrusted)
  await expect(field(approved, "Thinking level")).toHaveText("low")
  await click(inspector.getByText("Approved value JSON for document 101", { exact: true }))
  await expect(inspector.locator("pre").last()).toContainText("untrusted.invalid")
  expect(await inspector.locator("img, iframe, script").count()).toBe(0)
  expect(await page.evaluate(() => Object.hasOwn(window, "inspectorInjected"))).toBe(false)
  state.documentLimit = true
  await click(
    inspector.getByRole("button", { includeHidden: true, name: "Refresh records", exact: true }),
  )
  await expect(detailsFor(page)).toContainText(
    "The document value is withheld because it exceeds inspection limits.",
  )
  await expect(approved).toHaveCount(0)
  await click(rawTab(inspector, "Entries"))
  await expectRecord(page, "Assistant message", "entry #70")
  await expect(detailsFor(page)).toContainText(
    "Only metadata is included. Inspect this entry to read message content.",
  )
  await openDisclosure(inspector.locator(".durable-record-details"))
  await expect(field(detailsFor(page), "Recorded at")).toHaveText("2026-10-19 11:59:30 UTC")
  await click(inspector.getByText("Metadata JSON for entry 70", { exact: true }))
  await expect(inspector.locator("pre")).toContainText('"role": "assistant"')
  await click(
    detailsFor(page)
      .locator(".durable-record-details")
      .getByRole("link", { includeHidden: true, name: "Task 8", exact: true }),
  )
  await expect(page).toHaveURL(/view=tasks&conversationId=7&objectId=8/)
  expect(state.requests.every((url) => url.searchParams.get("limit") === "25")).toBe(true)
  expect(state.methods.every((method) => method === "GET")).toBe(true)
})

for (const selected of ["persisted", "null", "undefined"] as const) {
  for (const view of ["tasks", "documents", "entries"] as const) {
    test(`historical second-page conversation 9 remains the ${view} target with ${selected} selection metadata`, async ({
      page,
    }) => {
      const state = await durableFixture(page, "/?section=Durable")
      if (selected !== "persisted")
        state.selectedConversation = selected === "null" ? null : undefined
      await page.goto("/?section=Durable&chat=42")
      const inspector = inspectorFor(page)
      await click(
        inspector.getByRole("button", { includeHidden: true, name: "Next objects", exact: true }),
      )
      await expectRecord(page, "Conversation", "conversation #9")
      await reveal(contextFor(page))
      await expect(contextFor(page)).toContainText("Inspecting conversation 9")
      await reveal(contextFor(page))
      await expect(contextFor(page)).toContainText(
        selected === "persisted"
          ? "This is not the persisted selected conversation (conversation 7)."
          : "Persisted selection cannot be confirmed from the available metadata.",
      )
      await click(rawTab(inspector, view[0]?.toUpperCase() + view.slice(1)))
      await expect(page).toHaveURL(new RegExp(`view=${view}&conversationId=9`))
      await expect(page).not.toHaveURL(/objectId=/)
      await expect(
        inspector
          .locator(".durable-selected-area > div")
          .getByText("No records in this view.", { exact: true }),
      ).toBeVisible()
      expect(state.requests.at(-1)?.searchParams.get("conversationId")).toBe("9")
      if (view === "documents")
        expect(state.requests.at(-1)?.searchParams.get("scope")).toBe("conversation")
      await reveal(contextFor(page))
      await expect(contextFor(page)).toContainText("Inspecting conversation 9")
      await click(
        inspector.getByRole("button", {
          includeHidden: true,
          name: "Refresh records",
          exact: true,
        }),
      )
      await expect(
        inspector
          .locator(".durable-selected-area > div")
          .getByText("No records in this view.", { exact: true }),
      ).toBeVisible()
      expect(state.requests.at(-1)?.searchParams.get("conversationId")).toBe("9")
      await reveal(contextFor(page))
      await expect(contextFor(page)).toContainText("Inspecting conversation 9")
      const selection = inspector.getByRole("region", {
        includeHidden: true,
        name: "Persisted selection details",
        exact: true,
      })
      await expect(selection).toContainText(
        selected === "persisted"
          ? "Conversation 7"
          : selected === "null"
            ? "No selected-conversation metadata available."
            : "Selection data unavailable.",
      )
      expect(state.methods.every((method) => method === "GET")).toBe(true)
    })
  }
}

test("direct Conversation ID lookup retrieves off-page conversation 9 by objectId and survives refresh, reload, back, and forward", async ({
  page,
}) => {
  const state = await durableFixture(page)
  const inspector = inspectorFor(page)
  await expectRecord(page, "Conversation", "conversation #7")
  await click(inspector.getByText("Advanced inspection", { exact: true }))
  await inspector.getByLabel("Conversation ID", { exact: true }).fill("9")
  await click(
    inspector.getByRole("button", { includeHidden: true, name: "Inspect IDs", exact: true }),
  )
  await expect(page).toHaveURL(/view=conversations&objectId=9/)
  await expectRecord(page, "Conversation", "conversation #9")
  expect(state.requests.at(-1)?.searchParams.get("objectId")).toBe("9")
  expect(state.requests.at(-1)?.searchParams.has("conversationId")).toBe(false)
  expect(state.requests.at(-1)?.searchParams.has("cursor")).toBe(false)
  await click(
    inspector.getByRole("button", { includeHidden: true, name: "Refresh records", exact: true }),
  )
  await expectRecord(page, "Conversation", "conversation #9")
  await page.reload()
  await expectRecord(page, "Conversation", "conversation #9")
  await click(
    detailsFor(page).getByRole("link", {
      includeHidden: true,
      name: "Entries in conversation 9",
      exact: true,
    }),
  )
  await expect(page).toHaveURL(/view=entries&conversationId=9/)
  await expect(
    inspector
      .locator(".durable-selected-area > div")
      .getByText("No records in this view.", { exact: true }),
  ).toBeVisible()
  await reveal(contextFor(page))
  await expect(contextFor(page)).toContainText("Inspecting conversation 9")
  await page.goBack()
  await expectRecord(page, "Conversation", "conversation #9")
  await reveal(contextFor(page))
  await expect(contextFor(page)).toContainText("Inspecting conversation 9")
  await page.goForward()
  await expect(page).toHaveURL(/view=entries&conversationId=9/)
  await expect(
    inspector
      .locator(".durable-selected-area > div")
      .getByText("No records in this view.", { exact: true }),
  ).toBeVisible()
  await reveal(contextFor(page))
  await expect(contextFor(page)).toContainText("Inspecting conversation 9")
  await expect(
    inspector.getByRole("region", {
      includeHidden: true,
      name: "Persisted selection details",
      exact: true,
    }),
  ).toContainText("Conversation 7")
})

for (const view of ["Tasks", "Documents", "Entries"]) {
  test(`changing the selected row on a multi-item page targets that row in ${view}`, async ({
    page,
  }) => {
    const state = await durableFixture(page, "/?section=Durable")
    state.conversationItems = [
      ...conversations,
      historicalConversation,
      { type: "conversation", id: 10, active: false },
    ]
    await page.goto("/?section=Durable&chat=42")
    const inspector = inspectorFor(page)
    await expectRecord(page, "Conversation", "conversation #7")
    const reads = state.requests.length
    await click(
      inspector.getByRole("button", {
        includeHidden: true,
        name: "Select Conversation (conversation 9)",
        exact: true,
      }),
    )
    await reveal(contextFor(page))
    await expect(contextFor(page)).toContainText("Inspecting conversation 9")
    await expectRecord(page, "Conversation", "conversation #9")
    await click(
      inspector.getByRole("button", {
        includeHidden: true,
        name: "Select Conversation (conversation 10)",
        exact: true,
      }),
    )
    await reveal(contextFor(page))
    await expect(contextFor(page)).toContainText("Inspecting conversation 10")
    await expectRecord(page, "Conversation", "conversation #10")
    expect(state.requests).toHaveLength(reads)
    await click(rawTab(inspector, view))
    await expect(page).toHaveURL(new RegExp(`view=${view.toLowerCase()}&conversationId=10`))
    await expect(
      inspector
        .locator(".durable-selected-area > div")
        .getByText("No records in this view.", { exact: true }),
    ).toBeVisible()
    expect(state.requests.at(-1)?.searchParams.get("conversationId")).toBe("10")
    await reveal(contextFor(page))
    await expect(contextFor(page)).toContainText("Inspecting conversation 10")
  })
}

for (const view of ["tasks", "documents", "entries"] as const) {
  for (const hasSelection of [true, false]) {
    test(`historical target survives ${view} to Conversations and back with selection ${hasSelection}`, async ({
      page,
    }) => {
      const state = await durableFixture(page, "/?section=Durable")
      if (!hasSelection) state.selectedConversation = null
      await page.goto("/?section=Durable&chat=42&view=conversations&objectId=9")
      await expectRecord(page, "Conversation", "conversation #9")
      const inspector = inspectorFor(page)
      const tab = view[0]?.toUpperCase() + view.slice(1)
      await click(rawTab(inspector, tab))
      await expect(page).toHaveURL(new RegExp(`view=${view}&conversationId=9`))
      await expect(
        inspector
          .locator(".durable-selected-area > div")
          .getByText("No records in this view.", { exact: true }),
      ).toBeVisible()
      await click(rawTab(inspector, "Conversations"))
      await expectRecord(page, "Conversation", "conversation #9")
      await expect(page).toHaveURL(/view=conversations&objectId=9/)
      await reveal(contextFor(page))
      await expect(contextFor(page)).toContainText("Inspecting conversation 9")
      await click(rawTab(inspector, tab))
      await expect(
        inspector
          .locator(".durable-selected-area > div")
          .getByText("No records in this view.", { exact: true }),
      ).toBeVisible()
      await expect(page).toHaveURL(new RegExp(`view=${view}&conversationId=9`))
      expect(state.requests.at(-1)?.searchParams.get("conversationId")).toBe("9")
    })
  }
}

test("record buttons expose readable names and stored observations to assistive technology", async ({
  page,
}) => {
  await durableFixture(page, "/?section=Durable&chat=42&view=tasks&conversationId=7")
  const button = inspectorFor(page).getByRole("button", {
    includeHidden: true,
    name: "Select Model response (task 8)",
    exact: true,
  })
  await expect(button).toHaveAccessibleDescription(/Recorded outcome: Completed/)
  await expect(button).toHaveAccessibleDescription(/not live execution state/)
})

test("approved document kinds with family membership explain value restrictions without blaming the kind", async ({
  page,
}) => {
  const state = await durableFixture(page, "/?section=Durable")
  state.documentItems = [
    {
      type: "document",
      id: 401,
      kind: "pi.agent",
      family: true,
      scope: { kind: "conversation", conversationId: 7 },
      createdAt: 110,
      valueState: "withheld",
      withheldReason: "unknown-kind",
    },
  ]
  await page.goto("/?section=Durable&chat=42&view=documents&scope=conversation&conversationId=7")
  await expectRecord(page, "Model settings", "document #401")
  await expect(detailsFor(page)).toContainText(
    "This document is not approved for value inspection.",
  )
  await expect(
    inspectorFor(page).getByRole("link", { includeHidden: true, name: /Inspect document/ }),
  ).toHaveCount(0)
  await openDisclosure(inspectorFor(page).locator(".durable-record-details"))
  await expect(field(detailsFor(page), "Family member")).toHaveText("Yes")
  expect(state.requests).toHaveLength(3)
})

test("opaque pagination, previous page, manual refresh, and browser back", async ({ page }) => {
  const state = await durableFixture(page)
  const inspector = inspectorFor(page)
  const previous = inspector.getByRole("button", {
    includeHidden: true,
    name: "Previous objects",
    exact: true,
  })
  await expect(previous).toBeDisabled()
  await click(
    inspector.getByRole("button", { includeHidden: true, name: "Next objects", exact: true }),
  )
  await expectRecord(page, "Conversation", "conversation #9")
  expect(
    state.requests
      .filter((url) => url.searchParams.get("view") === "conversations")
      .at(-1)
      ?.searchParams.get("cursor"),
  ).toBe("opaque+/=token")
  await expect(
    inspector.getByRole("button", { includeHidden: true, name: "Next objects", exact: true }),
  ).toBeDisabled()
  await click(previous)
  await expectRecord(page, "Conversation", "conversation #7")
  await click(
    inspector.getByRole("button", { includeHidden: true, name: "Next objects", exact: true }),
  )
  await expectRecord(page, "Conversation", "conversation #9")
  await click(
    inspector.getByRole("button", { includeHidden: true, name: "Refresh records", exact: true }),
  )
  await expectRecord(page, "Conversation", "conversation #7")
  await expect(previous).toBeDisabled()
  const count = state.requests.length
  await page.waitForTimeout(250)
  expect(state.requests).toHaveLength(count)
  await click(
    inspector.getByRole("link", {
      includeHidden: true,
      name: "Entries in conversation 7",
      exact: true,
    }),
  )
  await expectRecord(page, "Assistant message", "entry #70")
  await page.goBack()
  await expectRecord(page, "Conversation", "conversation #7")
})

test("deep links, context validation, distinct empty and read failure states", async ({ page }) => {
  const state = await durableFixture(
    page,
    "/?section=Durable&chat=42&view=documents&scope=session&objectId=201",
  )
  const inspector = inspectorFor(page)
  await expect(
    inspector.getByRole("region", { includeHidden: true, name: "Approved document fields" }),
  ).toBeVisible()
  await openDisclosure(inspector.locator(".durable-history-context"))
  state.selectedConversation = null
  await click(
    inspector.getByRole("button", { includeHidden: true, name: "Refresh records", exact: true }),
  )
  await expect(
    inspector.getByText("No selected-conversation metadata available.", { exact: true }),
  ).toBeVisible()
  await click(rawTab(inspector, "Tasks"))
  await expect(
    inspector
      .locator(".durable-selected-area > div")
      .getByText("Select a conversation to inspect this view.", { exact: true }),
  ).toBeVisible()
  await expect(
    inspector.getByText("No selected-conversation metadata available.", { exact: true }),
  ).toBeVisible()
  const beforeInvalid = state.requests.length
  await click(inspector.getByText("Advanced inspection", { exact: true }))
  await inspector.getByLabel("Conversation ID", { exact: true }).fill("07")
  await click(
    inspector.getByRole("button", { includeHidden: true, name: "Inspect IDs", exact: true }),
  )
  await expect(inspector.getByRole("alert")).toContainText("positive whole-number")
  expect(state.requests).toHaveLength(beforeInvalid)
  state.empty = true
  await inspector.getByLabel("Conversation ID", { exact: true }).fill("7")
  await click(
    inspector.getByRole("button", { includeHidden: true, name: "Inspect IDs", exact: true }),
  )
  await expect(
    inspector
      .locator(".durable-selected-area > div")
      .getByText("No records in this view.", { exact: true }),
  ).toBeVisible()
  state.failed = true
  await click(
    inspector.getByRole("button", { includeHidden: true, name: "Refresh records", exact: true }),
  )
  await expect(inspector.getByRole("alert").last()).toHaveText("Read failed. Refresh to retry.")
  state.failed = false
  state.empty = false
  await click(
    inspector.getByRole("button", { includeHidden: true, name: "Refresh records", exact: true }),
  )
  await expectRecord(page, "Model response", "task #8")
})

test("approved usage fields keep zero, missing totals, per-model values, and reported costs distinct without JSON", async ({
  page,
}) => {
  const state = await durableFixture(page, "/?section=Durable")
  state.usageAvailable = true
  await page.goto("/?section=Durable&chat=42&view=documents&scope=conversation&conversationId=7")
  const inspector = inspectorFor(page)
  await reveal(
    inspector.getByRole("link", { includeHidden: true, name: "Inspect document 103", exact: true }),
  )
  await expect(
    inspector.getByRole("link", { includeHidden: true, name: "Inspect document 103", exact: true }),
  ).toBeVisible()
  expect(state.requests).toHaveLength(3)
  expect(state.requests.some((url) => url.searchParams.has("objectId"))).toBe(false)
  await expect(
    inspector.getByRole("region", { includeHidden: true, name: "Approved document fields" }),
  ).toHaveCount(0)
  await click(
    inspector.getByRole("link", { includeHidden: true, name: "Inspect document 103", exact: true }),
  )
  await expectRecord(page, "Model usage", "document #103")
  const approved = inspector.getByRole("region", {
    includeHidden: true,
    name: "Approved document fields",
    exact: true,
  })
  await expect(approved.getByRole("heading", { name: "Total usage", exact: true })).toBeVisible()
  // The first fields are the total; the remaining groups belong to each named model.
  await expect(field(approved, "Input tokens").nth(0)).toHaveText("0")
  await expect(field(approved, "Output tokens").nth(0)).toHaveText("Not recorded")
  await expect(field(approved, "Total tokens").nth(0)).toHaveText("0")
  await expect(field(approved, "Total cost \\(reported\\)").nth(0)).toHaveText("0")
  const modelA = approved.locator("details").filter({
    has: page.getByText("fixture/model-a, 15 total tokens", { exact: true }),
  })
  await click(modelA.locator("summary"))
  await expect(field(modelA, "Input tokens")).toHaveText("12")
  await expect(field(modelA, "Output tokens")).toHaveText("3")
  await expect(field(modelA, "Total tokens")).toHaveText("15")
  await expect(field(modelA, "Cache read tokens")).toHaveText("Not recorded")
  await expect(field(modelA, "Input cost \\(reported\\)")).toHaveText("0.001")
  await expect(field(modelA, "Output cost \\(reported\\)")).toHaveText("0.002")
  await expect(field(modelA, "Total cost \\(reported\\)")).toHaveText("0.003")
  const modelB = approved.locator("details").filter({
    has: page.getByText("fixture/model-b, Total not recorded", { exact: true }),
  })
  await click(modelB.locator("summary"))
  await expect(field(modelB, "Input tokens")).toHaveText("Not recorded")
  await expect(field(modelB, "Output tokens")).toHaveText("0")
  await expect(field(modelB, "Total tokens")).toHaveText("Not recorded")
  await expect(field(modelB, "Output cost \\(reported\\)")).toHaveText("0")
  await expect(field(modelB, "Total cost \\(reported\\)")).toHaveText("Not recorded")
  await expect(inspector.locator("pre:visible")).toHaveCount(0)
  expect(state.requests).toHaveLength(6)
  await openDisclosure(inspector.locator(".durable-record-details"))
  await expect(field(detailsFor(page), "Created sequence")).toHaveText("102")
  await expect(detailsFor(page)).not.toContainText("1970-")
  await click(inspector.getByText("Approved value JSON for document 103", { exact: true }))
  await expect(inspector.locator(".durable-json[open] > pre")).toContainText('"total": 0')
  expect(state.requests).toHaveLength(6)
})

test("empty approved usage explains missing model records without inventing zero totals", async ({
  page,
}) => {
  const state = await durableFixture(page, "/?section=Durable")
  state.usageAvailable = true
  state.usageFieldsAbsent = true
  await page.goto(
    "/?section=Durable&chat=42&view=documents&scope=conversation&conversationId=7&objectId=103",
  )
  await expectRecord(page, "Model usage", "document #103")
  const approved = inspectorFor(page).getByRole("region", {
    includeHidden: true,
    name: "Approved document fields",
    exact: true,
  })
  await expect(approved).toContainText("No per-model usage recorded.")
  await expect(field(approved, "Input tokens")).toHaveText("Not recorded")
  await expect(field(approved, "Total tokens")).toHaveText("Not recorded")
  await expect(approved.locator("details")).toHaveCount(0)
  await expect(inspectorFor(page).locator("pre:visible")).toHaveCount(0)
  expect(state.requests).toHaveLength(3)
})

test("approved model and session fields explain absent values and retain session scope", async ({
  page,
}) => {
  const state = await durableFixture(page, "/?section=Durable")
  state.agentFieldsAbsent = true
  await page.goto(
    "/?section=Durable&chat=42&view=documents&scope=conversation&conversationId=7&objectId=101",
  )
  const inspector = inspectorFor(page)
  const approved = inspector.getByRole("region", {
    includeHidden: true,
    name: "Approved document fields",
    exact: true,
  })
  await expectRecord(page, "Model settings", "document #101")
  for (const label of ["Model provider", "Model", "Thinking level"])
    await expect(field(approved, label)).toHaveText("Not recorded")
  await expect(inspector.locator("pre:visible")).toHaveCount(0)
  expect(state.requests).toHaveLength(3)
  await page.goto("/?section=Durable&chat=42&view=documents&scope=session&objectId=201")
  await expectRecord(page, "Session selection", "document #201")
  await openDisclosure(inspector.locator(".durable-record-details"))
  await expect(field(detailsFor(page), "Applies to")).toHaveText("This session")
  await expect(
    approved.getByRole("link", { includeHidden: true, name: "Conversation 7", exact: true }),
  ).toHaveAttribute("href", /view=conversations&objectId=7/)
  await reveal(contextFor(page))
  await expect(contextFor(page)).toContainText("Inspecting session documents")
  state.sessionActiveAbsent = true
  await click(
    inspector.getByRole("button", { includeHidden: true, name: "Refresh records", exact: true }),
  )
  await expect(field(approved, "Persisted selected conversation")).toHaveText("Not recorded")
  await expect(approved.getByRole("link")).toHaveCount(0)
  await expect(inspector.locator("pre:visible")).toHaveCount(0)
  expect(state.requests).toHaveLength(9)
})

test("an available document without its approved projection explains the missing response fields", async ({
  page,
}) => {
  const state = await durableFixture(page, "/?section=Durable")
  state.approvedValueAbsent = true
  await page.goto(
    "/?section=Durable&chat=42&view=documents&scope=conversation&conversationId=7&objectId=101",
  )
  const inspector = inspectorFor(page)
  await expectRecord(page, "Model settings", "document #101")
  await expect(detailsFor(page)).toContainText(
    "Approved fields were not included in this response.",
  )
  await expect(
    inspector.getByRole("region", { includeHidden: true, name: "Approved document fields" }),
  ).toHaveCount(0)
  await expect(inspector.locator("pre:visible")).toHaveCount(0)
  expect(state.requests).toHaveLength(3)
})

test("unknown task kinds stay generic and nonterminal records do not claim an outcome", async ({
  page,
}) => {
  const state = await durableFixture(page, "/?section=Durable")
  state.taskItems = [
    {
      type: "task",
      id: 81,
      conversationId: 7,
      kind: "fixture.unknown-task-kind",
      version: 1,
      status: "waiting",
      background: false,
      abortRequested: false,
    },
  ]
  await page.goto("/?section=Durable&chat=42&view=tasks&conversationId=7")
  const inspector = inspectorFor(page)
  await expectRecord(page, "Task", "task #81")
  await expect(detailsFor(page)).toContainText("Recorded status: waiting")
  await expect(inspector.getByText("fixture.unknown-task-kind", { exact: true })).toBeHidden()
  await expect(inspector).not.toContainText(
    /Recorded outcome:|healthy|currently running|successfully completed/i,
  )
  await openDisclosure(inspector.locator(".durable-record-details"))
  await expect(field(detailsFor(page), "Started")).toHaveText("Not recorded")
  await expect(field(detailsFor(page), "Ended")).toHaveText("Not recorded")
  await expect(field(detailsFor(page), "Owning task")).toHaveText("No owner recorded")
  await expect(field(detailsFor(page), "Stored kind")).toHaveText("fixture.unknown-task-kind")
  await expect(field(detailsFor(page), "Stored status")).toHaveText("waiting")
  await expect(inspector.locator("pre:visible")).toHaveCount(0)
  expect(state.requests).toHaveLength(2)
})

test("absent conversation and entry relationships and task document scope stay explicit", async ({
  page,
}) => {
  const state = await durableFixture(
    page,
    "/?section=Durable&chat=42&view=conversations&objectId=9",
  )
  const inspector = inspectorFor(page)
  await expectRecord(page, "Conversation", "conversation #9")
  await expect(detailsFor(page)).toContainText("No parent relationship recorded.")
  await openDisclosure(inspector.locator(".durable-record-details"))
  await expect(field(detailsFor(page), "Parent conversation")).toHaveText("No parent recorded")
  await expect(field(detailsFor(page), "Owning task")).toHaveText("No owner recorded")
  state.entryItems = [{ type: "entry", id: 90, conversationId: 9, kind: "custom" }]
  await click(
    inspector.getByRole("link", {
      includeHidden: true,
      name: "Entries in conversation 9",
      exact: true,
    }),
  )
  await expectRecord(page, "Entry", "entry #90")
  await openDisclosure(inspector.locator(".durable-record-details"))
  for (const label of ["Recorded at", "Recorded by", "Head entry"])
    await expect(field(detailsFor(page), label)).toHaveText("Not recorded")
  state.documentItems = [
    {
      type: "document",
      id: 301,
      kind: "custom",
      scope: { kind: "task", taskId: 8 },
      family: false,
      createdAt: 109,
      valueState: "withheld",
      withheldReason: "invalid-value",
    },
  ]
  await page.goto("/?section=Durable&chat=42&view=documents&scope=task&conversationId=7&taskId=8")
  await expectRecord(page, "Document", "document #301")
  await openDisclosure(inspector.locator(".durable-record-details"))
  await expect(field(detailsFor(page), "Applies to")).toHaveText("Task 8")
  await expect(
    detailsFor(page).getByRole("link", { includeHidden: true, name: "Task 8", exact: true }),
  ).toHaveAttribute("href", /view=tasks&conversationId=7&objectId=8/)
  await expect(detailsFor(page)).toContainText(
    "The document value is withheld because it does not match the approved format.",
  )
  await expect(
    inspector.getByRole("link", { includeHidden: true, name: "Inspect document 301", exact: true }),
  ).toHaveCount(0)
  await expect(
    inspector.getByRole("region", { includeHidden: true, name: "Approved document fields" }),
  ).toHaveCount(0)
  await expect(inspector.locator("pre:visible")).toHaveCount(0)
})

test("session expiry clears loaded metadata and asks App to reauthenticate", async ({ page }) => {
  const state = await durableFixture(
    page,
    "/?section=Durable&chat=42&view=documents&scope=conversation&conversationId=7&objectId=101",
  )
  await click(page.getByText("Approved value JSON for document 101", { exact: true }))
  await expect(page.locator(".durable-inspector pre").last()).toContainText("untrusted.invalid")
  state.expired = true
  await click(
    page.getByRole("button", { includeHidden: true, name: "Refresh records", exact: true }),
  )
  await expect(
    page.getByRole("button", { includeHidden: true, name: "Sign in with passkey", exact: true }),
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
  await reveal(
    page.getByRole("link", { includeHidden: true, name: "Inspect document 101", exact: true }),
  )
  await expect(
    page.getByRole("link", { includeHidden: true, name: "Inspect document 101", exact: true }),
  ).toBeVisible()
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  state.gates.set("/api/chats/42/durable:101", gate)
  const aborted: string[] = []
  page.on("requestfailed", (request) => aborted.push(request.url()))
  try {
    await click(
      page.getByRole("link", { includeHidden: true, name: "Inspect document 101", exact: true }),
    )
    await expect(
      inspectorFor(page)
        .locator(".durable-selected-area > div")
        .getByText("Loading Durable…", { exact: true }),
    ).toBeVisible()
    await expect
      .poll(() => state.requests.filter((url) => url.searchParams.get("objectId") === "101").length)
      .toBe(1)
    await click(rawTab(inspectorFor(page), "Entries"))
    await expectRecord(page, "Assistant message", "entry #70")
    await expect.poll(() => aborted.length).toBe(1)
    await click(rawTab(inspectorFor(page), "Documents"))
    await click(
      page.getByRole("link", { includeHidden: true, name: "Inspect document 101", exact: true }),
    )
    await expect(
      inspectorFor(page)
        .locator(".durable-selected-area > div")
        .getByText("Loading Durable…", { exact: true }),
    ).toBeVisible()
    await expect
      .poll(() => state.requests.filter((url) => url.searchParams.get("objectId") === "101").length)
      .toBe(2)
    await click(
      page.getByRole("button", { includeHidden: true, name: "Open chat settings", exact: true }),
    )
    await expect.poll(() => aborted.length).toBe(2)
    await click(
      page
        .getByRole("list", { includeHidden: true, name: "Chats on this page" })
        .getByRole("button", { includeHidden: true, name: /Idle chat/ }),
    )
    await click(
      page.getByRole("link", {
        includeHidden: true,
        name: "View conversation records",
        exact: true,
      }),
    )
    await expectRecord(page, "Conversation", "conversation #17")
  } finally {
    release()
  }
  await expect(page.getByText("Approved value JSON for document 101", { exact: true })).toHaveCount(
    0,
  )
  await expect(page.getByRole("heading", { name: "Assistant message", exact: true })).toHaveCount(0)
})

test("policy drafts and the discard confirmation survive Inspector navigation", async ({
  page,
}) => {
  await durableFixture(page, "/?section=Chats&chat=42")
  await click(page.getByRole("tab", { name: "Access", exact: true }))
  await click(page.getByRole("button", { includeHidden: true, name: "Revoke access", exact: true }))
  await expect(page.getByText("Pending access revocation", { exact: true })).toBeVisible()
  await click(
    page.getByRole("link", { includeHidden: true, name: "View conversation records", exact: true }),
  )
  await expectRecord(page, "Conversation", "conversation #7")
  await expect(page.getByRole("region", { name: "Pending changes", exact: true })).toContainText(
    "unsaved change",
  )
  await click(
    page.getByRole("button", { includeHidden: true, name: "Open chat settings", exact: true }),
  )
  await expect(page.getByText("Pending access revocation", { exact: true })).toBeVisible()
  await expect(page.locator(".chat-header code")).toHaveText("42")
  await navigateSection(page, "Durable")
  await page.getByRole("button", { name: "Account", exact: true }).click()
  const dialog = page.waitForEvent("dialog")
  const clicking = page.getByRole("menuitem", { name: "Sign out", exact: true }).click()
  const prompt = await dialog
  expect(prompt.message()).toBe("Discard pending changes and leave?")
  await prompt.dismiss()
  await clicking
  await expect(inspectorFor(page)).toBeVisible()
  await expect(page.getByRole("region", { name: "Pending changes", exact: true })).toContainText(
    "unsaved change",
  )
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
    await click(
      page.getByRole("link", { includeHidden: true, name: "Inspect document 101", exact: true }),
    )
    await expect(
      inspectorFor(page)
        .locator(".durable-selected-area > div")
        .getByText("Loading Durable…", { exact: true }),
    ).toBeVisible()
    await expect
      .poll(() => state.requests.some((url) => url.searchParams.get("objectId") === "101"))
      .toBe(true)
    await page.evaluate(() => {
      window.history.pushState(null, "", "?section=Durable&chat=43")
      window.dispatchEvent(new PopStateEvent("popstate"))
    })
    await expectRecord(page, "Conversation", "conversation #17")
    await aborted
  } finally {
    release()
  }
  await expect(page.getByRole("heading", { name: "Idle chat", exact: true })).toBeVisible()
  await click(page.getByText("Advanced inspection", { exact: true }))
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
    page.getByText("Read stored messages and tool results. This view does not start work.", {
      exact: true,
    }),
  ).toBeVisible()
  expect(state.requests).toHaveLength(0)
  await page.goto("/?section=Durable&chat=42&view=tasks&conversationId=7&objectId=999")
  await expect(
    inspectorFor(page)
      .locator(".durable-selected-area > div")
      .getByText("Retired or unavailable", { exact: true }),
  ).toBeVisible()
  await page.route("**/api/chats/42/durable?*", (route) =>
    route.fulfill({ status: 404, json: { error: "Unavailable" } }),
  )
  await click(
    page.getByRole("button", { includeHidden: true, name: "Refresh records", exact: true }),
  )
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
  const inspector = inspectorFor(page)
  await expectRecord(page, "Conversation", "conversation #7")
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
      kind: "pi.generation",
      version: 1,
      status: "running",
      background: false,
      abortRequested: false,
    },
  ]
  await click(
    inspector.getByRole("button", { includeHidden: true, name: "Refresh records", exact: true }),
  )
  const selection = inspector.getByRole("region", {
    includeHidden: true,
    name: "Persisted selection details",
    exact: true,
  })
  const history = inspector.getByRole("region", {
    includeHidden: true,
    name: "Selected conversation task history",
    exact: true,
  })
  await reveal(selection)
  await expect(selection.getByText("Conversation 99", { exact: true })).toBeVisible()
  await expect(selection).toContainText("Inspection target: conversation 7")
  await reveal(contextFor(page))
  await expect(contextFor(page)).toContainText(
    "This is not the persisted selected conversation (conversation 99).",
  )
  await expect(history).toContainText("1 task record on the loaded page, and more may exist")
  await expect(history).toContainText("Recorded status: Running · no outcome recorded")
  await expect(history).toContainText("2026-10-19 12:00:01 UTC")
  await expect(selection).toContainText("2026-10-19 12:00:00 UTC")
  await expectRecord(page, "Conversation", "conversation #7")
  expect(state.requests).toHaveLength(4)
  expect(state.requests.at(-1)?.searchParams.get("conversationId")).toBe("99")
  await expect(inspector.getByLabel("Conversation ID", { exact: true })).toBeHidden()
  await expect(inspector.locator("pre")).toBeHidden()
  await reveal(
    inspector.getByText("Read-only persisted data; not live execution state", { exact: true }),
  )
  await expect(
    inspector.getByText("Read-only persisted data; not live execution state", { exact: true }),
  ).toBeVisible()
  await expect(inspector).not.toContainText(/healthy|idle execution|currently running/i)
  state.selectedConversation = null
  await click(
    inspector.getByRole("button", { includeHidden: true, name: "Refresh records", exact: true }),
  )
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
  const inspector = inspectorFor(page)
  const approved = inspector.getByRole("region", {
    includeHidden: true,
    name: "Approved document fields",
  })
  await expect(approved).toBeVisible()
  expect(state.requests).toHaveLength(3)
  state.failures.set("tasks", 503)
  await click(
    inspector.getByRole("button", { includeHidden: true, name: "Refresh records", exact: true }),
  )
  const history = inspector.getByRole("region", {
    includeHidden: true,
    name: "Selected conversation task history",
    exact: true,
  })
  await reveal(history)
  await expect(history.getByRole("alert")).toHaveText("Read failed. Refresh to retry.")
  await expect(
    inspector.getByRole("region", {
      includeHidden: true,
      name: "Persisted selection details",
      exact: true,
    }),
  ).toContainText("Conversation 7")
  await expect(approved).toBeVisible()
  await expect(history.locator("time")).toHaveCount(0)
  expect(state.requests).toHaveLength(6)
  await page.waitForTimeout(250)
  expect(state.requests).toHaveLength(6)
  state.failures.delete("tasks")
  state.taskItems = []
  await click(
    inspector.getByRole("button", { includeHidden: true, name: "Refresh records", exact: true }),
  )
  await expect(history).toContainText("No task history on this page.")
  expect(state.requests).toHaveLength(9)
  state.failures.set("tasks", 403)
  await click(
    inspector.getByRole("button", { includeHidden: true, name: "Refresh records", exact: true }),
  )
  await expect(history.getByRole("alert")).toHaveText(
    "Permission denied. This data could not be read.",
  )
  await expect(approved).toBeVisible()
  expect(state.requests).toHaveLength(12)
  state.failures.delete("tasks")
  state.failures.set("conversations", 503)
  await click(
    inspector.getByRole("button", { includeHidden: true, name: "Refresh records", exact: true }),
  )
  await expect(
    inspector
      .getByRole("region", {
        includeHidden: true,
        name: "Persisted selection details",
        exact: true,
      })
      .getByRole("alert"),
  ).toHaveText("Read failed. Refresh to retry.")
  await expect(history).toContainText("Unavailable: selection could not be read.")
  await expect(approved).toBeVisible()
  expect(state.requests).toHaveLength(14)
})

test("chat IDs and collapsed approved JSON can be copied, with explicit copy failures and no extra reads", async ({
  page,
}) => {
  const state = await durableFixture(
    page,
    "/?section=Durable&chat=42&view=documents&scope=conversation&conversationId=7&objectId=101",
  )
  const inspector = inspectorFor(page)
  await expect(
    inspector.getByRole("region", { includeHidden: true, name: "Approved document fields" }),
  ).toBeVisible()
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
  await click(
    inspector.getByRole("button", { includeHidden: true, name: "Copy chat ID", exact: true }),
  )
  await expect(inspector.getByText("Chat ID copied.", { exact: true })).toBeVisible()
  expect(await page.evaluate(() => sessionStorage.getItem("copied-fixture"))).toBe("42")
  await click(inspector.getByText("Approved value JSON for document 101", { exact: true }))
  await click(
    inspector.getByRole("button", {
      includeHidden: true,
      name: "Copy Approved value JSON for document 101",
      exact: true,
    }),
  )
  await expect(inspector.getByText("JSON copied.", { exact: true })).toBeVisible()
  const copied = await page.evaluate(() => sessionStorage.getItem("copied-fixture"))
  expect(JSON.parse(copied ?? "null")).toEqual({
    kind: "pi.agent",
    model: { provider: "fixture", modelId: untrusted },
    thinkingLevel: "low",
  })
  await click(inspector.getByText("Metadata JSON for document 101", { exact: true }))
  await click(
    inspector.getByRole("button", {
      includeHidden: true,
      name: "Copy Metadata JSON for document 101",
      exact: true,
    }),
  )
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
  await click(
    inspector.getByRole("button", {
      includeHidden: true,
      name: "Copy Approved value JSON for document 101",
      exact: true,
    }),
  )
  await expect(
    inspector.getByText("Copy failed. Select and copy the JSON below.", { exact: true }),
  ).toBeVisible()
  await expect(inspector.locator(".durable-json[open] > pre").last()).toBeVisible()
  expect(state.requests).toHaveLength(3)
  expect(await inspector.locator("img, iframe, script").count()).toBe(0)
})

for (const width of [390, 320])
  test(`long names and safe-integer IDs wrap at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const state = await durableFixture(page)
    await expectRecord(page, "Conversation", "conversation #7")
    const id = 9007199254740991
    const name = `A persisted chat name with a very long uninterrupted suffix ${"long".repeat(35)}`
    state.chats.push({ id: -id, name, type: "supergroup" })
    state.selectedConversation = { type: "conversation", id, active: true }
    state.taskItems = [
      {
        type: "task",
        id,
        conversationId: id,
        kind: "pi.generation",
        version: 1,
        status: "terminal",
        outcome: "completed",
        background: false,
        abortRequested: false,
      },
    ]
    await page.goto(`/?section=Durable&chat=-${id}&view=tasks&conversationId=${id}`)
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible()
    await expectRecord(page, "Model response", `task #${id}`)
    expect(
      await inspectorFor(page)
        .locator(".durable-browse-current")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true)
    await click(page.getByText(`Metadata JSON for task ${id}`, { exact: true }))
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })

for (const width of [1440, 390, 320])
  test(`context, named relationship links, keyboard tabs, disclosures, and copy work at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    const state = await durableFixture(page, "/?section=Durable&chat=42&conversationId=7")
    const inspector = inspectorFor(page)
    await expectRecord(page, "Conversation", "conversation #7")
    const owner = detailsFor(page).getByRole("link", {
      includeHidden: true,
      name: "Task 4 in conversation 6",
      exact: true,
    })
    await reveal(owner)
    await page.keyboard.press("Tab")
    await owner.focus()
    await expect(owner).toBeFocused()
    expect(await owner.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe(
      "none",
    )
    await expect(owner).toHaveAttribute("href", /view=tasks&conversationId=6&objectId=4/)
    const tab = rawTab(inspector, "Conversations")
    await reveal(tab)
    await tab.focus()
    await tab.press("ArrowRight")
    await expect(rawTab(inspector, "Tasks")).toBeFocused()
    await expectRecord(page, "Model response", "task #8")
    await reveal(contextFor(page))
    await expect(contextFor(page)).toContainText("Inspecting conversation 7")
    const summary = inspector.getByText("Metadata JSON for task 8", { exact: true })
    const beforeDisclosure = state.requests.length
    await reveal(summary)
    await summary.focus()
    await summary.press("Enter")
    await expect(inspector.locator("pre")).toBeVisible()
    expect(await summary.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe(
      "none",
    )
    expect(state.requests).toHaveLength(beforeDisclosure)
    await rawTab(inspector, "Tasks").press("End")
    await expect(rawTab(inspector, "Entries")).toBeFocused()
    await expectRecord(page, "Assistant message", "entry #70")
    await reveal(contextFor(page))
    await expect(contextFor(page)).toContainText("Inspecting conversation 7")
    const task = detailsFor(page).locator(".durable-record-details").getByRole("link", {
      includeHidden: true,
      name: "Task 8",
      exact: true,
    })
    await reveal(task)
    await task.focus()
    await task.press("Enter")
    await expect(page).toHaveURL(/view=tasks&conversationId=7&objectId=8/)
    await expectRecord(page, "Model response", "task #8")
    await inspector
      .getByRole("link", { includeHidden: true, name: "Documents for task 8", exact: true })
      .focus()
    await inspector
      .getByRole("link", { includeHidden: true, name: "Documents for task 8", exact: true })
      .press("Enter")
    await expect(
      inspector
        .locator(".durable-selected-area > div")
        .getByText("No records in this view.", { exact: true }),
    ).toBeVisible()
    await reveal(contextFor(page))
    await expect(contextFor(page)).toContainText("Inspecting conversation 7")
    await click(
      inspector.getByRole("combobox", { includeHidden: true, name: "Document scope", exact: true }),
    )
    await click(
      page.getByRole("option", { includeHidden: true, name: "Conversation", exact: true }),
    )
    const inspect = inspector.getByRole("link", {
      includeHidden: true,
      name: "Inspect document 101",
      exact: true,
    })
    await reveal(inspect)
    await inspect.focus()
    await inspect.press("Enter")
    await expect(
      inspector.getByRole("region", { includeHidden: true, name: "Approved document fields" }),
    ).toBeVisible()
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
    const json = inspector.getByText("Approved value JSON for document 101", { exact: true })
    await reveal(json)
    await json.focus()
    await json.press("Enter")
    const copy = inspector.getByRole("button", {
      includeHidden: true,
      name: "Copy Approved value JSON for document 101",
      exact: true,
    })
    await copy.focus()
    await copy.press("Enter")
    await expect(inspector.getByText("JSON copied.", { exact: true })).toBeVisible()
    expect(
      JSON.parse((await page.evaluate(() => sessionStorage.getItem("copied-fixture"))) ?? "null")
        .kind,
    ).toBe("pi.agent")
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
