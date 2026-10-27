import type { DurableEntryItem, DurableTaskItem } from "@narumitw/sumire-contracts"
import { expect, type Page, test } from "@playwright/test"
import { contrast } from "./contrast.js"
import { durableFixture } from "./durable-fixture.js"

const userText = "Read README.md and summarize the setup steps."
const toolText = "Install Node.js 26 or newer.\nRun npm ci.\nRun npm run build."
const userContent: NonNullable<DurableEntryItem["content"]> = {
  truncated: false,
  messages: [{ role: "user", content: [{ type: "text", text: userText }] }],
}
const toolContent: NonNullable<DurableEntryItem["content"]> = {
  truncated: false,
  messages: [
    {
      role: "toolResult",
      toolName: "read",
      toolCallId: "call-1",
      isError: false,
      content: [{ type: "text", text: toolText }],
    },
  ],
}
const modelTask: DurableTaskItem = {
  type: "task",
  id: 8,
  conversationId: 7,
  kind: "pi.generation",
  version: 1,
  background: false,
  abortRequested: false,
  status: "terminal",
  outcome: "completed",
}
const userEntry: DurableEntryItem = {
  type: "entry",
  id: 70,
  conversationId: 7,
  kind: "pi.user",
  role: "user",
  byTaskId: 8,
  timestamp: Date.UTC(2026, 9, 20, 10, 24),
}
const toolEntry: DurableEntryItem = {
  type: "entry",
  id: 71,
  conversationId: 7,
  kind: "pi.tool-result",
  role: "toolResult",
  byTaskId: 81,
  toolName: "read",
  toolCallId: "call-1",
  isError: false,
  timestamp: Date.UTC(2026, 9, 20, 10, 24, 8),
}

async function fixture(page: Page, record: "user" | "tool", depth = 1) {
  const state = await durableFixture(page, "/?section=Durable")
  state.selectedConversation = { type: "conversation", id: 7, active: true }
  state.conversationItems = [state.selectedConversation]
  const tools: DurableTaskItem[] = Array.from({ length: depth }, (_, index) => ({
    ...modelTask,
    id: 81 + index,
    kind: "pi.tool",
    ownerTaskId: index === 0 ? 8 : 80 + index,
  }))
  state.taskItems = [modelTask, ...tools]
  const toolName =
    depth > 1
      ? "mcp__synthetic_namespace__tool_with_a_long_name_and_a_complete_readable_record_label"
      : "read"
  state.entryItems = [userEntry, { ...toolEntry, byTaskId: 80 + depth, toolName }]
  state.entryContent =
    record === "user"
      ? userContent
      : {
          ...toolContent,
          messages: toolContent.messages.map((message) => ({ ...message, toolName })),
        }
  await page.goto(
    `/?section=Durable&chat=42&view=entries&conversationId=7&objectId=${record === "user" ? 70 : 71}`,
  )
  await expect(page.locator(".durable-detail-heading")).toBeVisible()
  return state
}

function tree(page: Page) {
  return page.getByRole("region", { name: "Relationship tree", exact: true })
}

async function expand(page: Page, view: "conversations" | "tasks", id: number) {
  const row = tree(page)
    .locator(".durable-tree-row")
    .filter({
      has: page.locator(
        `.durable-record-link[href*="view=${view}"]:is([href$="objectId=${id}"], [href*="objectId=${id}&"])`,
      ),
    })
  await expect(row).toHaveCount(1)
  const button = row.locator(".durable-expand")
  await expect(button).toHaveAttribute("aria-expanded", "false")
  await button.click()
  await expect(button).toHaveAttribute("aria-expanded", "true")
}

async function openRecords(page: Page, width: number) {
  if (width < 1100) await page.locator(".durable-record-browser > summary").click()
}

for (const viewport of [
  { width: 1440, height: 900, font: "" },
  { width: 768, height: 1024, font: "" },
  { width: 390, height: 844, font: "" },
  { width: 320, height: 844, font: "" },
  { width: 320, height: 844, font: "Arial" },
  { width: 320, height: 844, font: "Verdana" },
]) {
  for (const record of ["user", "tool"] as const) {
    test(`real Durable workspace: ${record} at ${viewport.width}px${viewport.font ? ` with ${viewport.font} fallback font` : ""}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      const state = await fixture(page, record)
      if (viewport.font)
        await page.addStyleTag({
          content: `.radix-themes { --font-body: ${viewport.font}, sans-serif; --font-display: ${viewport.font}, sans-serif; }`,
        })
      await expect.poll(() => state.requests.length).toBe(3)
      const detail = page.getByRole("region", { name: "Selected item details", exact: true })
      await expect(detail).toBeVisible()
      const body = detail
        .locator(record === "user" ? ".durable-message-text" : ".durable-tool-output")
        .first()
      await expect(body).toContainText(record === "user" ? userText : "Install Node.js 26")
      expect(
        await body.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
      ).toBeGreaterThanOrEqual(14)
      const family = await body.evaluate((element) => getComputedStyle(element).fontFamily)
      if (record === "user") {
        expect(family).not.toContain("monospace")
        if (viewport.font) expect(family).toContain(viewport.font)
      } else expect(family).toContain("monospace")
      expect(await body.evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(
        true,
      )
      await expect(page.locator(".durable-history-context")).not.toHaveAttribute("open", "")
      await expect(page.locator(".durable-raw-collections")).not.toHaveAttribute("open", "")
      await expect(detail.locator(".durable-record-details")).not.toHaveAttribute("open", "")
      await expect(detail.locator(".durable-raw-data")).not.toHaveAttribute("open", "")
      await expect(page.locator(".durable-compact-list")).toBeHidden()
      if (viewport.width < 1100) {
        await expect(tree(page)).toBeHidden()
        expect((await body.boundingBox())?.y).toBeLessThan(viewport.height * 0.7)
        await testInfo.attach("workspace-geometry", {
          contentType: "application/json",
          body: JSON.stringify({
            viewport,
            pageHeading: await page.locator("#current-section-heading").boundingBox(),
            pageHeader: await page.locator(".workspace-header").boundingBox(),
            content: await body.boundingBox(),
          }),
        })
        if (viewport.font)
          await expect(page.locator(".durable-summary-header h2")).toHaveCSS(
            "font-family",
            new RegExp(viewport.font),
          )
        // Mobile content starts at 417px, or 451px with the wider fallback font.
        if (viewport.width <= 650) expect((await body.boundingBox())?.y).toBeLessThanOrEqual(464)
        await page.screenshot({ path: testInfo.outputPath("workspace-closed.png"), fullPage: true })
      } else {
        await expect(tree(page)).toBeVisible()
        const bounds = await tree(page).boundingBox()
        expect(bounds?.width).toBeGreaterThanOrEqual(288)
        expect(bounds?.width).toBeLessThanOrEqual(336)
        expect(bounds?.y).toBeLessThan(viewport.height)
      }
      await openRecords(page, viewport.width)
      await expand(page, "conversations", 7)
      await expand(page, "tasks", 8)
      await expand(page, "tasks", 81)
      const current = tree(page).locator('.durable-record-link[aria-current="true"]')
      await expect(current).toHaveCount(1)
      await expect(current).toHaveAttribute(
        "href",
        new RegExp(`objectId=${record === "user" ? 70 : 71}(?:&|$)`),
      )
      for (const element of await tree(page)
        .locator(".durable-tree-row :is(a, span, small, time)")
        .all()) {
        if (!(await element.isVisible()) || !(await element.innerText()).trim()) continue
        expect((await contrast(element)).text).toBeGreaterThanOrEqual(4.5)
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      )
      expect(state.methods.every((method) => method === "GET")).toBe(true)
      await page.screenshot({ path: testInfo.outputPath("workspace-expanded.png"), fullPage: true })
    })
  }
}

for (const width of [1440, 390, 320]) {
  test(`real deep Durable tree at ${width}px preserves detail height and full labels`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    await fixture(page, "tool", 14)
    const detail = page.getByRole("region", { name: "Selected item details", exact: true })
    await openRecords(page, width)
    const before = await detail.boundingBox()
    await expand(page, "conversations", 7)
    await expand(page, "tasks", 8)
    for (let id = 81; id <= 94; id++) await expand(page, "tasks", id)
    const after = await detail.boundingBox()
    expect(Math.abs((after?.height ?? 0) - (before?.height ?? 0))).toBeLessThanOrEqual(1)
    const browser = page.locator(".durable-record-browser")
    expect(await browser.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    )
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const last = tree(page).locator(
      '.durable-record-link[href*="view=entries"][href*="objectId=71"]',
    )
    await last.scrollIntoViewIfNeeded()
    await expect(last).toBeInViewport()
    await expect(last).toContainText("complete_readable_record_label")
    expect(
      await last
        .locator(".durable-row-label")
        .evaluate(
          (element) =>
            element.scrollWidth <= element.clientWidth + 1 &&
            element.scrollHeight <= element.clientHeight + 1,
        ),
    ).toBe(true)
    await page.keyboard.press("Tab")
    await page.screenshot({ path: testInfo.outputPath("workspace-deep.png"), fullPage: true })
  })
}

for (const width of [390, 320]) {
  test(`mobile chat switching preserves full-width rows and labeled controls at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 })
    await fixture(page, "user")
    const selector = page.getByRole("region", { name: "Find a chat", exact: true })
    await selector.getByLabel("Find or switch chat", { exact: true }).click()
    const list = selector.getByRole("list", { name: "Chats on this page", exact: true })
    await expect(list).toBeVisible()
    const row = list.getByRole("button").first()
    const rowBox = await row.boundingBox()
    const listBox = await list.boundingBox()
    expect(rowBox?.width).toBeGreaterThan(100)
    expect(rowBox?.width).toBeGreaterThanOrEqual((listBox?.width ?? 0) - 4)
    for (const name of ["Previous chats", "Next chats"])
      await expect(selector.getByRole("button", { name, exact: true })).toHaveCount(0)
    const refresh = selector.getByRole("button", { name: "Refresh chats", exact: true })
    await expect(refresh).toBeVisible()
    const bounds = await refresh.boundingBox()
    expect(bounds?.width).toBeGreaterThan(44)
    expect(bounds?.height).toBeGreaterThanOrEqual(44)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await list.getByRole("button").filter({ hasText: "Idle chat" }).click()
    await expect(page).toHaveURL(/chat=43/)
    await expect(page.getByRole("heading", { name: "Idle chat", exact: true })).toBeVisible()
    await expect(selector.locator("details").first()).not.toHaveAttribute("open", "")
  })
}

test("mobile record selection closes navigation, focuses content, and retains expanded branches", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const state = await fixture(page, "user")
  await openRecords(page, 390)
  await expand(page, "conversations", 7)
  await expand(page, "tasks", 8)
  await expand(page, "tasks", 81)
  const before = await tree(page).locator('.durable-expand[aria-expanded="true"]').count()
  state.entryContent = toolContent
  await tree(page)
    .locator('.durable-record-link[href*="view=entries"][href*="objectId=71"]')
    .click()
  await expect(page).toHaveURL(/objectId=71/)
  await expect(tree(page)).toBeHidden()
  await expect(page.locator(".durable-detail-heading")).toBeFocused()
  await expect(page.locator(".durable-tool-output")).toContainText(toolText)
  await openRecords(page, 390)
  await expect(tree(page).locator('.durable-expand[aria-expanded="true"]')).toHaveCount(before)
  await expect(tree(page).locator('.durable-record-link[aria-current="true"]')).toHaveAttribute(
    "href",
    /objectId=71(?:&|$)/,
  )
})
