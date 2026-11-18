import type {
  AnalysisReport,
  Feedback,
  Issue,
  IssueAnalysis,
  IssuePage,
} from "@narumitw/sumire-issues"
import { expect, type Page, test } from "@playwright/test"
import { adminFixture, navigate } from "./admin-fixture.js"

function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function issueFromFeedback(input: Feedback, id: number): Issue {
  return {
    id,
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
}

async function fixture(page: Page) {
  await adminFixture(page)
  const state: { issues: Issue[]; submissions: Feedback[]; screenshots: number } = {
    issues: [],
    submissions: [],
    screenshots: 0,
  }
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
        const response: IssuePage = {
          issues: state.issues.filter(
            (value) =>
              !url.searchParams.get("state") || value.state === url.searchParams.get("state"),
          ),
          next: null,
        }
        await route.fulfill({ json: response })
      }
    } else if (request.method() === "POST") {
      expect(request.headers()["x-csrf-token"]).toBe("fixture")
      const input = request.postDataJSON() as Feedback
      state.submissions.push(input)
      const issue = issueFromFeedback(input, state.issues.length + 1)
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
      page.getByText("Implementation and automatic PRs are not enabled.", { exact: false }),
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
    await expect(page.getByRole("table")).toContainText("已關閉")
    await page.getByLabel("篩選回饋狀態").selectOption("open")
    await expect(page.getByText("目前沒有符合條件的回饋。", { exact: false })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`issues-${width}.png`), fullPage: true })
  })
}

for (const method of ["GET", "PUT", "DELETE"]) {
  test(`keeps newly saved feedback selected after an older ${method} completes`, async ({
    page,
  }) => {
    await fixture(page)
    const section = page.getByRole("region", { name: "Issues", exact: true })
    const older = await textFeedback(page, "Older feedback")
    await older.getByRole("button", { name: "送出回饋", exact: true }).click()
    await expect(section.getByRole("heading", { name: "#1 Older feedback" })).toBeVisible()

    let pending = false
    const release = deferred()
    await page.route("**/api/issues/1", async (route) => {
      if (route.request().method() === method) {
        pending = true
        await release.promise
      }
      await route.fallback()
    })
    try {
      if (method === "GET") {
        await section.getByRole("button", { name: "返回列表" }).click()
        await section.getByRole("button", { name: "#1 Older feedback" }).click()
      } else if (method === "PUT") {
        await section.getByRole("button", { name: "關閉回饋" }).click()
      } else {
        page.once("dialog", async (dialog) => {
          await dialog.accept()
        })
        await section.getByRole("button", { name: "永久刪除" }).click()
      }
      await expect.poll(() => pending).toBe(true)

      const newer = await textFeedback(page, "Newer feedback")
      await newer.getByRole("button", { name: "送出回饋", exact: true }).click()
      const current = section.getByRole("heading", { name: "#2 Newer feedback" })
      await expect(current).toBeVisible()
      release.resolve()
      const back = section.getByRole("button", { name: "返回列表" })
      await expect(back).toBeEnabled()
      await expect(current).toBeVisible()
      await expect(section.getByText("回饋 #2 已儲存。")).toBeVisible()
      await back.click()
      await expect(section.getByRole("table")).toContainText("#2 Newer feedback")
      const row = section.getByRole("row").filter({ hasText: "#1 Older feedback" })
      if (method === "DELETE") await expect(row).toHaveCount(0)
      else await expect(row).toContainText(method === "PUT" ? "已關閉" : "開啟中")
    } finally {
      release.resolve()
    }
  })
}

test("refreshing a detail does not erase a background list error", async ({ page }) => {
  await fixture(page)
  const dialog = await textFeedback(page, "Refresh detail")
  await dialog.getByRole("button", { name: "送出回饋", exact: true }).click()
  const section = page.getByRole("region", { name: "Issues", exact: true })
  const heading = section.getByRole("heading", { name: "#1 Refresh detail" })
  await expect(heading).toBeVisible()
  await section.getByRole("button", { name: "返回列表" }).click()
  await section.getByRole("button", { name: "#1 Refresh detail" }).click()
  await expect(heading).toBeVisible()
  const listUrl = /\/api\/issues\?/
  await page.route(listUrl, (route) =>
    route.fulfill({ status: 503, json: { error: "List temporarily unavailable" } }),
  )
  const failed = page.waitForResponse(listUrl)
  await section.getByRole("button", { name: "關閉回饋" }).click()
  await (await failed).finished()
  const refreshed = page.waitForResponse("**/api/issues/1")
  await section.getByRole("button", { name: "重新整理回饋" }).click()
  await (await refreshed).finished()
  await section.getByRole("button", { name: "返回列表" }).click()
  await expect(section.getByRole("alert")).toHaveText("List temporarily unavailable")
  await expect(section.getByRole("status").filter({ hasText: "尚未載入回饋。" })).toBeVisible()
  await page.unroute(listUrl)
  await section.getByRole("button", { name: "重新整理列表" }).click()
  await expect(section.getByRole("table")).toContainText("已關閉")
  await expect(section.getByRole("alert")).toHaveCount(0)
})

test("captures a frozen page, draws, redacts, crops, previews and submits image-only feedback", async ({
  page,
}) => {
  const state = await fixture(page)
  let attachmentRequests = 0
  const releaseRetry = deferred()
  await page.route("**/api/issues/*/screenshot**", async (route) => {
    if (++attachmentRequests === 1) {
      await route.fulfill({ status: 503 })
      return
    }
    await releaseRetry.promise
    await route.fallback()
  })
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
  const dimensions = await preview.evaluate(async (image: HTMLImageElement) => {
    await image.decode()
    return { width: image.naturalWidth, height: image.naturalHeight }
  })
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
  const attachmentError = page.getByRole("alert").filter({ hasText: "截圖無法載入" })
  const attachment = page.locator(".issue-screenshot")
  await expect(attachmentError).toBeVisible()
  await expect(attachment).toBeHidden()
  try {
    await page.getByRole("button", { name: "重新整理回饋", exact: true }).click()
    await expect.poll(() => attachmentRequests).toBe(2)
    await expect(attachmentError).toBeVisible()
  } finally {
    releaseRetry.resolve()
  }
  expect(
    await attachment.evaluate(async (image: HTMLImageElement) => {
      await image.decode()
      return { width: image.naturalWidth, height: image.naturalHeight }
    }),
  ).toEqual(dimensions)
  await expect(attachment).toBeVisible()
  await expect(attachmentError).toHaveCount(0)
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

test("a stalled feedback submission remains locked through a rate-limited retry", async ({
  page,
}) => {
  await page.clock.install()
  await page.addInitScript(() => {
    const timeout = AbortSignal.timeout.bind(AbortSignal)
    AbortSignal.timeout = (delay) => {
      if (delay !== 15_000) return timeout(delay)
      // Native AbortSignal timers do not use Playwright's clock.
      const controller = new AbortController()
      setTimeout(
        () => controller.abort(new DOMException("Submission timed out", "TimeoutError")),
        delay,
      )
      return controller.signal
    }
  })
  const state = await fixture(page)
  const submissions: Feedback[] = []
  const release = deferred()
  await page.route("**/api/issues", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback()
      return
    }
    const input = route.request().postDataJSON() as Feedback
    submissions.push(input)
    if (submissions.length === 1) {
      // The server saved the issue, but the client has not received the response.
      const issue = issueFromFeedback(input, 1)
      state.issues.push(issue)
      await release.promise
      await route.fulfill({ status: 201, json: issue })
    } else if (submissions.length === 2) {
      await route.fulfill({ status: 429, json: { error: "Too many requests" } })
    } else {
      const matchesSavedRequest = input.requestId === submissions[0]?.requestId
      const issue = matchesSavedRequest ? state.issues[0] : issueFromFeedback(input, 2)
      if (!matchesSavedRequest && issue) state.issues.push(issue)
      await route.fulfill({ status: matchesSavedRequest ? 200 : 201, json: issue })
    }
  })
  try {
    const dialog = await textFeedback(page, "Feedback with a lost response")
    const textbox = dialog.getByRole("textbox")
    const consent = dialog.getByRole("checkbox")
    await consent.check()
    await dialog.getByRole("button", { name: "送出回饋", exact: true }).click()
    await expect.poll(() => state.issues.length).toBe(1)
    await expect(dialog.getByRole("button", { name: "送出中…", exact: true })).toBeDisabled()
    await page.clock.fastForward(15_000)
    const retry = dialog.getByRole("button", { name: "重試相同提交", exact: true })
    await expect(retry).toBeEnabled()
    await expect(textbox).toBeDisabled()
    await expect(consent).toBeDisabled()
    await retry.click()
    await expect.poll(() => submissions.length).toBe(2)
    await expect(retry).toBeEnabled()
    await expect(textbox).toBeDisabled()
    await expect(consent).toBeDisabled()
    await retry.click()
    await expect(dialog).not.toBeVisible()
    expect(submissions).toHaveLength(3)
    expect(submissions[1]).toEqual(submissions[0])
    expect(submissions[2]).toEqual(submissions[0])
    expect(submissions[0]?.analyze).toBe(true)
    expect(state.issues).toHaveLength(1)
    await expect(
      page.getByRole("heading", { name: "#1 Feedback with a lost response" }),
    ).toBeVisible()
  } finally {
    release.resolve()
  }
})

test("a rate limit before any uncertain submission leaves the draft editable", async ({ page }) => {
  await fixture(page)
  const submissions: Feedback[] = []
  await page.route("**/api/issues", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback()
      return
    }
    const input = route.request().postDataJSON() as Feedback
    submissions.push(input)
    if (submissions.length === 1)
      await route.fulfill({ status: 429, json: { error: "Too many requests" } })
    else await route.fulfill({ status: 201, json: issueFromFeedback(input, 1) })
  })
  const dialog = await textFeedback(page, "Draft before rate limit")
  const send = dialog.getByRole("button", { name: "送出回饋", exact: true })
  await send.click()
  await expect(dialog.getByRole("alert")).toHaveText("Too many requests")
  await dialog.getByRole("textbox").fill("Edited after rate limit")
  await send.click()
  await expect(dialog).not.toBeVisible()
  expect(submissions).toHaveLength(2)
  expect(submissions[1]?.description).toBe("Edited after rate limit")
  expect(submissions[1]?.requestId).not.toBe(submissions[0]?.requestId)
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
    await expect(panel.getByText(analysis.sessionId ?? "", { exact: true })).toBeVisible()
    await panel.getByLabel("Additional context (optional)").fill("請維持現有配色")
    await panel.getByRole("button", { name: "Request analysis", exact: true }).click()
    await expect(panel.getByRole("img")).toHaveCount(2)
    await expect(panel.getByRole("img", { name: "工具列概念", exact: true })).toBeVisible()
    await panel.getByRole("button", { name: "View larger wireframe", exact: true }).first().click()
    const preview = page.getByRole("dialog", { name: "工具列概念", exact: true })
    await expect(preview.getByRole("img")).toBeVisible()
    await expect(preview.getByRole("img")).toHaveJSProperty("naturalWidth", 840)
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
  await expect.poll(() => inputs.length).toBe(2)
  expect(inputs[1]).toEqual(inputs[0])
  await panel.getByRole("button", { name: "Cancel analysis", exact: true }).click()
  await expect(panel.getByText("Cancelled", { exact: true })).toBeVisible()
})
