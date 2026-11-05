import { expect, type Page, test } from "@playwright/test"
import { durableFixture } from "./durable-fixture.js"

const directory = (page: Page) =>
  page.getByRole("complementary", { name: "Conversation chat directory", exact: true })
const inspector = (page: Page) =>
  page.getByRole("region", { name: "Durable Inspector", exact: true })
const history = (page: Page) =>
  inspector(page).getByRole("region", { name: "Conversation history", exact: true })

for (const width of [1440, 1024, 390, 320]) {
  test(`conversation directory requires explicit selection and stays bounded at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    const writes: string[] = []
    page.on("request", (request) => {
      if (request.url().includes("/api/") && request.method() !== "GET") writes.push(request.url())
    })
    const state = await durableFixture(page, "/?section=Durable")
    await expect(directory(page).getByLabel("Search stored chats")).toBeVisible()
    await expect(inspector(page).getByText("Read-only", { exact: true })).toBeVisible()
    await expect(
      inspector(page).getByRole("heading", { name: "Choose a chat", exact: true }),
    ).toBeVisible()
    await expect(inspector(page)).toContainText("No chat is selected.")
    await expect(directory(page).getByRole("list")).toBeVisible()
    expect(state.requests).toHaveLength(0)
    if (width >= 1100) {
      const pane = await directory(page).boundingBox()
      const reader = await page.locator(".durable-reader-pane").boundingBox()
      expect(pane?.width).toBeGreaterThanOrEqual(280)
      expect(pane?.width).toBeLessThanOrEqual(320)
      expect(reader?.x).toBeGreaterThanOrEqual((pane?.x ?? 0) + (pane?.width ?? 0))
    }
    await directory(page).getByLabel("Search stored chats").fill("Loaded chat")
    await expect(
      directory(page).getByRole("button", { name: "Loaded chat · 42", exact: true }),
    ).toBeVisible()
    expect(state.requests).toHaveLength(0)
    await directory(page).getByRole("button", { name: "Loaded chat · 42", exact: true }).click()
    await expect(
      history(page).getByRole("heading", { name: "History · conversation 7", exact: true }),
    ).toBeVisible()
    await expect(page).toHaveURL(/section=Durable&chat=42/)
    await expect(history(page)).toContainText("9 matching / 9 loaded records")
    if (width >= 1100)
      await expect(directory(page).locator(".durable-chat-picker")).toHaveAttribute("open", "")
    else
      await expect(directory(page).locator(".durable-chat-picker")).not.toHaveAttribute("open", "")
    expect(state.requests).toHaveLength(3)
    expect(state.requests.every((url) => url.searchParams.get("limit") === "25")).toBe(true)
    const count = state.requests.length
    await history(page).getByLabel("Search loaded page").fill("not-in-the-loaded-page")
    await expect(history(page)).toContainText("No matches on the loaded page.")
    expect(state.requests).toHaveLength(count)
    await history(page).getByLabel("Search loaded page").fill("")
    await inspector(page).getByRole("button", { name: "Refresh records", exact: true }).click()
    await expect.poll(() => state.requests.length).toBe(count + 3)
    await expect(history(page)).toContainText("9 matching / 9 loaded records")
    expect(state.methods.every((method) => method === "GET")).toBe(true)
    expect(writes).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}

test("switching chats distinguishes unloaded, empty, and failed record reads", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const state = await durableFixture(page, "/?section=Durable")
  await directory(page).getByRole("button", { name: "Unloaded chat · 44", exact: true }).click()
  await expect(
    inspector(page).getByRole("heading", { name: "Not loaded", exact: true }),
  ).toBeVisible()
  await expect(inspector(page)).toContainText(
    "Inspection will not open its database or start a session.",
  )
  expect(state.requests).toHaveLength(1)
  await directory(page).getByRole("button", { name: "Idle chat · 43", exact: true }).click()
  await expect(inspector(page)).toContainText("No persisted conversation is available.")
  state.empty = true
  await directory(page).getByRole("button", { name: "Loaded chat · 42", exact: true }).click()
  await expect(history(page)).toContainText("No saved entries on this page.")
  state.failed = true
  await inspector(page).getByRole("button", { name: "Refresh records", exact: true }).click()
  await expect(
    inspector(page).getByRole("alert").filter({ hasText: "Read failed." }).first(),
  ).toBeVisible()
  await expect(
    inspector(page).getByText("No saved entries on this page.", { exact: true }),
  ).toHaveCount(0)
  expect(state.requests.every((url) => url.searchParams.get("limit") === "25")).toBe(true)
  expect(state.methods.every((method) => method === "GET")).toBe(true)
})
