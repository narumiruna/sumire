import type { Feedback, Issue, IssuePage } from "@narumitw/sumire-issues"
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
      page.getByText("Agent session、改善方案與核准後發 PR 尚未啟用。", { exact: false }),
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
