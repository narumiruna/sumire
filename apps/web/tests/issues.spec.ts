import type {
  AnalysisReport,
  Feedback,
  Issue,
  IssueAnalysis,
  IssuePage,
} from "@narumitw/sumire-issues"
import { expect, type Page, test } from "@playwright/test"
import { adminFixture, navigate } from "./admin-fixture.js"

async function fixture(page: Page, pageSize = Infinity) {
  await adminFixture(page)
  const state: { issues: Issue[]; submissions: Feedback[]; screenshots: number; reads: string[] } =
    {
      issues: [],
      submissions: [],
      screenshots: 0,
      reads: [],
    }
  page.on("request", (request) => {
    const { pathname, search } = new URL(request.url())
    if (
      request.method() === "GET" &&
      (pathname === "/api/issues" || /^\/api\/issues(?:-mcp)?\//.test(pathname))
    )
      state.reads.push(`${pathname}${search}`)
  })
  await page.route("**/api/issues**", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname.endsWith("/screenshot")) {
      state.screenshots++
      await route.fulfill({
        body: Buffer.from(state.submissions[0]?.screenshot ?? "", "base64"),
        contentType: "image/png",
      })
      return
    }
    if (url.pathname.includes("/analysis")) {
      await route.fulfill({ json: { available: false, analyses: [] } })
      return
    }
    const id = Number(url.pathname.split("/")[3])
    const issue = state.issues.find((value) => value.id === id)
    if (request.method() === "GET") {
      if (id)
        await route.fulfill(
          issue ? { json: issue } : { status: 404, json: { error: "Issue not found" } },
        )
      else {
        const filter = url.searchParams.get("state")
        const before = Number(url.searchParams.get("before") ?? Infinity)
        const matches = state.issues
          .filter((value) => value.id < before && (!filter || value.state === filter))
          .sort((a, b) => b.id - a.id)
        const issues = matches.slice(0, pageSize)
        const response: IssuePage = {
          issues,
          next: matches.length > issues.length ? (issues.at(-1)?.id ?? null) : null,
        }
        await route.fulfill({ json: response })
      }
    } else if (request.method() === "POST") {
      expect(request.headers()["x-csrf-token"]).toBe("fixture")
      const input = request.postDataJSON() as Feedback
      state.submissions.push(input)
      const issue: Issue = {
        id: state.issues.length + 1,
        title: input.description || "畫面回饋",
        description: input.description,
        state: "open",
        source: input.source,
        section: input.source.section,
        hasScreenshot: Boolean(input.screenshot),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        revision: 1,
      }
      state.issues.unshift(issue)
      await route.fulfill({ status: 201, json: issue })
    } else if (request.method() === "PUT" && issue) {
      issue.state = request.postDataJSON().state
      issue.revision++
      await route.fulfill({ json: issue })
    } else if (request.method() === "DELETE" && issue) {
      state.issues = state.issues.filter((value) => value.id !== id)
      await route.fulfill({ json: { ok: true } })
    } else await route.fulfill({ status: 404, json: { error: "Not found" } })
  })
  return state
}

function sampleIssue(id: number, title: string, overrides: Partial<Issue> = {}): Issue {
  const section = overrides.section ?? "Defaults"
  const updatedAt = Date.UTC(2025, 1, 7, 14, 15)
  return {
    id,
    title,
    description: "Fixture report text",
    section,
    source: { section, viewport: { width: 1440, height: 900 } },
    state: "open",
    hasScreenshot: false,
    createdAt: updatedAt,
    updatedAt,
    revision: 1,
    ...overrides,
  }
}

function filters(page: Page) {
  return page.getByRole("group", { name: "Filter issues by status", exact: true })
}

function issueTitle(page: Page, title: string) {
  return page.getByRole("button", { name: title, exact: true })
}

function listStatus(page: Page, text: string) {
  return page.getByRole("status").and(page.getByText(text, { exact: true }))
}

function pageCount(page: Page, count: number) {
  return listStatus(page, `On this page: ${count}`)
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test("filters and pages feedback with exact cursors, including refresh", async ({ page }) => {
  const state = await fixture(page, 2)
  state.issues.push(
    sampleIssue(4, "Newest report"),
    sampleIssue(3, "Resolved report", { state: "closed" }),
    sampleIssue(2, "Earlier report"),
    sampleIssue(1, "Oldest report"),
  )
  await navigate(page, "Issues")
  const all = filters(page).getByRole("button", { name: "All", exact: true })
  const open = filters(page).getByRole("button", { name: "Open", exact: true })
  const closed = filters(page).getByRole("button", { name: "Closed", exact: true })
  const previous = page.getByRole("button", { name: "Previous page", exact: true })
  const next = page.getByRole("button", { name: "Next page", exact: true })
  const titles = page.getByRole("table").getByRole("button")
  await expect(all).toHaveAttribute("aria-pressed", "true")
  await expect(previous).toBeDisabled()
  await expect(titles).toHaveText(["Newest report", "Resolved report"])
  await expect(pageCount(page, 2)).toBeVisible()

  await next.press("Enter")
  await expect(titles).toHaveText(["Earlier report", "Oldest report"])
  await expect(next).toBeDisabled()
  await open.press("Space")
  await expect(open).toHaveAttribute("aria-pressed", "true")
  await expect(all).toHaveAttribute("aria-pressed", "false")
  await expect(titles).toHaveText(["Newest report", "Earlier report"])
  await expect(previous).toBeDisabled()

  await next.press("Enter")
  await expect(titles).toHaveText(["Oldest report"])
  await expect(pageCount(page, 1)).toBeVisible()
  await Promise.all([
    page.waitForResponse((response) => {
      const { pathname, search } = new URL(response.url())
      return pathname === "/api/issues" && search === "?state=open&before=2"
    }),
    page.getByRole("button", { name: "Refresh list", exact: true }).click(),
  ])
  await expect(titles).toHaveText(["Oldest report"])
  await expect(open).toHaveAttribute("aria-pressed", "true")
  await open.press("Enter")
  await expect(previous).toBeEnabled()
  await expect(titles).toHaveText(["Oldest report"])
  expect(state.reads).toEqual([
    "/api/issues",
    "/api/issues?before=3",
    "/api/issues?state=open",
    "/api/issues?state=open&before=2",
    "/api/issues?state=open&before=2",
  ])

  await previous.press("Enter")
  await expect(titles).toHaveText(["Newest report", "Earlier report"])
  await closed.press("Space")
  await expect(closed).toHaveAttribute("aria-pressed", "true")
  await expect(open).toHaveAttribute("aria-pressed", "false")
  await expect(titles).toHaveText(["Resolved report"])
  expect(state.reads.slice(5)).toEqual(["/api/issues?state=open", "/api/issues?state=closed"])
})

test("a superseded delayed filter response cannot replace the current empty page", async ({
  page,
}) => {
  const state = await fixture(page)
  const issue = sampleIssue(1, "Open report")
  state.issues.push(issue)
  const staleQuery = (url: URL) => url.pathname === "/api/issues" && url.search === "?state=open"
  const release = deferred()
  const settled = deferred()
  page.on("requestfinished", (request) => {
    if (staleQuery(new URL(request.url()))) settled.resolve()
  })
  page.on("requestfailed", (request) => {
    if (staleQuery(new URL(request.url()))) settled.resolve()
  })
  await page.route(staleQuery, async (route) => {
    await release.promise
    await route.fulfill({ json: { issues: [issue], next: null } satisfies IssuePage })
  })

  try {
    await navigate(page, "Issues")
    const title = issueTitle(page, issue.title)
    await expect(title).toBeVisible()
    await filters(page).getByRole("button", { name: "Open", exact: true }).click()
    await expect.poll(() => state.reads).toEqual(["/api/issues", "/api/issues?state=open"])
    await expect(listStatus(page, "Loading feedback…")).toBeVisible()
    await expect(title).toHaveCount(0)
    const closed = filters(page).getByRole("button", { name: "Closed", exact: true })
    await closed.click()
    const empty = listStatus(page, "No feedback matches this filter.")
    await expect(empty).toBeVisible()
    release.resolve()
    await settled.promise
    // Let the browser process any late result before checking that the empty page persists.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
    await expect(empty).toBeVisible()
    await expect(pageCount(page, 0)).toBeVisible()
    await expect(title).toHaveCount(0)
    await expect(closed).toHaveAttribute("aria-pressed", "true")
    expect(state.reads).toEqual([
      "/api/issues",
      "/api/issues?state=open",
      "/api/issues?state=closed",
    ])
  } finally {
    release.resolve()
  }
})

test("changing language updates the list in place without reading the Issues API", async ({
  page,
}) => {
  const state = await fixture(page, 1)
  const issue = sampleIssue(1, "A report in the author's language", {
    section: "設定ページ",
    hasScreenshot: true,
  })
  state.issues.push(
    sampleIssue(3, "Resolved report", { state: "closed" }),
    sampleIssue(2, "Newest report"),
    issue,
  )
  await navigate(page, "Issues")
  await expect(issueTitle(page, "Resolved report")).toBeVisible()
  await filters(page).getByRole("button", { name: "Open", exact: true }).click()
  await expect(issueTitle(page, "Newest report")).toBeVisible()
  await page.getByRole("button", { name: "Next page", exact: true }).click()
  const title = issueTitle(page, issue.title)
  await expect(title).toBeVisible()
  const reads = ["/api/issues", "/api/issues?state=open", "/api/issues?state=open&before=2"]
  expect(state.reads).toEqual(reads)

  const language = page.locator(".language-selector select")
  for (const [locale, filter, open, tableName, source, screenshot, previous, count] of [
    [
      "en",
      "Filter issues by status",
      "Open",
      "Feedback list",
      "Source page",
      "Screenshot attached",
      "Previous page",
      "On this page: 1",
    ],
    [
      "ja",
      "フィードバックを状態で絞り込む",
      "オープン",
      "フィードバック一覧",
      "報告元のページ",
      "スクリーンショット付き",
      "前のページ",
      "このページに 1 件",
    ],
    [
      "zh-TW",
      "依狀態篩選回饋",
      "開啟中",
      "回饋清單",
      "來源頁面",
      "附有截圖",
      "上一頁",
      "本頁 1 筆",
    ],
  ] as const) {
    await language.selectOption(locale)
    await expect(page.locator("html")).toHaveAttribute("lang", locale)
    const group = page.getByRole("group", { name: filter, exact: true })
    await expect(group.getByRole("button", { name: open, exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    const table = page.getByRole("table", { name: tableName, exact: true })
    await expect(table.getByRole("columnheader", { name: source, exact: true })).toBeVisible()
    await expect(table.getByRole("cell", { name: issue.section, exact: true })).toBeVisible()
    await expect(table.getByRole("cell", { name: open, exact: true })).toBeVisible()
    await expect(title).toHaveAccessibleDescription(`#1 ${screenshot}`)
    await expect(listStatus(page, count)).toBeVisible()
    await expect(page.getByRole("button", { name: previous, exact: true })).toBeEnabled()
    const time = table.locator("time")
    await expect(time).toHaveAttribute("datetime", new Date(issue.updatedAt).toISOString())
    const formatted = await page.evaluate(
      ({ locale, updatedAt }) =>
        new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
          updatedAt,
        ),
      { locale, updatedAt: issue.updatedAt },
    )
    await expect(time).toHaveText(formatted)
    expect(state.reads).toEqual(reads)
  }
  await page.getByRole("button", { name: "重新整理清單", exact: true }).click()
  await expect.poll(() => state.reads).toEqual([...reads, "/api/issues?state=open&before=2"])
  await expect(title).toBeVisible()
})

test("keyboard return restores the title, or focuses the filter if the row is gone", async ({
  page,
}) => {
  const state = await fixture(page, 1)
  state.issues.push(
    sampleIssue(3, "Resolved report", { state: "closed" }),
    sampleIssue(2, "Newest report"),
    sampleIssue(1, "Earlier report"),
  )
  await navigate(page, "Issues")
  await expect(issueTitle(page, "Resolved report")).toBeVisible()
  const open = filters(page).getByRole("button", { name: "Open", exact: true })
  await filters(page).getByRole("button", { name: "All", exact: true }).focus()
  await page.keyboard.press("Tab")
  await expect(open).toBeFocused()
  await page.keyboard.press("Space")
  await expect(issueTitle(page, "Newest report")).toBeVisible()
  await page.getByRole("button", { name: "Next page", exact: true }).press("Enter")
  const earlier = issueTitle(page, "Earlier report")
  const selection = page.getByRole("heading", { name: "#1 Earlier report", exact: true })
  const back = page.getByRole("button", { name: "返回列表", exact: true })
  const listReads = () => state.reads.filter((read) => /^\/api\/issues(?:\?|$)/.test(read))
  const pages = ["/api/issues", "/api/issues?state=open", "/api/issues?state=open&before=2"]
  await earlier.press("Enter")
  await expect(selection).toBeVisible()
  expect(state.reads).toContain("/api/issues/1")
  await expect(back).toBeEnabled()
  await back.press("Enter")
  await expect(earlier).toBeFocused()
  await expect(open).toHaveAttribute("aria-pressed", "true")
  await expect(page.getByRole("button", { name: "Previous page", exact: true })).toBeEnabled()
  expect(listReads()).toEqual(pages)

  const release = deferred()
  await page.route(
    (url) => url.pathname === "/api/issues" && url.search === "?state=open&before=2",
    async (route) => {
      await release.promise
      await route.fallback()
    },
  )
  try {
    await page.keyboard.press("Enter")
    await expect(selection).toBeVisible()
    const close = page.getByRole("button", { name: "關閉回饋", exact: true })
    await expect(close).toBeEnabled()
    await close.press("Enter")
    await expect(page.getByRole("button", { name: "重新開啟", exact: true })).toBeVisible()
    await expect(back).toBeEnabled()
    await back.press("Enter")
    await expect(listStatus(page, "Loading feedback…")).toBeVisible()
    release.resolve()
    await expect(listStatus(page, "No feedback matches this filter.")).toBeVisible()
    await expect(open).toBeFocused()
    await expect(earlier).toHaveCount(0)
    expect(listReads()).toEqual([...pages, "/api/issues?state=open&before=2"])
  } finally {
    release.resolve()
  }
})

for (const [width, fontScale] of [
  [320, 100],
  [390, 100],
  [320, 200],
  [390, 200],
] as const) {
  test(`the list fits at ${width}px and ${fontScale}% text with labeled rows`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const state = await fixture(page)
    const url = `https://feedback.example.test/${"long".repeat(17)}`
    const source = `Fixture${"LongSection".repeat(5)}`
    state.issues.push(
      sampleIssue(2, url, { section: source, hasScreenshot: true }),
      sampleIssue(1, "Resolved report", { state: "closed" }),
    )
    let externalRequests = 0
    await page.route("https://feedback.example.test/**", (route) => {
      externalRequests++
      return route.abort()
    })
    await navigate(page, "Issues")
    if (fontScale === 200) {
      const client = await page.context().newCDPSession(page)
      await client.send("Page.setFontSizes", { fontSizes: { standard: 32 } })
      await expect(page.locator(".admin-theme").first()).toHaveCSS("font-size", "32px")
    }
    const table = page.getByRole("table", { name: "Feedback list", exact: true })
    const title = table.getByRole("button", { name: url, exact: true })
    const second = table.getByRole("button", { name: "Resolved report", exact: true })
    await expect(table.getByRole("button")).toHaveCount(2)
    await expect(title).toHaveAccessibleDescription("#2 Screenshot attached")
    await expect(second).toHaveAccessibleDescription("#1")
    await expect(table.getByRole("link")).toHaveCount(0)
    await expect(table.getByRole("img")).toHaveCount(0)

    const row = table
      .getByRole("row")
      .filter({ has: page.getByRole("button", { name: url, exact: true }) })
    const rowHeader = row.getByRole("rowheader")
    await expect(rowHeader.getByRole("button")).toHaveText(url)
    const labels = ["Source page", "Status", "Updated"]
    await expect(table.getByRole("columnheader")).toHaveText(["Feedback", ...labels])
    const rowId = await rowHeader.getAttribute("id")
    for (const [index, label] of labels.entries()) {
      const cell = row.getByRole("cell").nth(index)
      await expect(cell.getByText(label, { exact: true })).toBeVisible()
      const column = table.getByRole("columnheader", { name: label, exact: true })
      await expect(cell).toHaveAttribute("headers", `${rowId} ${await column.getAttribute("id")}`)
    }
    const sourceText = row.getByText(source, { exact: true })
    await expect(sourceText).toBeVisible()
    await expect(row.getByRole("cell", { name: "Open", exact: true })).toBeVisible()
    await expect(table.getByRole("cell", { name: "Closed", exact: true })).toBeVisible()
    for (const text of [title, sourceText]) {
      // Check text bounds as well as page overflow, so clipping cannot pass this check.
      expect(
        await text.evaluate((element) => {
          const bounds = element.getBoundingClientRect()
          const range = document.createRange()
          range.selectNodeContents(element)
          return Array.from(range.getClientRects()).every(
            (rect) =>
              rect.left >= Math.max(0, bounds.left) - 1 &&
              rect.right <= Math.min(innerWidth, bounds.right) + 1 &&
              rect.top >= bounds.top - 1 &&
              rect.bottom <= bounds.bottom + 1,
          )
        }),
      ).toBe(true)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await title.focus()
    await page.keyboard.press("Tab")
    await expect(second).toBeFocused()
    await page.keyboard.press("Shift+Tab")
    await expect(title).toBeFocused()
    expect(state.reads).toEqual(["/api/issues"])
    expect(externalRequests).toBe(0)
  })
}

test("lists Issues MCP grants and revokes only the grant explicitly confirmed", async ({
  page,
}) => {
  await fixture(page)
  const endpoint = "https://admin.example.test/mcp/issues"
  const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000
  const reader = {
    id: "a".repeat(43),
    clientName: "Reader",
    redirectUri: "http://127.0.0.1:8787/callback",
    scope: "issues:read",
    expiresAt,
  }
  const writer = {
    id: "b".repeat(43),
    clientName: "Writer <img src=x>",
    redirectUri: "http://[::1]:8788/callback",
    scope: "issues:write",
    expiresAt,
  }
  const removed: string[] = []
  let reads = 0
  let configured = false
  let signedIn = true
  await page.route("**/api/issues-mcp/grants", async (route) => {
    const request = route.request()
    if (!signedIn) {
      await route.fulfill({ status: 401, json: { error: "Session expired" } })
      return
    }
    if (request.method() === "GET") reads++
    else {
      expect(request.method()).toBe("DELETE")
      expect(request.headers()["x-csrf-token"]).toBe("fixture")
      const { id } = request.postDataJSON()
      expect([reader.id, writer.id]).toContain(id)
      removed.push(id)
      if (id === writer.id) {
        // Simulate a lost response after the server applied the change.
        await route.abort("failed")
        return
      }
    }
    await route.fulfill({
      json: {
        endpoint: configured ? endpoint : null,
        grants: configured ? [reader, writer].filter(({ id }) => !removed.includes(id)) : [],
      },
    })
  })
  await navigate(page, "Issues")
  await expect(page.getByRole("table")).toBeVisible()
  expect(reads).toBe(0)
  const manage = page.getByRole("button", { name: "Manage Issues MCP grants" })
  const dialog = page.getByRole("dialog", { name: "Issues MCP grants", exact: true })
  const close = dialog.getByRole("button", { name: "Close", exact: true })
  await manage.click()
  await expect(dialog.getByText(/HTTPS admin origin is not configured/)).toBeVisible()
  await expect(dialog.getByText("No active grants.")).toBeVisible()
  await close.click()
  await expect(manage).toBeFocused()

  configured = true
  await manage.click()
  await expect(dialog.getByText(endpoint, { exact: true })).toBeVisible()
  await expect(
    dialog.getByText("Start authorization from the client.", { exact: false }),
  ).toBeVisible()
  const writerRow = dialog.getByRole("listitem").filter({ hasText: writer.clientName })
  const writerRevoke = writerRow.getByRole("button", { name: "Revoke access", exact: true })
  await expect(writerRow).toContainText(writer.redirectUri)
  await expect(writerRow).toContainText("Read and write (issues:write)")
  await expect(writerRow.locator("time")).toHaveAttribute(
    "datetime",
    new Date(expiresAt).toISOString(),
  )
  await expect(writerRow.locator("img")).toHaveCount(0)
  await expect(dialog.getByText(/bearer token/i)).toHaveCount(0)
  await writerRevoke.click()
  const confirmation = page.getByRole("dialog", { name: "Revoke this grant?", exact: true })
  await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeFocused()
  await expect(confirmation).toContainText(writer.clientName)
  expect(removed).toEqual([])
  await page.keyboard.press("Escape")
  await expect(writerRevoke).toBeFocused()
  expect(removed).toEqual([])
  await writerRevoke.click()
  await confirmation.getByRole("button", { name: "Revoke access" }).click()
  await expect(dialog.getByRole("alert")).toContainText("Could not confirm the change")
  await dialog.getByRole("button", { name: "Reload grants" }).click()
  await expect(dialog.getByText("Read-only (issues:read)")).toBeVisible()
  await expect(writerRow).toHaveCount(0)
  expect(removed).toEqual([writer.id])
  await dialog.getByRole("button", { name: "Revoke access" }).click()
  await confirmation.getByRole("button", { name: "Revoke access" }).click()
  await expect(dialog.getByRole("status")).toHaveText("Access revoked.")
  await expect(dialog.getByText("No active grants.")).toBeVisible()
  expect(removed).toEqual([writer.id, reader.id])
  await close.click()
  signedIn = false
  await manage.click()
  await expect(page.getByRole("button", { name: "Sign in with passkey" })).toBeVisible()
  await expect(dialog).toHaveCount(0)
})

async function textFeedback(page: Page, text: string) {
  await page.getByRole("button", { name: "回報問題", exact: true }).click()
  await page.getByRole("button", { name: "文字", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "回報問題", exact: true })
  await dialog.getByRole("textbox").fill(text)
  return dialog
}
for (const width of [1440, 390]) {
  test(`feedback is global, submits privately and manages issues at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    const state = await fixture(page)
    await navigate(page, "Defaults")
    const dialog = await textFeedback(page, "讓模型選擇器更清楚 <script>alert(1)</script>")
    await dialog.getByRole("button", { name: "送出回饋", exact: true }).click()
    await expect(page.getByRole("heading", { name: "Issues", exact: true })).toBeVisible()
    await expect(
      page
        .getByRole("region", { name: "Agent analysis" })
        .getByText("Implementation and automatic PRs are not enabled.", { exact: false }),
    ).toBeVisible()
    await expect(page.locator(".issue-description")).toContainText("<script>alert(1)</script>")
    expect(state.submissions).toHaveLength(1)
    expect(state.submissions[0]?.source).toEqual({
      section: "Defaults",
      viewport: { width, height: 900 },
    })
    expect(Object.keys(state.submissions[0] ?? {}).sort()).toEqual([
      "description",
      "requestId",
      "source",
    ])
    await page.getByRole("button", { name: "關閉回饋", exact: true }).click()
    await expect(page.getByRole("button", { name: "重新開啟", exact: true })).toBeVisible()
    await page.getByRole("button", { name: "返回列表", exact: true }).click()
    await expect(page.getByRole("table")).toContainText("Closed")
    await filters(page).getByRole("button", { name: "Open", exact: true }).click()
    await expect(page.getByText("No feedback matches this filter.", { exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`issues-${width}.png`), fullPage: true })
  })
}

test("captures a frozen page, draws, redacts, crops, previews and submits image-only feedback", async ({
  page,
}) => {
  const state = await fixture(page)
  await page.getByRole("button", { name: "回報問題", exact: true }).click()
  await page.getByRole("button", { name: "截圖", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "回報問題", exact: true })
  await expect(dialog).toBeVisible({ timeout: 20000 })
  const canvas = dialog.locator("canvas")
  const box = await canvas.boundingBox()
  if (!box) throw new Error("Missing canvas")
  const drag = async (x1: number, y1: number, x2: number, y2: number) => {
    await page.mouse.move(box.x + box.width * x1, box.y + box.height * y1)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * x2, box.y + box.height * y2, { steps: 5 })
    await page.mouse.up()
  }
  await drag(0.2, 0.2, 0.3, 0.3)
  await dialog.getByRole("button", { name: "遮蔽", exact: true }).click()
  await drag(0.1, 0.1, 0.4, 0.4)
  await dialog.getByRole("button", { name: "裁切", exact: true }).click()
  await drag(0.05, 0.05, 0.6, 0.6)
  await dialog.getByRole("button", { name: "預覽送出圖片", exact: true }).click()
  const preview = dialog.getByRole("img", { name: "即將送出的裁切與標註圖片" })
  await expect(preview).toBeVisible()
  const dimensions = await preview.evaluate((image: HTMLImageElement) => ({
    width: image.naturalWidth,
    height: image.naturalHeight,
  }))
  expect(dimensions.width).toBeGreaterThan(1)
  expect(dimensions.width).toBeLessThan(1000)
  const redactedPixel = await preview.evaluate((image: HTMLImageElement) => {
    const canvas = document.createElement("canvas")
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext("2d")
    if (!context) throw new Error("Missing canvas context")
    context.drawImage(image, 0, 0)
    return [
      ...context.getImageData(
        Math.round(canvas.width * 0.36),
        Math.round(canvas.height * 0.36),
        1,
        1,
      ).data,
    ]
  })
  expect(redactedPixel).toEqual([17, 17, 17, 255])
  await dialog.getByRole("button", { name: "送出回饋", exact: true }).click()
  await expect(page.locator(".issue-screenshot")).toBeVisible()
  const savedDimensions = await page
    .locator(".issue-screenshot")
    .evaluate(async (image: HTMLImageElement) => {
      await image.decode()
      return { width: image.naturalWidth, height: image.naturalHeight }
    })
  expect(savedDimensions).toEqual(dimensions)
  expect(state.submissions[0]?.description).toBe("")
  expect(state.submissions[0]?.screenshot).toMatch(/^iVBOR/)
  expect(state.screenshots).toBe(1)
})

test("sensitive pages disable capture without disabling text reports", async ({ page }) => {
  await fixture(page)
  await navigate(page, "Secrets & variables")
  await page.getByRole("button", { name: "回報問題", exact: true }).click()
  await expect(page.getByRole("button", { name: "截圖", exact: true })).toBeDisabled()
  await page.getByRole("button", { name: "文字", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "回報問題", exact: true })).toBeVisible()
})

test("an ambiguous network result retries the exact same request ID and content", async ({
  page,
}) => {
  await fixture(page)
  const submissions: Feedback[] = []
  await page.route("**/api/issues", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback()
      return
    }
    const input = route.request().postDataJSON() as Feedback
    submissions.push(input)
    if (submissions.length === 1) {
      await route.abort("failed")
      return
    }
    await route.fulfill({
      status: 201,
      json: {
        id: 5,
        title: input.description,
        description: input.description,
        source: input.source,
        section: input.source.section,
        state: "open",
        revision: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        hasScreenshot: false,
      },
    })
  })
  const dialog = await textFeedback(page, "Retry safely")
  await dialog.getByRole("button", { name: "送出回饋", exact: true }).click()
  await expect(dialog.getByRole("textbox")).toBeDisabled()
  await dialog.getByRole("button", { name: "重試相同提交", exact: true }).click()
  await expect(dialog).not.toBeVisible()
  expect(submissions).toHaveLength(2)
  expect(submissions[1]).toEqual(submissions[0])
})

test("expiry clears feedback drafts and returns to sign-in", async ({ page }) => {
  await fixture(page)
  await page.route("**/api/issues", (route) =>
    route.fulfill({ status: 401, json: { error: "Session expired" } }),
  )
  const dialog = await textFeedback(page, "private draft")
  await dialog.getByRole("button", { name: "送出回饋", exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await expect(
    page.getByRole("button", { name: "Sign in with passkey", exact: true }),
  ).toBeVisible()
  await expect(page.getByText("private draft", { exact: true })).toHaveCount(0)
})

test("capture filtering excludes form values, private regions and external images", async ({
  page,
}) => {
  await fixture(page)
  const filtered = await page.evaluate(async () => {
    const path = "/src/feedback-image.ts"
    const { captureFilter } = await import(path)
    const candidates = [
      document.createElement("input"),
      document.createElement("textarea"),
      document.createElement("iframe"),
      document.createElement("div"),
      document.createElement("section"),
      document.createElement("img"),
    ]
    candidates[3]?.setAttribute("contenteditable", "")
    candidates[4]?.setAttribute("data-feedback-private", "")
    candidates[5]?.setAttribute("src", "https://external.example.test/image.png")
    return candidates.map((element) => captureFilter(element))
  })
  expect(filtered).toEqual([false, false, false, false, false, false])
})

const proposalReport: AnalysisReport = {
  summary: "將操作集中在易辨識的位置。",
  limitations: "概念線框；尚未檢視原始碼。",
  questions: [],
  proposals: [
    {
      title: "集中工具列",
      rationale: "降低尋找主要操作的負擔。",
      changes: ["主要操作固定在標題旁。"],
      tradeoffs: "手機版需要換行。",
      preview: {
        title: "工具列概念",
        layout: "stack",
        sections: [
          {
            heading: "主要操作",
            body: "<script>window.__proposalInjected = true</script>",
            button: "儲存",
          },
        ],
      },
    },
    {
      title: "分組操作",
      rationale: "把次要操作放到選單。",
      changes: ["依任務區分主要與次要操作。"],
      tradeoffs: "次要操作多一次點擊。",
      preview: {
        title: "分組概念",
        layout: "columns",
        sections: [
          { heading: "主要操作", body: "快速存取", button: "儲存" },
          { heading: "其他", body: "次要操作", button: "更多" },
        ],
      },
    },
  ],
}
function analysisFixture(): IssueAnalysis {
  return {
    id: "12345678-1234-4234-8234-123456789abc",
    issueId: 1,
    attempt: 1,
    state: "idle",
    reason: null,
    sessionId: "87654321-4321-4321-8321-cba987654321",
    conversationId: 1,
    submissionId: null,
    model: null,
    deadline: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    report: null,
    selectedProposal: null,
    revision: 1,
  }
}

for (const width of [1810, 390, 320]) {
  test(`prioritizes the report and latest analysis at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1022 })
    const { issues } = await fixture(page)
    const title = `https://example.test/${"long".repeat(64)}`
    issues.push({
      id: 1,
      title,
      description: `The report text stays readable.\n${title}`,
      section: "Issues",
      source: { section: "Issues", viewport: { width: 1810, height: 1022 } },
      hasScreenshot: false,
      state: "open",
      revision: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    const attempts: IssueAnalysis[] = [3, 2, 1].map((attempt) => ({
      ...analysisFixture(),
      id: `fixture-attempt-${attempt}`,
      attempt,
      state: "blocked",
      reason: "model_unavailable",
      sessionId: `fixture-run-${attempt}`,
      conversationId: attempt,
    }))
    await page.route("**/api/issues/1/analysis", (route) => {
      expect(route.request().method()).toBe("GET")
      return route.fulfill({ json: { available: true, analyses: attempts } })
    })

    await page.goto("/")
    await navigate(page, "Issues")
    await issueTitle(page, title).click()
    await expect(page.getByRole("heading", { level: 2, name: `#1 ${title}` })).toBeVisible()
    const report = page.locator(".issue-report")
    const analysis = page.getByRole("region", { name: "Agent analysis", exact: true })
    await expect(report.getByText(/The report text stays readable/)).toBeVisible()
    await expect(report.getByRole("img")).toHaveCount(0)
    await expect(analysis.getByRole("heading", { name: "Analysis 3", exact: true })).toBeVisible()
    const current = analysis.getByRole("article", { name: "Analysis 3", exact: true })
    await expect(current.getByText("Blocked", { exact: true })).toBeVisible()
    await expect(current.getByText(/Configure an authorized shared model/)).toBeVisible()
    const reportBox = await report.boundingBox()
    const analysisBox = await analysis.boundingBox()
    if (!reportBox || !analysisBox) throw new Error("Report and analysis must both have a layout")
    if (width === 1810) expect(reportBox.x + reportBox.width).toBeLessThan(analysisBox.x)
    else expect(reportBox.y + reportBox.height).toBeLessThan(analysisBox.y)

    const runDetails = current.getByText("Run details", { exact: true })
    const currentRun = analysis.getByText("fixture-run-3", { exact: true })
    await expect(currentRun).toBeHidden()
    await runDetails.press("Enter")
    await expect(currentRun).toBeVisible()
    await runDetails.press("Space")
    await expect(currentRun).toBeHidden()

    const previousAnalyses = analysis.getByText("Previous analyses", { exact: true })
    const earlier = analysis.getByRole("heading", { name: "Analysis 2", exact: true })
    await expect(earlier).toBeHidden()
    await previousAnalyses.press("Enter")
    await expect(earlier).toBeVisible()
    await expect(analysis.getByRole("heading", { name: "Analysis 1", exact: true })).toBeVisible()
    await expect(analysis.getByText("Blocked", { exact: true })).toHaveCount(3)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await previousAnalyses.press("Space")
    await expect(earlier).toBeHidden()
  })
}

for (const width of [1440, 390]) {
  test(`compares inert proposals and records a choice without implementation at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    const state = await fixture(page)
    const analysis = analysisFixture()
    const writes: { path: string; body: Record<string, unknown> }[] = []
    await page.route("**/api/issues/*/analysis**", async (route) => {
      const path = new URL(route.request().url()).pathname
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON() as Record<string, unknown>
        writes.push({ path, body })
        if (path.endsWith("/select")) {
          expect(body.analysisId).toBe(analysis.id)
          expect(body.revision).toBe(analysis.revision)
          analysis.selectedProposal = body.proposal as number | null
        } else {
          analysis.state = "completed"
          analysis.model = "fixture/test"
          analysis.submissionId = 3
          analysis.report = proposalReport
        }
        analysis.revision++
      }
      await route.fulfill({ json: { available: true, analyses: [analysis] } })
    })
    const dialog = await textFeedback(page, "改善操作區")
    await expect(dialog.getByRole("checkbox")).not.toBeChecked()
    await dialog.getByRole("button", { name: "送出回饋", exact: true }).click()
    const panel = page.getByRole("region", { name: "Agent analysis", exact: true })
    await expect(panel.getByText("Previous analyses", { exact: true })).toHaveCount(0)
    await panel.getByText("Run details", { exact: true }).click()
    await expect(panel.getByText(analysis.sessionId ?? "", { exact: true })).toBeVisible()
    await panel.getByLabel("Additional context (optional)").fill("請維持現有配色")
    await panel.getByRole("button", { name: "Request analysis", exact: true }).click()
    await expect(panel.getByRole("img")).toHaveCount(2)
    await expect(panel.getByRole("img", { name: "工具列概念", exact: true })).toBeVisible()
    await panel.getByRole("button", { name: "View larger wireframe", exact: true }).first().click()
    const preview = page.getByRole("dialog", { name: "工具列概念", exact: true })
    const wireframe = preview.getByRole("img", { name: "工具列概念" })
    await expect(wireframe).toBeVisible()
    await expect(wireframe).toHaveJSProperty("naturalWidth", 840)
    await preview.getByRole("button", { name: "Close preview", exact: true }).click()
    await panel.getByRole("button", { name: "Select for discussion", exact: true }).nth(1).click()
    await expect(
      panel.getByRole("button", { name: "Selected — click to clear", exact: true }),
    ).toHaveAttribute("aria-pressed", "true")
    expect(writes).toHaveLength(2)
    expect(writes[0]?.body.context).toBe("請維持現有配色")
    expect(writes[1]?.path).toBe("/api/issues/1/analysis/select")
    expect(state.submissions[0]?.analyze).toBeUndefined()
    expect(await page.evaluate(() => Reflect.get(window, "__proposalInjected"))).toBeUndefined()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({
      path: testInfo.outputPath(`issue-proposals-${width}.png`),
      fullPage: true,
    })
  })
}
test("analysis consent is explicit on feedback collection", async ({ page }) => {
  const state = await fixture(page)
  const dialog = await textFeedback(page, "送出後分析")
  await dialog.getByRole("checkbox").check()
  await dialog.getByRole("button", { name: "送出回饋", exact: true }).click()
  await expect(dialog).not.toBeVisible()
  expect(state.submissions[0]?.analyze).toBe(true)
})
test("analysis polling recovers from a failed metadata read", async ({ page }) => {
  await fixture(page)
  const analysis = analysisFixture()
  let reads = 0
  await page.route("**/api/issues/*/analysis", async (route) => {
    reads++
    if (reads === 2) {
      await route.fulfill({ status: 503, json: { error: "Analysis temporarily unavailable" } })
      return
    }
    analysis.state = reads === 1 ? "running" : "completed"
    await route.fulfill({ json: { available: true, analyses: [analysis] } })
  })
  const dialog = await textFeedback(page, "Poll for analysis")
  await dialog.getByRole("button", { name: "送出回饋", exact: true }).click()
  const panel = page.getByRole("region", { name: "Agent analysis", exact: true })
  await expect(panel.getByText("Analyzing", { exact: true })).toBeVisible()
  await expect(panel.getByRole("alert")).toHaveText("Analysis temporarily unavailable")
  await expect(panel.getByText("Report ready", { exact: true })).toBeVisible()
  await expect(panel.getByRole("alert")).toHaveCount(0)
})

test("analysis admission retries the same immutable payload and supports cancellation", async ({
  page,
}) => {
  await fixture(page)
  const analysis = analysisFixture()
  const inputs: Record<string, unknown>[] = []
  await page.route("**/api/issues/*/analysis**", async (route) => {
    const path = new URL(route.request().url()).pathname
    if (route.request().method() === "POST") {
      if (path.endsWith("/cancel")) {
        analysis.state = "cancelled"
        analysis.reason = "cancelled"
        analysis.revision++
      } else {
        inputs.push(route.request().postDataJSON())
        if (inputs.length === 1) {
          await route.abort("failed")
          return
        }
        if (inputs.length === 2) {
          await route.fulfill({ status: 429, json: { error: "Rate limited" } })
          return
        }
        analysis.state = "queued"
        analysis.revision++
      }
    }
    await route.fulfill({ json: { available: true, analyses: [analysis] } })
  })
  const dialog = await textFeedback(page, "等待確認")
  await dialog.getByRole("button", { name: "送出回饋", exact: true }).click()
  const panel = page.getByRole("region", { name: "Agent analysis", exact: true })
  await panel.getByLabel("Additional context (optional)").fill("只需線框")
  await panel.getByRole("button", { name: "Request analysis", exact: true }).click()
  await expect(panel.getByLabel("Additional context (optional)")).toBeDisabled()
  await panel.getByRole("button", { name: "Retry the same request", exact: true }).click()
  await expect(
    panel.getByRole("button", { name: "Retry the same request", exact: true }),
  ).toBeEnabled()
  await expect(panel.getByLabel("Additional context (optional)")).toBeDisabled()
  await panel.getByRole("button", { name: "Retry the same request", exact: true }).click()
  await expect.poll(() => inputs.length).toBe(3)
  expect(inputs[1]).toEqual(inputs[0])
  expect(inputs[2]).toEqual(inputs[0])
  await panel.getByRole("button", { name: "Cancel analysis", exact: true }).click()
  await expect(panel.getByText("Cancelled", { exact: true })).toBeVisible()
})

async function whiteImageFeedback(page: Page) {
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas")
    canvas.width = 400
    canvas.height = 200
    const context = canvas.getContext("2d")
    if (!context) throw new Error("Missing context")
    context.fillStyle = "white"
    context.fillRect(0, 0, 400, 200)
    return canvas.toDataURL("image/png").split(",")[1] ?? ""
  })
  await page.getByRole("button", { name: "回報問題", exact: true }).click()
  await page
    .locator('.feedback-launcher input[type="file"]')
    .setInputFiles({ name: "white.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") })
  const dialog = page.getByRole("dialog", { name: "回報問題", exact: true })
  await expect(dialog.locator("canvas")).toBeVisible()
  return dialog
}
test("discards a capture if the viewport changes while its first lazy import is pending", async ({
  page,
}) => {
  await fixture(page)
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const importStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  await page.route("**/*html-to-image*", async (route) => {
    started()
    await gate
    await route.continue()
  })
  try {
    await page.getByRole("button", { name: "回報問題", exact: true }).click()
    await page.getByRole("button", { name: "截圖", exact: true }).click()
    await importStarted
    await page.setViewportSize({ width: 1100, height: 850 })
    release()
    await expect(page.getByRole("alert")).toContainText("擷取期間視窗大小已變更")
    await expect(page.getByRole("dialog", { name: "回報問題", exact: true })).not.toBeVisible()
    await expect(page.getByRole("button", { name: "回報問題", exact: true })).toBeEnabled()
  } finally {
    release()
  }
})
test("keeps a redaction gesture owned by one touch pointer and ignores unrelated cancellation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 })
  await fixture(page)
  const client = await page.context().newCDPSession(page)
  await client.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 2 })
  const dialog = await whiteImageFeedback(page)
  await dialog.getByRole("button", { name: "遮蔽", exact: true }).click()
  const canvas = dialog.locator("canvas")
  await canvas.scrollIntoViewIfNeeded()
  const box = await canvas.boundingBox()
  if (!box) throw new Error("Missing canvas")
  expect(await canvas.evaluate((element) => getComputedStyle(element).borderLeftWidth)).toBe("0px")
  const point = (id: number, x: number, y: number) => ({
    id,
    x: box.x + box.width * x,
    y: box.y + box.height * y,
  })
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [point(1, 0.1, 0.2)],
  })
  await canvas.evaluate((element) =>
    element.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 9999 })),
  )
  await client.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [point(1, 0.4, 0.6)],
  })
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [point(1, 0.4, 0.6), point(2, 0.75, 0.1)],
  })
  await client.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [point(1, 0.4, 0.6), point(2, 0.95, 0.9)],
  })
  await client.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [point(2, 0.95, 0.9)],
  })
  await client.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [point(1, 0.6, 0.8)],
  })
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  await dialog.getByRole("button", { name: "預覽送出圖片", exact: true }).click()
  const pixels = await dialog
    .locator(".feedback-preview")
    .evaluate(async (image: HTMLImageElement) => {
      await image.decode()
      const canvas = document.createElement("canvas")
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext("2d")
      if (!context) throw new Error("Missing context")
      context.drawImage(image, 0, 0)
      return [
        [...context.getImageData(220, 140, 1, 1).data],
        [...context.getImageData(340, 100, 1, 1).data],
      ]
    })
  expect(pixels).toEqual([
    [17, 17, 17, 255],
    [255, 255, 255, 255],
  ])
})
test("stopping a stalled submit and a rejected retry retain the original locked payload", async ({
  page,
}) => {
  await fixture(page)
  const inputs: Feedback[] = []
  await page.route("**/api/issues", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback()
      return
    }
    inputs.push(route.request().postDataJSON())
    if (inputs.length === 1) return // Keep this request pending until the browser stops waiting.
    if (inputs.length === 2) {
      await route.fulfill({ status: 429, json: { error: "Slow down" } })
      return
    }
    await route.fallback()
  })
  const dialog = await textFeedback(page, "Original payload")
  await dialog.getByRole("button", { name: "送出回饋", exact: true }).click()
  await dialog.getByRole("button", { name: "Stop waiting", exact: true }).click()
  await expect(dialog.getByRole("textbox")).toBeDisabled()
  await dialog.getByRole("button", { name: "重試相同提交", exact: true }).click()
  await expect(dialog.getByRole("button", { name: "重試相同提交", exact: true })).toBeEnabled()
  await expect(dialog.getByRole("textbox")).toBeDisabled()
  await dialog.getByRole("button", { name: "重試相同提交", exact: true }).click()
  await expect(dialog).not.toBeVisible()
  expect(inputs).toHaveLength(3)
  expect(inputs[1]).toEqual(inputs[0])
  expect(inputs[2]).toEqual(inputs[0])
})
test("a first-attempt 429 does not lock the draft or reuse a rejected payload", async ({
  page,
}) => {
  await fixture(page)
  const inputs: Feedback[] = []
  await page.route("**/api/issues", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback()
      return
    }
    inputs.push(route.request().postDataJSON())
    if (inputs.length === 1) {
      await route.fulfill({ status: 429, json: { error: "Slow down" } })
      return
    }
    await route.fallback()
  })
  const dialog = await textFeedback(page, "Rejected draft")
  await dialog.getByRole("button", { name: "送出回饋", exact: true }).click()
  await expect(dialog.getByRole("textbox")).toBeEnabled()
  await dialog.getByRole("textbox").fill("Edited draft")
  await dialog.getByRole("button", { name: "送出回饋", exact: true }).click()
  await expect(dialog).not.toBeVisible()
  expect(inputs[1]?.description).toBe("Edited draft")
  expect(inputs[1]?.requestId).not.toBe(inputs[0]?.requestId)
})
test("submission timeout restores retry without discarding the immutable draft", async ({
  page,
}) => {
  await fixture(page)
  await page.clock.install()
  const inputs: Feedback[] = []
  await page.route("**/api/issues", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback()
      return
    }
    inputs.push(route.request().postDataJSON())
    if (inputs.length === 1) return
    await route.fallback()
  })
  const dialog = await textFeedback(page, "Timeout draft")
  await dialog.getByRole("button", { name: "送出回饋", exact: true }).click()
  await expect(dialog.getByRole("button", { name: "Stop waiting", exact: true })).toBeVisible()
  await page.clock.runFor(30000)
  await expect(dialog.getByRole("textbox")).toBeDisabled()
  await dialog.getByRole("button", { name: "重試相同提交", exact: true }).click()
  await expect(dialog).not.toBeVisible()
  expect(inputs).toHaveLength(2)
  expect(inputs[1]).toEqual(inputs[0])
})
for (const operation of ["read", "update", "delete"] as const) {
  test(`a newly saved issue stays selected after an older ${operation} finishes`, async ({
    page,
  }) => {
    await fixture(page)
    const first = await textFeedback(page, "Issue A")
    await first.getByRole("button", { name: "送出回饋", exact: true }).click()
    await expect(page.getByRole("heading", { name: "#1 Issue A", exact: true })).toBeVisible()
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = new Promise<void>((resolve) => {
      started = resolve
    })
    const method = operation === "read" ? "GET" : operation === "update" ? "PUT" : "DELETE"
    await page.route("**/api/issues/1", async (route) => {
      if (route.request().method() !== method) {
        await route.fallback()
        return
      }
      started()
      await gate
      await route.fallback()
    })
    try {
      if (operation === "read") {
        await page.getByRole("button", { name: "返回列表", exact: true }).click()
        await issueTitle(page, "Issue A").click()
      } else if (operation === "update")
        await page.getByRole("button", { name: "關閉回饋", exact: true }).click()
      else {
        page.once("dialog", (dialog) => dialog.accept())
        await page.getByRole("button", { name: "永久刪除", exact: true }).click()
      }
      await pending
      const second = await textFeedback(page, "Issue B")
      await second.getByRole("button", { name: "送出回饋", exact: true }).click()
      await expect(page.getByRole("heading", { name: "#2 Issue B", exact: true })).toBeVisible()
      release()
      await expect(page.getByRole("button", { name: "返回列表", exact: true })).toBeEnabled()
      await expect(page.getByRole("heading", { name: "#2 Issue B", exact: true })).toBeVisible()
      await expect(page.getByRole("button", { name: "關閉回饋", exact: true })).toBeVisible()
    } finally {
      release()
    }
  })
}
test("a detail refresh cannot conceal a failed background list request", async ({ page }) => {
  await fixture(page)
  let fail = true
  let failures = 0
  await page.route("**/api/issues**", async (route) => {
    if (
      fail &&
      route.request().method() === "GET" &&
      new URL(route.request().url()).pathname === "/api/issues"
    ) {
      failures++
      await route.fulfill({ status: 503, json: { error: "List unavailable" } })
      return
    }
    await route.fallback()
  })
  const dialog = await textFeedback(page, "Issue A")
  await dialog.getByRole("button", { name: "送出回饋", exact: true }).click()
  await expect.poll(() => failures).toBeGreaterThan(0)
  await page.getByRole("button", { name: "重新整理回饋", exact: true }).click()
  await expect(page.getByRole("button", { name: "返回列表", exact: true })).toBeEnabled()
  await page.getByRole("button", { name: "返回列表", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("List unavailable")
  await expect(page.getByText("Feedback has not loaded.", { exact: true })).toBeVisible()
  fail = false
  await page.getByRole("button", { name: "Refresh list", exact: true }).click()
  await expect(issueTitle(page, "Issue A")).toBeVisible()
  await expect(page.getByRole("alert")).toHaveCount(0)
})
test("refresh retries a failed attachment and keeps its error until the image actually decodes", async ({
  page,
}) => {
  await fixture(page)
  let attempts = 0
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const retried = new Promise<void>((resolve) => {
    started = resolve
  })
  await page.route("**/api/issues/*/screenshot*", async (route) => {
    attempts++
    if (attempts === 1) {
      await route.fulfill({ status: 503, body: "temporary image failure" })
      return
    }
    started()
    await gate
    await route.fallback()
  })
  try {
    const dialog = await whiteImageFeedback(page)
    await dialog.getByRole("button", { name: "預覽送出圖片", exact: true }).click()
    await dialog.getByRole("button", { name: "送出回饋", exact: true }).click()
    await expect(page.getByRole("alert")).toContainText("截圖無法載入")
    await expect(page.locator(".issue-screenshot")).not.toBeVisible()
    await page.getByRole("button", { name: "重新整理回饋", exact: true }).click()
    await retried
    await expect(page.getByRole("alert")).toContainText("截圖無法載入")
    await expect(page.locator(".issue-screenshot")).not.toBeVisible()
    release()
    await expect(page.locator(".issue-screenshot")).toBeVisible()
    await page.locator(".issue-screenshot").evaluate((image: HTMLImageElement) => image.decode())
    await expect(page.getByRole("alert")).toHaveCount(0)
    expect(attempts).toBe(2)
  } finally {
    release()
  }
})

test("preview ends a held gesture before unmounting its canvas", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 })
  await fixture(page)
  const dialog = await whiteImageFeedback(page)
  await dialog.getByRole("button", { name: "遮蔽", exact: true }).click()
  const draw = async (from: number, to: number, held = false) => {
    const canvas = dialog.locator("canvas")
    await canvas.scrollIntoViewIfNeeded()
    const box = await canvas.boundingBox()
    if (!box) throw new Error("Missing canvas")
    await page.mouse.move(box.x + box.width * from, box.y + box.height * from)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * to, box.y + box.height * to)
    if (!held) await page.mouse.up()
  }
  await draw(0.1, 0.25, true)
  const preview = dialog.getByRole("button", { name: "預覽送出圖片", exact: true })
  await preview.focus()
  await preview.press("Enter") // Keyboard activation while the mouse still owns the old canvas.
  await expect(dialog.locator(".feedback-preview")).toBeVisible()
  await page.mouse.up() // The canvas has gone; it cannot receive this release.
  await dialog.getByRole("button", { name: "返回編輯圖片", exact: true }).click()
  await draw(0.6, 0.9)
  await preview.click()
  const pixels = await dialog
    .locator(".feedback-preview")
    .evaluate(async (image: HTMLImageElement) => {
      await image.decode()
      const canvas = document.createElement("canvas")
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext("2d")
      if (!context) throw new Error("Missing context")
      context.drawImage(image, 0, 0)
      return [
        [...context.getImageData(200, 100, 1, 1).data],
        [...context.getImageData(300, 150, 1, 1).data],
      ]
    })
  expect(pixels).toEqual([
    [255, 255, 255, 255],
    [17, 17, 17, 255],
  ])
})
