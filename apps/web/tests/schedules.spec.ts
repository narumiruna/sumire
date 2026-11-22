import type { Schedule } from "@narumitw/sumire-contracts"
import { expect, type Page, test } from "@playwright/test"
import { adminFixture, basePolicy, navigate } from "./admin-fixture.js"

test.use({ timezoneId: "Asia/Taipei" })
const future = Date.parse("2026-11-21T01:30:00Z")
const task: Schedule = {
  id: "45bc065b-0593-4804-bfa5-39a1c2cfb77f",
  revision: 1,
  chatId: 42,
  task: "整理今天的科技新聞，列出三個重點與來源。\n這是合成測試資料，不是真實排程。",
  runAt: future,
  timeZone: "Asia/Taipei",
  repeatMinutes: 1440,
  state: "active",
  createdAt: future - 86400_000,
  nextRunAt: future,
  lastRunAt: null,
  lastOutcome: null,
}
async function fixture(page: Page, initial: Schedule[] = [], lostCreation = false) {
  await page.clock.setFixedTime(new Date("2026-11-20T00:00:00Z"))
  await adminFixture(page)
  let items = structuredClone(initial)
  let dropped = false
  const writes: { method: string; body: Record<string, unknown> }[] = []
  await page.route("**/api/schedules**", async (route) => {
    const req = route.request()
    const id = new URL(req.url()).pathname.split("/")[3]
    const method = req.method()
    if (method === "GET") return route.fulfill({ json: { items, limit: 100 } })
    expect(req.headers()["x-csrf-token"]).toBe("fixture")
    const body = req.postDataJSON()
    writes.push({ method, body })
    if (method === "POST") {
      let created = items.find((item) => item.id === body.requestId)
      if (!created) {
        created = {
          ...body,
          id: body.requestId,
          revision: 1,
          state: "active",
          createdAt: Date.now(),
          nextRunAt: body.runAt,
          lastRunAt: null,
          lastOutcome: null,
        }
        if (!created) throw new Error("Missing fixture task")
        items.unshift(created)
      }
      if (lostCreation && !dropped) {
        dropped = true
        return route.abort("failed")
      }
      return route.fulfill({ status: 201, json: created })
    }
    const item = items.find((value) => value.id === id)
    if (!item || body.revision !== item.revision)
      return route.fulfill({
        status: 409,
        json: { error: "Schedule changed; refresh before trying again" },
      })
    if (method === "PUT") {
      item.revision++
      item.state = body.action === "pause" ? "paused" : "active"
      return route.fulfill({ json: item })
    }
    if (method === "DELETE") {
      items = items.filter((value) => value.id !== id)
      return route.fulfill({ json: { deleted: true } })
    }
    throw new Error(`Unexpected schedule method ${method}`)
  })
  await navigate(page, "Schedule")
  await expect(page.getByRole("heading", { name: "Scheduled tasks", exact: true })).toBeVisible()
  return { writes, items: () => items }
}

for (const width of [320, 390, 1440]) {
  test(`schedule management at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width < 400 ? 844 : 1050 })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    const state = await fixture(page, [task])
    const card = page.locator(".schedule-card").filter({ hasText: task.task })
    await expect(card).toBeVisible()
    await card.getByRole("button", { name: "Pause", exact: true }).click()
    await expect(card.getByText("Paused", { exact: true })).toBeVisible()
    page.once("dialog", (dialog) => dialog.accept())
    await card.getByRole("button", { name: "Resume", exact: true }).click()
    await expect(card.getByText("Active", { exact: true })).toBeVisible()
    await page.getByRole("button", { name: "Add task", exact: true }).click()
    const literal = "查詢測試內容 <img src=x onerror=window.scheduleInjected=true>"
    await page.getByLabel("Task (user message)", { exact: true }).fill(literal)
    await page.getByLabel("Target chat", { exact: true }).selectOption("-100")
    await page.getByLabel("First execution", { exact: true }).fill("2026-11-21T09:30")
    await page.getByLabel("Repeat", { exact: true }).selectOption("once")
    await expect(page.locator(".schedule-preview")).toContainText("GMT+8")
    await expect(page.locator("#schedule-time-help")).toContainText("Asia/Taipei")
    await page.screenshot({
      animations: "disabled",
      fullPage: true,
      path: info.outputPath(`schedule-editor-${width}.png`),
    })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.getByRole("button", { name: "Create schedule", exact: true }).click()
    const added = page.locator(".schedule-card").filter({ hasText: literal })
    await expect(added).toBeVisible()
    await expect(added.locator("img")).toHaveCount(0)
    expect(
      await page.evaluate(
        () => (window as unknown as { scheduleInjected?: boolean }).scheduleInjected,
      ),
    ).toBeUndefined()
    expect(state.writes.find((entry) => entry.method === "POST")?.body).toMatchObject({
      task: literal,
      chatId: -100,
      runAt: future,
      timeZone: "Asia/Taipei",
      repeatMinutes: null,
    })
    page.once("dialog", (dialog) => dialog.accept())
    await added.getByRole("button", { name: "Delete", exact: true }).click()
    await expect(added).toHaveCount(0)
    await page.screenshot({
      animations: "disabled",
      fullPage: true,
      path: info.outputPath(`schedule-list-${width}.png`),
    })
    expect(state.writes.map((entry) => entry.method)).toEqual(["PUT", "PUT", "POST", "DELETE"])
    expect(errors).toEqual([])
  })
}

test("keeps execution details collapsed and available by keyboard", async ({ page }) => {
  const state = await fixture(page)
  const help = page.getByText("How scheduled tasks run", { exact: true })
  const executionRules = page.getByText("Pause and delete prevent future dispatches", {
    exact: false,
  })
  await expect(help).toBeVisible()
  await expect(executionRules).toBeHidden()
  await help.press("Enter")
  await expect(executionRules).toBeVisible()
  await help.press("Enter")
  await expect(executionRules).toBeHidden()
  expect(state.writes).toEqual([])
})

test("keeps the draft and reuses its creation key after an ambiguous network failure", async ({
  page,
}) => {
  const state = await fixture(page, [], true)
  await expect(page.getByRole("heading", { name: "No scheduled tasks", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Add task", exact: true }).click()
  await page.getByLabel("Task (user message)", { exact: true }).fill("Fixture retry task")
  await page.getByLabel("First execution", { exact: true }).fill("2026-11-21T09:30")
  await page.getByRole("button", { name: "Create schedule", exact: true }).click()
  await expect(page.getByRole("alert")).toBeVisible()
  await expect(page.getByLabel("Task (user message)", { exact: true })).toHaveValue(
    "Fixture retry task",
  )
  await page.getByRole("button", { name: "Create schedule", exact: true }).click()
  await expect(page.getByLabel("Task (user message)", { exact: true })).toHaveCount(0)
  expect(state.writes.filter((entry) => entry.method === "POST")).toHaveLength(2)
  expect(state.writes[0]?.body.requestId).toBe(state.writes[1]?.body.requestId)
  expect(state.items()).toHaveLength(1)
})

test("preserves the schedule draft across navigation and supports a deep link", async ({
  page,
}) => {
  const state = await fixture(page)
  await page.getByRole("button", { name: "Add task", exact: true }).click()
  await page.getByLabel("Task (user message)", { exact: true }).fill("Unsent schedule draft")
  await navigate(page, "Defaults")
  await navigate(page, "Schedule")
  await expect(page.getByLabel("Task (user message)", { exact: true })).toHaveValue(
    "Unsent schedule draft",
  )
  expect(state.writes).toEqual([])
  page.once("dialog", (dialog) => dialog.accept())
  await page.goto("/?section=Schedule&chat=42")
  await expect(page.getByRole("heading", { name: "Schedule", exact: true })).toBeVisible()
  expect(state.writes).toEqual([])
})

test("keeps an allowed destination and replaces it when access is revoked", async ({ page }) => {
  const state = await fixture(page)
  await page.getByRole("button", { name: "Add task", exact: true }).click()
  const destination = page.getByLabel("Target chat", { exact: true })
  await destination.selectOption("-100")

  let groups = [-101, -100]
  let revision = 1
  await page.route("**/api/settings", (route) =>
    route.fulfill({
      json: {
        revision,
        applied: revision,
        status: "applied",
        policy: { ...basePolicy, privateUsers: [], groups },
      },
    }),
  )
  const refreshPolicy = async () => {
    revision++
    await navigate(page, "Defaults")
    const refresh = page.getByRole("button", { name: "Refresh settings", exact: true })
    await refresh.click()
    await expect(refresh).toBeEnabled()
    await navigate(page, "Schedule")
  }

  await refreshPolicy()
  await expect(destination.locator("option")).toHaveCount(3)
  await expect(destination).toHaveValue("-100")

  groups = [-101]
  await refreshPolicy()
  await expect(destination).toHaveValue("-101")
  await expect(page.locator(".schedule-preview")).toContainText("→ -101")
  await page.getByLabel("Task (user message)", { exact: true }).fill("Fixture policy change")
  await page.getByRole("button", { name: "Create schedule", exact: true }).click()
  await expect(page.locator(".schedule-card")).toContainText("Fixture policy change")
  expect(state.writes.map((entry) => entry.body.chatId)).toEqual([-101])
})

test("requires confirmation for overdue resumption and cannot resume an uncertain attempt", async ({
  page,
}) => {
  const overdue = {
    ...task,
    repeatMinutes: null,
    state: "paused",
    nextRunAt: Date.parse("2026-11-19T00:00:00Z"),
  } as Schedule
  const uncertain = {
    ...task,
    id: "01234567-0123-4123-8123-012345678901",
    state: "paused",
    lastOutcome: "interrupted",
    lastRunAt: future - 86400_000,
  } as Schedule
  const state = await fixture(page, [overdue, uncertain])
  const cards = page.locator(".schedule-card")
  await expect(cards.nth(1).getByRole("button", { name: "Resume", exact: true })).toBeDisabled()
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("overdue")
    await dialog.dismiss()
  })
  await cards.first().getByRole("button", { name: "Resume", exact: true }).click()
  expect(state.writes).toEqual([])
  await page.getByLabel("Status", { exact: true }).selectOption("active")
  await expect(page.getByRole("heading", { name: "No tasks with this status" })).toBeVisible()
})

for (const [locale, heading, add] of [
  ["zh-TW", "排程管理", "新增任務"],
  ["ja", "スケジュール", "タスクを追加"],
] as const) {
  test(`localizes the schedule page in ${locale}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await fixture(page, [task])
    await page.evaluate((value) => localStorage.setItem("sumire.admin.locale", value), locale)
    await page.reload()
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible()
    await page.getByRole("button", { name: add, exact: true }).click()
    await expect(page.locator("#schedule-task-input")).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({
      animations: "disabled",
      fullPage: true,
      path: info.outputPath(`schedule-${locale}.png`),
    })
  })
}

test("warns beside Pause only when an attempt is running or queued", async ({ page }) => {
  const state = await fixture(page, [
    { ...task, lastOutcome: "running", lastRunAt: future - 1000 },
    { ...task, id: "45bc065b-0593-4804-bfa5-39a1c2cfb77e", task: "Not running" },
  ])
  const running = page.locator(".schedule-card").filter({ hasText: task.task })
  const idle = page.locator(".schedule-card").filter({ hasText: "Not running" })
  const pause = running.getByRole("button", { name: "Pause", exact: true })
  const warning = "Pausing does not stop this running or queued attempt."
  await expect(running.getByText(warning, { exact: true })).toBeVisible()
  await expect(pause).toHaveAccessibleDescription(warning)
  await expect(idle.getByRole("button", { name: "Pause", exact: true })).not.toHaveAttribute(
    "aria-describedby",
  )
  await pause.click()
  await expect(running.getByText("Paused", { exact: true })).toBeVisible()
  await expect(running.getByText(warning, { exact: true })).toHaveCount(0)
  expect(state.writes.map((entry) => entry.method)).toEqual(["PUT"])
})

test("shows a paused schedule separately from its already-running attempt", async ({ page }) => {
  await fixture(page, [
    { ...task, state: "paused", lastOutcome: "running", lastRunAt: future - 1000 },
  ])
  const card = page.locator(".schedule-card")
  await expect(card.getByText("Paused", { exact: true })).toBeVisible()
  await expect(card.getByText(/Running \/ queued/)).toBeVisible()
  await expect(card.getByRole("button", { name: "Resume", exact: true })).toBeDisabled()
})

test("retains the list after a revision conflict and refreshes before retrying", async ({
  page,
}) => {
  const state = await fixture(page, [task])
  const card = page.locator(".schedule-card")
  await expect(card).toBeVisible()
  const changed = state.items()[0]
  if (!changed) throw new Error("Missing fixture task")
  changed.revision++
  await card.getByRole("button", { name: "Pause", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("Schedule changed")
  await expect(card).toBeVisible()
  await page.getByRole("button", { name: "Refresh tasks", exact: true }).click()
  await expect(page.getByRole("alert")).toHaveCount(0)
  await card.getByRole("button", { name: "Pause", exact: true }).click()
  await expect(card.getByText("Paused", { exact: true })).toBeVisible()
  expect(state.writes.map((entry) => entry.body.revision)).toEqual([1, 2])
})

test("returns to passkey sign-in when a mutation finds an expired session", async ({ page }) => {
  await fixture(page, [task])
  await page.route(`**/api/schedules/${task.id}`, (route) =>
    route.fulfill({ status: 401, json: { error: "Sign in with a passkey" } }),
  )
  await page.locator(".schedule-card").getByRole("button", { name: "Pause", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Sign in with passkey", exact: true }),
  ).toBeVisible()
  await expect(page.locator(".schedule-workspace")).toHaveCount(0)
})

for (const width of [900, 1440]) {
  test(`keeps schedule navigation and rail controls clear of feedback at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 720 })
    await fixture(page)
    const clearOfRail = async () => {
      const rail = await page.locator(".sidebar").boundingBox()
      const feedback = await page.locator(".feedback-launcher").boundingBox()
      expect(rail).not.toBeNull()
      expect(feedback?.x).toBeGreaterThanOrEqual((rail?.width ?? 0) + 8)
    }
    await clearOfRail()
    await page.getByRole("button", { name: "Expand navigation", exact: true }).click()
    await clearOfRail()
    await page.getByRole("button", { name: "Collapse navigation", exact: true }).click()
    await navigate(page, "Audit")
    await navigate(page, "Schedule")
    await expect(page.getByRole("heading", { name: "Schedule", exact: true })).toBeVisible()
  })
}
