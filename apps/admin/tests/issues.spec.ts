import type {
  AnalysisReport,
  Feedback,
  Issue,
  IssueAnalysis,
  IssuePage,
} from "@narumitw/sumire-issues"
import { expect, type Page, test } from "@playwright/test"
import { adminFixture, navigate } from "./admin-fixture.js"

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
  expect(inputs).toHaveLength(2)
  expect(inputs[1]).toEqual(inputs[0])
  await panel.getByRole("button", { name: "Cancel analysis", exact: true }).click()
  await expect(panel.getByText("Cancelled", { exact: true })).toBeVisible()
})
