import type { DurableEntryItem } from "@narumitw/sumire-contracts"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { durableFixture, historyInput, historyOutput, untrusted } from "./durable-fixture.js"
import { click } from "./durable-ui.js"

const inspector = (page: Page) =>
  page.getByRole("region", { name: "Durable Inspector", exact: true })
const history = (page: Page) =>
  inspector(page).getByRole("region", { name: "Conversation history", exact: true })
const views = (page: Page) =>
  inspector(page).getByRole("navigation", { name: "Conversation record views", exact: true })
const eventDetails = (page: Page) =>
  page.getByRole("complementary", { name: "Event details", exact: true })
const entry = (page: Page, id: number) =>
  history(page)
    .getByRole("article")
    .filter({
      has: page.getByRole("link", { name: `Inspect entry ${id}`, exact: true }),
    })
const inspectEntry = (page: Page, id: number) =>
  history(page).getByRole("link", { name: `Inspect entry ${id}`, exact: true })
const expectIds = async (scope: Locator, ids: number[]) => {
  await expect(scope.locator("article > header .durable-record-id")).toHaveText(
    ids.map((id) => `#${id}`),
  )
}
const expectNoOverflow = async (page: Page) => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
}
const refresh = (page: Page) =>
  inspector(page).getByRole("button", { name: "Refresh records", exact: true })
const latestIds = [160, 169, 170, 171, 172, 173, 174, 175, 176]

test("missing view opens bounded History, reverses native order, and groups only addressed user input", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const state = await durableFixture(page, "/?section=Durable&chat=42")
  await expect(
    history(page).getByRole("heading", { name: "History · conversation 7", exact: true }),
  ).toBeVisible()
  await expect(views(page).getByRole("link", { name: "History", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  )
  await expect(history(page)).toContainText("Saved model-facing messages, not a Telegram archive")
  await expectIds(history(page), latestIds)
  // Entry 160 has a 2027 timestamp, and 171 is earlier than 170. Neither changes native order.
  await expect(entry(page, 160)).toContainText("2027-01-01")
  await expect(entry(page, 171)).toContainText("2026-10-19 09:00:00 UTC")
  await expect(history(page).locator(".durable-turn")).toHaveCount(3)
  const boundary = history(page).getByRole("region", {
    name: "Earlier context on this page",
    exact: true,
  })
  await expectIds(boundary, [160, 169])
  await expect(boundary).toContainText("The preceding user turn is not on this page")
  await expectIds(
    history(page).getByRole("region", { name: "User turn 170", exact: true }),
    [170, 171, 172, 173],
  )
  await expectIds(
    history(page).getByRole("region", { name: "User turn 174", exact: true }),
    [174, 175, 176],
  )
  await expect(
    history(page).getByRole("region", { name: "User turn 172", exact: true }),
  ).toHaveCount(0)
  await expect(entry(page, 172)).toContainText(
    "Passive context: imported message, not addressed input.",
  )
  await expect(entry(page, 176)).toContainText("Internal payloads are not exposed.")
  await expect(
    inspector(page).getByRole("region", { name: "Persisted selection", exact: true }),
  ).toContainText("Conversation 7")
  await expect(history(page)).toContainText("9 matching / 9 loaded records")
  await expect(eventDetails(page)).toHaveCount(0)
  expect(state.requests.map((url) => url.searchParams.get("view"))).toEqual([
    "conversations",
    "tasks",
    "history",
  ])
  expect(state.requests.at(-1)?.searchParams.get("conversationId")).toBe("7")
  expect(state.requests.every((url) => url.searchParams.get("limit") === "25")).toBe(true)
  expect(state.requests.every((url) => !url.searchParams.has("objectId"))).toBe(true)
  expect(state.methods.every((method) => method === "GET")).toBe(true)
  await page.waitForTimeout(150)
  expect(state.requests).toHaveLength(3)
  await expectNoOverflow(page)
  await page.screenshot({ path: "/tmp/sumire-history-1440.png", fullPage: true })
})

test("an invalid view also resolves only the off-page persisted conversation", async ({ page }) => {
  const state = await durableFixture(page, "/?section=Durable")
  state.selectedConversation = { type: "conversation", id: 99, active: true }
  state.historyItems.set(99, [
    {
      type: "entry",
      id: 299,
      conversationId: 99,
      kind: "pi.user",
      role: "user",
      content: {
        truncated: false,
        messages: [
          { role: "user", content: [{ type: "text", text: "Off-page selected history." }] },
        ],
      },
    },
  ])
  await page.goto("/?section=Durable&chat=42&view=not-a-view")
  await expectIds(history(page), [299])
  await expect(history(page)).toContainText("Off-page selected history.")
  expect(state.requests.filter((url) => url.searchParams.get("view") === "history")).toHaveLength(1)
  expect(state.requests.at(-1)?.searchParams.get("conversationId")).toBe("99")
  expect(state.requests.some((url) => url.searchParams.get("conversationId") === "7")).toBe(false)
})

test("saved text stays literal and thinking, tool arguments, and tool output start collapsed", async ({
  page,
}) => {
  const remote: string[] = []
  page.on("request", (request) => {
    if (request.url().includes("untrusted.invalid")) remote.push(request.url())
  })
  const state = await durableFixture(page, "/?section=Durable&chat=42")
  await expect(entry(page, 170).locator(".durable-message-text")).toHaveText(historyInput)
  await expect(entry(page, 170)).toContainText(
    "Image omitted · image/png. Image bytes are not sent.",
  )
  const assistant = entry(page, 171)
  const thinking = assistant.locator("details").filter({
    has: page.locator("summary").getByText("Thinking", { exact: true }),
  })
  const argumentsDisclosure = assistant.locator('details[aria-label="Tool call"]')
  const output = entry(page, 173)
    .locator("details")
    .filter({
      has: page.locator("summary").getByText("Tool output", { exact: true }),
    })
  for (const disclosure of [thinking, argumentsDisclosure, output])
    await expect(disclosure).not.toHaveAttribute("open", "")
  await expect(
    assistant.getByText(`Private history reasoning ${untrusted}`, { exact: true }),
  ).toBeHidden()
  await expect(assistant.locator(".durable-arguments")).toBeHidden()
  await expect(entry(page, 173).locator(".durable-tool-output")).toBeHidden()
  const reads = state.requests.length
  await thinking.locator("summary").focus()
  await thinking.locator("summary").press("Enter")
  await expect(
    assistant.getByText(`Private history reasoning ${untrusted}`, { exact: true }),
  ).toBeVisible()
  await argumentsDisclosure.locator(":scope > summary").click()
  await expect(assistant.locator(".durable-arguments")).toHaveText(
    JSON.stringify({ input: untrusted }),
  )
  await output.locator("summary").click()
  await expect(entry(page, 173).locator(".durable-tool-output")).toHaveText(historyOutput)
  expect(state.requests).toHaveLength(reads)
  expect(remote).toEqual([])
  await expect(inspector(page).locator("img, iframe, script")).toHaveCount(0)
  expect(await page.evaluate(() => Object.hasOwn(window, "inspectorInjected"))).toBe(false)
  await expectNoOverflow(page)
})

test("search and record type filters inspect only the loaded page without server reads", async ({
  page,
}) => {
  const state = await durableFixture(page, "/?section=Durable&chat=42")
  await expectIds(history(page), latestIds)
  const search = history(page).getByRole("searchbox", { name: "Search loaded page", exact: true })
  const filter = history(page).getByRole("combobox", { name: "Record type", exact: true })
  const reads = state.requests.length
  await search.fill("SYNTHETIC TOOL OUTPUT")
  await expectIds(history(page), [173])
  await expect(history(page)).toContainText("1 matching / 9 loaded records")
  await search.fill(untrusted)
  await expectIds(history(page), [170, 171, 173])
  await search.fill("")
  for (const [value, ids] of [
    ["user", [170, 172, 174]],
    ["assistant", [160, 171, 175]],
    ["tools", [171, 173]],
    ["other", [169, 176]],
  ] as const) {
    await filter.selectOption(value)
    await expectIds(history(page), [...ids])
  }
  await filter.selectOption("all")
  await search.fill("Older saved answer")
  await expect(history(page)).toContainText("No matches on the loaded page.")
  await expect(history(page)).toContainText("0 matching / 9 loaded records")
  expect(state.requests).toHaveLength(reads)
  expect(state.requests.some((url) => url.searchParams.has("q"))).toBe(false)
  await history(page).getByRole("button", { name: "Older records", exact: true }).click()
  await expectIds(history(page), [159])
  await expect(search).toHaveValue("Older saved answer")
  await expect(history(page)).toContainText("1 matching / 3 loaded records")
})

test("older and newer controls use native cursors and preserve partial-turn boundary context", async ({
  page,
}) => {
  const state = await durableFixture(page, "/?section=Durable&chat=42")
  const newer = history(page).getByRole("button", { name: "Newer records", exact: true })
  const older = history(page).getByRole("button", { name: "Older records", exact: true })
  await expect(newer).toBeDisabled()
  await expect(older).toBeEnabled()
  await expect(history(page)).toContainText("Page 1 · latest records")
  await expect(history(page)).toContainText("History truncated")
  await older.click()
  await expectIds(history(page), [157, 158, 159])
  await expect(history(page)).toContainText("Page 2 · older records")
  await expectIds(
    history(page).getByRole("region", { name: "Earlier context on this page", exact: true }),
    [157],
  )
  await expectIds(
    history(page).getByRole("region", { name: "User turn 158", exact: true }),
    [158, 159],
  )
  await expect(history(page)).toContainText("The preceding user turn is not on this page")
  await expect(older).toBeDisabled()
  await expect(newer).toBeEnabled()
  const requests = () => state.requests.filter((url) => url.searchParams.get("view") === "history")
  expect(requests().at(-1)?.searchParams.get("cursor")).toBe("history+/=older")
  await newer.click()
  await expectIds(history(page), latestIds)
  await expect(newer).toBeDisabled()
  await expect(older).toBeEnabled()
  expect(requests()).toHaveLength(3)
  expect(requests().at(-1)?.searchParams.has("cursor")).toBe(false)
})

test("event selections retain the history list, search, record type, and older page", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const state = await durableFixture(page, "/?section=Durable&chat=42")
  await history(page).getByRole("button", { name: "Older records", exact: true }).click()
  await expectIds(history(page), [157, 158, 159])
  const search = history(page).getByRole("searchbox", { name: "Search loaded page", exact: true })
  const filter = history(page).getByRole("combobox", { name: "Record type", exact: true })
  await search.fill("Older")
  await filter.selectOption("assistant")
  await expectIds(history(page), [157, 159])
  let reads = state.requests.length
  await inspectEntry(page, 159).click()
  await expect(page).toHaveURL(/view=history&conversationId=7&objectId=159/)
  await expect(eventDetails(page)).toContainText("Older saved answer.")
  await expect(history(page)).toContainText("Page 2 · older records")
  await expectIds(history(page), [157, 159])
  await expect(search).toHaveValue("Older")
  await expect(filter).toHaveValue("assistant")
  expect(state.requests).toHaveLength(reads + 1)
  expect(state.requests.at(-1)?.searchParams.get("view")).toBe("entries")
  expect(state.requests.at(-1)?.searchParams.get("conversationId")).toBe("7")
  expect(state.requests.at(-1)?.searchParams.get("objectId")).toBe("159")
  reads = state.requests.length
  await inspectEntry(page, 157).click()
  await expect(eventDetails(page)).toContainText("Older page starts inside an inherited turn.")
  await expect(inspectEntry(page, 157)).toHaveAttribute("aria-current", "true")
  expect(state.requests).toHaveLength(reads + 1)
  await search.fill("Older saved answer")
  await expectIds(history(page), [159])
  await expect(eventDetails(page)).toContainText(
    "Selected entry does not match the loaded-page filters.",
  )
  await expect(history(page)).toContainText("Page 2 · older records")
  expect(state.requests).toHaveLength(reads + 1)
  await page.goBack()
  await expect(page).toHaveURL(/objectId=159/)
  await expect(eventDetails(page)).toContainText("Older saved answer.")
  await expect(history(page)).toContainText("Page 2 · older records")
  await expectIds(history(page), [159])
  await expect(search).toHaveValue("Older saved answer")
  await page.goForward()
  await expect(page).toHaveURL(/objectId=157/)
  await expect(eventDetails(page)).toContainText("Older page starts inside an inherited turn.")
  await expect(history(page)).toContainText("Page 2 · older records")
  await expectIds(history(page), [159])
})

test("historical branch navigation and inherited details do not change persisted selection", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const state = await durableFixture(
    page,
    "/?section=Durable&chat=42&view=history&conversationId=9",
  )
  await expectIds(history(page), [160, 195, 196])
  await expect(entry(page, 160)).toContainText("Inherited from conversation 6")
  await expect(inspectEntry(page, 160)).toHaveAttribute(
    "href",
    /view=history&conversationId=9&objectId=160/,
  )
  await inspectEntry(page, 160).click()
  await expect(eventDetails(page)).toContainText("Inherited answer retained in this branch.")
  const detailRequest = state.requests.at(-1)
  expect(detailRequest?.searchParams.get("view")).toBe("entries")
  expect(detailRequest?.searchParams.get("conversationId")).toBe("9")
  expect(detailRequest?.searchParams.get("objectId")).toBe("160")
  expect(state.historyDetails.has("6:160")).toBe(false)
  await expect(
    eventDetails(page).getByRole("link", { name: "Conversation 6", exact: true }).first(),
  ).toHaveAttribute("href", /view=conversations&objectId=6/)
  const branch = views(page).getByRole("link", { name: "Branch view", exact: true })
  await expect(branch).toHaveAttribute("href", /view=conversations&objectId=9/)
  await branch.click()
  await expect(page).toHaveURL(/view=conversations&objectId=9/)
  const detail = inspector(page).getByRole("region", { name: "Selected item details", exact: true })
  await expect(detail).toContainText("conversation #9")
  await expect(
    inspector(page).getByRole("region", { name: "Relationship tree", exact: true }),
  ).toBeVisible()
  await page.screenshot({ path: "/tmp/sumire-history-branch-before.png", fullPage: true })
  await detail.getByRole("link", { name: "History in conversation 9", exact: true }).click()
  await expectIds(history(page), [160, 195, 196])
  await expect(
    inspector(page).getByRole("region", { name: "Persisted selection", exact: true }),
  ).toContainText("Conversation 7")
  await page.screenshot({ path: "/tmp/sumire-history-branch-after.png", fullPage: true })
  expect(state.selectedConversation?.id).toBe(7)
  expect(state.methods.every((method) => method === "GET")).toBe(true)
})

test("direct off-page object links and browser back and forward keep independent event details", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await durableFixture(page, "/?section=Durable&chat=42&view=history&conversationId=7&objectId=159")
  await expectIds(history(page), latestIds)
  await expect(eventDetails(page)).toContainText("Older saved answer.")
  await expect(eventDetails(page)).toContainText("Selected entry is outside the loaded page.")
  await inspectEntry(page, 170).click()
  await expect(eventDetails(page).locator(".durable-message-text")).toHaveText(historyInput)
  await expect(eventDetails(page)).not.toContainText("outside the loaded page")
  await inspectEntry(page, 171).click()
  await expect(eventDetails(page)).toContainText("Checking synthetic records.")
  await page.goBack()
  await expect(page).toHaveURL(/objectId=170/)
  await expect(eventDetails(page).locator(".durable-message-text")).toHaveText(historyInput)
  await expectIds(history(page), latestIds)
  await page.goBack()
  await expect(page).toHaveURL(/objectId=159/)
  await expect(eventDetails(page)).toContainText("Selected entry is outside the loaded page.")
  await page.goForward()
  await expect(page).toHaveURL(/objectId=170/)
  await expect(eventDetails(page).locator(".durable-message-text")).toHaveText(historyInput)
  await page.reload()
  await expectIds(history(page), latestIds)
  await expect(eventDetails(page).locator(".durable-message-text")).toHaveText(historyInput)
})

for (const width of [390, 320])
  test(`narrow event dialog closes with Escape, restores focus, and wraps untrusted text at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 })
    const state = await durableFixture(page, "/?section=Durable&chat=42")
    await expectIds(history(page), latestIds)
    await expectNoOverflow(page)
    const opener = inspectEntry(page, 170)
    await opener.click()
    const dialog = page.getByRole("dialog", { name: "Event details", exact: true })
    await expect(dialog).toBeVisible()
    await expect(dialog.locator(".durable-message-text")).toHaveText(historyInput)
    await expect(dialog).toContainText("Image omitted · image/png")
    await expect(dialog.locator("img, iframe, script")).toHaveCount(0)
    await expect(eventDetails(page)).toHaveCount(0)
    await expectNoOverflow(page)
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    )
    if (width === 320) await page.screenshot({ path: "/tmp/sumire-history-320-dialog.png" })
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)
    await expect(opener).toBeFocused()
    await expect(page).toHaveURL(/view=history&conversationId=7&objectId=170/)
    await expectIds(history(page), latestIds)
    const reads = state.requests.length
    await history(page).getByRole("button", { name: "Open event details", exact: true }).click()
    await expect(dialog).toBeVisible()
    await dialog.getByRole("button", { name: "Close event details", exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(opener).toBeFocused()
    expect(state.requests).toHaveLength(reads)
    await inspectEntry(page, 173).click()
    await expect(dialog.locator(".durable-tool-output")).toHaveText(historyOutput)
    await expect(dialog.locator(".durable-tool-output")).toBeVisible()
    await expectNoOverflow(page)
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    )
    await page.keyboard.press("Escape")
    await expect(inspectEntry(page, 173)).toBeFocused()
  })

test("a direct narrow object link restores focus to search when it has no opener", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 })
  await durableFixture(page, "/?section=Durable&chat=42&view=history&conversationId=7&objectId=175")
  const dialog = page.getByRole("dialog", { name: "Event details", exact: true })
  await expect(dialog).toContainText("Saved final answer.")
  await page.keyboard.press("Escape")
  await expect(
    history(page).getByRole("searchbox", { name: "Search loaded page", exact: true }),
  ).toBeFocused()
  await expectNoOverflow(page)
})

for (const selected of [null, undefined])
  test(`missing persisted selection (${selected}) never guesses from the conversation page`, async ({
    page,
  }) => {
    const state = await durableFixture(page, "/?section=Durable")
    state.selectedConversation = selected
    await page.goto("/?section=Durable&chat=42")
    await expect(inspector(page)).toContainText("No persisted conversation is available.")
    await expect(history(page)).toHaveCount(0)
    expect(state.requests.map((url) => url.searchParams.get("view"))).toEqual(["conversations"])
    await views(page).getByRole("link", { name: "Branch view", exact: true }).click()
    await expect(page).toHaveURL(/view=conversations/)
    await expect(
      inspector(page).getByRole("region", { name: "Selected item details", exact: true }),
    ).toContainText("conversation #7")
    expect(state.requests.some((url) => url.searchParams.get("view") === "history")).toBe(false)
  })

test("an explicit historical target works without a persisted selection", async ({ page }) => {
  const state = await durableFixture(page, "/?section=Durable")
  state.selectedConversation = null
  await page.goto("/?section=Durable&chat=42&view=history&conversationId=9")
  await expectIds(history(page), [160, 195, 196])
  await expect(
    inspector(page).getByRole("region", { name: "Persisted selection", exact: true }),
  ).toContainText("Not recorded")
  expect(state.requests.map((url) => url.searchParams.get("view"))).toEqual([
    "conversations",
    "history",
  ])
  expect(state.requests.at(-1)?.searchParams.get("conversationId")).toBe("9")
  expect(state.methods.every((method) => method === "GET")).toBe(true)
})

test("no chat, unloaded chat, and an empty saved page are distinct and read-only", async ({
  page,
}) => {
  const state = await durableFixture(page, "/?section=Durable")
  await expect(inspector(page)).toContainText("This view does not start work.")
  expect(state.requests).toHaveLength(0)
  await page.goto("/?section=Durable&chat=44")
  await expect(
    inspector(page).getByRole("heading", { name: "Not loaded", exact: true }),
  ).toBeVisible()
  await expect(inspector(page)).toContainText(
    "Inspection will not open its database or start a session.",
  )
  expect(state.requests.map((url) => url.searchParams.get("view"))).toEqual(["conversations"])
  state.historyItems.set(7, [])
  state.historyOlderItems.delete(7)
  await page.goto("/?section=Durable&chat=42")
  await expect(history(page)).toContainText("No saved entries on this page.")
  await expect(
    history(page).getByRole("button", { name: "Older records", exact: true }),
  ).toBeDisabled()
  expect(state.methods.every((method) => method === "GET")).toBe(true)
})

test("history failure hides old content and refresh retries without changing the inspected conversation", async ({
  page,
}) => {
  const state = await durableFixture(
    page,
    "/?section=Durable&chat=42&view=history&conversationId=9",
  )
  await expectIds(history(page), [160, 195, 196])
  state.failures.set("history", 503)
  await refresh(page).click()
  await expect(history(page).getByRole("alert")).toHaveText("Read failed. Refresh to retry.")
  await expect(history(page).getByRole("article")).toHaveCount(0)
  await expect(
    history(page).getByRole("button", { name: "Older records", exact: true }),
  ).toBeDisabled()
  state.failures.delete("history")
  await refresh(page).click()
  await expectIds(history(page), [160, 195, 196])
  expect(
    state.requests
      .filter((url) => url.searchParams.get("view") === "history")
      .every((url) => url.searchParams.get("conversationId") === "9"),
  ).toBe(true)
  expect(state.methods.every((method) => method === "GET")).toBe(true)
})

for (const status of [404, 503, 403])
  test(`event detail read ${status} has an explicit state without stale content`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const state = await durableFixture(page, "/?section=Durable&chat=42")
    await expectIds(history(page), latestIds)
    state.failures.set("entries", status)
    await inspectEntry(page, 170).click()
    if (status === 404)
      await expect(eventDetails(page)).toContainText("Entry unavailable in this conversation.")
    else if (status === 503)
      await expect(eventDetails(page).getByRole("alert")).toHaveText(
        "Entry read failed. Refresh records to retry.",
      )
    else {
      await expect(eventDetails(page).getByRole("alert")).toHaveText(
        "Permission denied. Refresh records to retry.",
      )
      await expect(history(page).getByRole("article")).toHaveCount(0)
    }
    await expect(
      eventDetails(page).getByRole("region", { name: "Entry content", exact: true }),
    ).toHaveCount(0)
    if (status !== 403) await expectIds(history(page), latestIds)
    state.failures.delete("entries")
    await refresh(page).click()
    await expectIds(history(page), latestIds)
    await expect(eventDetails(page).locator(".durable-message-text")).toHaveText(historyInput)
  })

for (const ownerState of ["not-loaded", "changed"] as const)
  test(`detail owner ${ownerState} invalidates the loaded history until refresh`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const state = await durableFixture(page, "/?section=Durable&chat=42")
    await expectIds(history(page), latestIds)
    await history(page).getByRole("button", { name: "Older records", exact: true }).click()
    await expectIds(history(page), [157, 158, 159])
    await expect(
      history(page).getByRole("button", { name: "Newer records", exact: true }),
    ).toBeEnabled()
    await inspectEntry(page, 159).click()
    await expect(eventDetails(page)).toContainText("Older saved answer.")
    if (ownerState === "not-loaded") state.notLoadedViews.add("entries")
    else state.failures.set("entries", 409)
    await inspectEntry(page, 158).click()
    await expect(eventDetails(page)).toContainText(
      ownerState === "not-loaded"
        ? "Session not loaded. Refresh records after the chat is loaded."
        : "Session or inspection changed. Refresh records to retry.",
    )
    await expect(history(page).getByRole("article")).toHaveCount(0)
    await expect(
      eventDetails(page).getByRole("region", { name: "Entry content", exact: true }),
    ).toHaveCount(0)
    await expect(page.getByText("Older saved answer.", { exact: true })).toHaveCount(0)
    for (const name of ["Newer records", "Older records"])
      await expect(history(page).getByRole("button", { name, exact: true })).toBeDisabled()
    state.notLoadedViews.clear()
    state.failures.delete("entries")
    await refresh(page).click()
    await expectIds(history(page), latestIds)
    await expect(eventDetails(page).locator(".durable-message-text")).toHaveText(
      "Older saved question.",
    )
    await expect(history(page)).toContainText("Page 1 · latest records")
  })

test("missing objects, absent content, and truncated saved content remain explicit", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const state = await durableFixture(
    page,
    "/?section=Durable&chat=42&view=history&conversationId=7&objectId=999",
  )
  await expectIds(history(page), latestIds)
  await expect(eventDetails(page)).toContainText("Entry unavailable in this conversation.")
  const original = state.historyDetails.get("7:175")
  if (!original) throw new Error("Missing fixture history detail")
  const metadataOnly: DurableEntryItem = { ...original, content: undefined }
  state.historyDetails.set("7:175", metadataOnly)
  await inspectEntry(page, 175).click()
  await expect(eventDetails(page)).toContainText("Only metadata is included.")
  await expect(
    eventDetails(page).getByRole("region", { name: "Entry content", exact: true }),
  ).toHaveCount(0)
  state.historyDetails.set("7:175", {
    ...original,
    content: { truncated: true, messages: [] },
  })
  await refresh(page).click()
  await expect(eventDetails(page)).toContainText("Content truncated")
  await expect(eventDetails(page)).toContainText("No message content included in this response.")
  await expect(history(page)).toContainText("Saved final answer.")
})

test("entry session expiry clears both the loaded history and detail content", async ({ page }) => {
  const state = await durableFixture(page, "/?section=Durable&chat=42")
  await expectIds(history(page), latestIds)
  state.expired = true
  await inspectEntry(page, 170).click()
  await expect(
    page.getByRole("button", { name: "Sign in with passkey", exact: true }),
  ).toBeVisible()
  await expect(page.getByRole("alert")).toHaveText("Administrator session expired. Sign in again.")
  await expect(inspector(page)).toHaveCount(0)
  await expect(page.getByText(historyInput, { exact: true })).toHaveCount(0)
  await page.goBack()
  await expect(inspector(page)).toHaveCount(0)
})

test("refresh and chat switch cancel pending details and never publish the old response", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const state = await durableFixture(
    page,
    "/?section=Durable&chat=42&view=history&conversationId=7",
  )
  await expectIds(history(page), latestIds)
  let release = () => {}
  state.gates.set(
    "/api/chats/42/durable:entries:170",
    new Promise<void>((resolve) => {
      release = resolve
    }),
  )
  const original = state.historyDetails.get("7:170")
  if (!original) throw new Error("Missing fixture history detail")
  state.historyDetails.set("7:170", {
    ...original,
    content: {
      truncated: false,
      messages: [
        { role: "user", content: [{ type: "text", text: "Stale detail must not appear." }] },
      ],
    },
  })
  const aborted: string[] = []
  page.on("requestfailed", (request) => {
    if (request.url().includes("objectId=170")) aborted.push(request.url())
  })
  const pending = () =>
    state.requests.filter(
      (url) =>
        url.searchParams.get("view") === "entries" && url.searchParams.get("objectId") === "170",
    ).length
  try {
    await inspectEntry(page, 170).click()
    await expect(eventDetails(page)).toContainText("Loading entry…")
    await expect.poll(pending).toBe(1)
    await refresh(page).click()
    await expect.poll(() => aborted.length).toBeGreaterThanOrEqual(1)
    await expect.poll(pending).toBeGreaterThanOrEqual(2)
    await page.evaluate(() => {
      window.history.pushState(null, "", "?section=Durable&chat=43")
      window.dispatchEvent(new PopStateEvent("popstate"))
    })
    await expect(page.getByRole("heading", { name: "Idle chat", exact: true })).toBeVisible()
    await expect(inspector(page)).toContainText("No persisted conversation is available.")
    await expect.poll(() => aborted.length).toBeGreaterThanOrEqual(2)
  } finally {
    release()
  }
  await expect(eventDetails(page)).toHaveCount(0)
  await expect(page.getByText("Stale detail must not appear.", { exact: true })).toHaveCount(0)
  await expect(page.getByText(historyInput, { exact: true })).toHaveCount(0)
  expect(state.methods.every((method) => method === "GET")).toBe(true)
})

test("switching selected events aborts the pending detail without restarting the history page", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const state = await durableFixture(page, "/?section=Durable&chat=42")
  await expectIds(history(page), latestIds)
  let release = () => {}
  state.gates.set(
    "/api/chats/42/durable:entries:170",
    new Promise<void>((resolve) => {
      release = resolve
    }),
  )
  const aborted = page.waitForEvent("requestfailed", (request) =>
    request.url().includes("objectId=170"),
  )
  const historyReads = state.requests.filter(
    (url) => url.searchParams.get("view") === "history",
  ).length
  try {
    await inspectEntry(page, 170).click()
    await expect(eventDetails(page)).toContainText("Loading entry…")
    await click(inspectEntry(page, 175))
    await aborted
    await expect(eventDetails(page)).toContainText("Saved final answer.")
  } finally {
    release()
  }
  await expect(eventDetails(page)).not.toContainText(historyInput)
  await expectIds(history(page), latestIds)
  expect(state.requests.filter((url) => url.searchParams.get("view") === "history")).toHaveLength(
    historyReads,
  )
})
