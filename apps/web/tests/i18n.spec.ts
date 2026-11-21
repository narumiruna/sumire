import { expect, test } from "@playwright/test"
import { adminFixture, navigate, openDisclosure } from "./admin-fixture.js"

const languageSelect = ".language-selector select"
const translations = {
  en: {
    chats: "Chats",
    defaults: "Shared defaults",
    language: "Language",
    title: "Sumire administration",
  },
  "zh-TW": { chats: "聊天管理", defaults: "共用設定", language: "語言", title: "Sumire 管理介面" },
  ja: { chats: "チャット", defaults: "共通の既定値", language: "言語", title: "Sumire 管理画面" },
} as const

test("language changes preserve unfinished input, policy drafts, and stable URLs", async ({
  page,
}) => {
  const requests = await adminFixture(page)
  await navigate(page, "Chats")
  await openDisclosure(page, "Access management")
  await page.locator("#access-id-input").fill("99")
  await page.getByRole("button", { name: "Review approval", exact: true }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(page.locator("#save-status .changes-bar")).toBeVisible()
  await navigate(page, "Tool permissions")
  await openDisclosure(page, "Approve an exact tool name")
  const input = page.locator("#tool-input")
  await input.fill("unfinished_tool")
  await input.evaluate((element) => element.setAttribute("data-locale-test", "retained"))
  const url = page.url()
  const before = [...requests]
  for (const locale of ["ja", "zh-TW", "en"] as const) {
    await page.locator(languageSelect).selectOption(locale)
    await expect(page.locator("html")).toHaveAttribute("lang", locale)
    await expect(
      page.getByRole("combobox", { name: translations[locale].language, exact: true }),
    ).toHaveValue(locale)
    await expect(input).toHaveValue("unfinished_tool")
    await expect(input).toHaveAttribute("data-locale-test", "retained")
    await expect(page.locator("#save-status .changes-bar")).toBeVisible()
    expect(page.url()).toBe(url)
  }
  expect(requests).toEqual(before)
  await navigate(page, "Chats")
  await expect(page.locator("#access-users-list")).toContainText("99")
  await expect(page.locator("#save-status")).toContainText("1 unsaved change")
})

test("existing local errors follow language changes", async ({ page }) => {
  await page.route("**/api/**", (route) => route.fulfill({ status: 503, json: {} }))
  await page.goto("/")
  await expect(page.getByRole("alert")).toContainText("Could not load administrator session")
  await page.getByRole("combobox", { name: "Language", exact: true }).selectOption("ja")
  await expect(page.getByRole("alert")).toContainText("管理者セッションを読み込めませんでした")
})

test("retained runtime metadata errors follow language changes without new requests", async ({
  page,
}) => {
  const requests = await adminFixture(page)
  await page.route("**/api/runtime-config", async (route) => {
    expect(route.request().method()).toBe("GET")
    requests.push("GET /api/runtime-config")
    await route.fulfill({
      json: { revision: 0, applied: 0, status: "applied", secretStatus: "ready", entries: [] },
    })
  })
  await navigate(page, "MCP connections")
  await page.getByRole("button", { name: "Add connection", exact: true }).click()
  await openDisclosure(page, "Stored references (recommended)")
  await page.getByRole("button", { name: "Load stored names", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("Could not verify runtime configuration.")
  const before = [...requests]
  for (const [locale, message] of [
    ["zh-TW", "無法驗證執行階段設定。"],
    ["ja", "ランタイム設定を確認できません。"],
  ] as const) {
    await page.locator(languageSelect).selectOption(locale)
    await expect(page.getByRole("alert")).toContainText(message)
    expect(requests).toEqual(before)
  }
})

test("an explicit language choice persists after reload", async ({ page }) => {
  const requests = await adminFixture(page)
  await page.getByRole("combobox", { name: "Language", exact: true }).selectOption("ja")
  await expect(
    page.getByRole("heading", { name: translations.ja.chats, exact: true }),
  ).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem("sumire.admin.locale"))).toBe("ja")
  await page.reload()
  await expect(page.locator(languageSelect)).toHaveValue("ja")
  await expect(
    page.getByRole("heading", { name: translations.ja.chats, exact: true }),
  ).toBeVisible()
  await expect(page).toHaveTitle(translations.ja.title)
  expect(requests.every((request) => request.startsWith("GET "))).toBe(true)
})

for (const locale of ["en", "zh-TW", "ja"] as const) {
  for (const width of [320, 390, 1280]) {
    test(`${locale} navigation and selector fit at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await adminFixture(page)
      const menu = page.locator(".mobile-menu")
      if (await menu.isVisible()) await menu.click()
      await page.locator(languageSelect).selectOption(locale)
      await expect(
        page.getByRole("heading", { name: translations[locale].chats, exact: true }),
      ).toBeVisible()
      await expect(
        page.getByRole("combobox", { name: translations[locale].language, exact: true }),
      ).toBeVisible()
      await expect(page.getByRole("link", { name: "Fixture chat · 42", exact: true })).toBeVisible()
      const defaults = page
        .locator("#section-navigation a")
        .filter({ hasText: translations[locale].defaults })
      await defaults.click()
      await expect(
        page.getByRole("heading", { name: translations[locale].defaults, exact: true }),
      ).toBeVisible()
      expect(new URL(page.url()).searchParams.get("section")).toBe("Defaults")
      if (await menu.isVisible()) await menu.click()
      const size = await page.locator(languageSelect).boundingBox()
      expect(size?.height).toBeGreaterThanOrEqual(44)
      expect(size?.x).toBeGreaterThanOrEqual(0)
      expect((size?.x ?? 0) + (size?.width ?? 0)).toBeLessThanOrEqual(width)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      )
    })
  }
}

test.describe("browser language detection before sign-in", () => {
  test.use({ locale: "ja-JP" })

  test("uses the browser language until an explicit choice is saved", async ({ page }) => {
    await page.route("**/api/**", async (route) => {
      expect(route.request().method()).toBe("GET")
      await route.fulfill({ status: 401, json: { error: "Sign-in required" } })
    })
    await page.goto("/")
    await expect(
      page.getByRole("button", { name: "Passkey でサインイン", exact: true }),
    ).toBeVisible()
    await expect(page.locator("html")).toHaveAttribute("lang", "ja")
    await page.getByRole("combobox", { name: "言語", exact: true }).selectOption("en")
    await expect(
      page.getByRole("button", { name: "Sign in with passkey", exact: true }),
    ).toBeVisible()
    await page.reload()
    await expect(
      page.getByRole("button", { name: "Sign in with passkey", exact: true }),
    ).toBeVisible()
    await expect(page.locator("html")).toHaveAttribute("lang", "en")
  })

  test("supports selection when localStorage is unavailable", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        get() {
          throw new Error("Storage unavailable")
        },
      })
    })
    await page.route("**/api/**", (route) => route.fulfill({ status: 401, json: {} }))
    await page.goto("/")
    await expect(
      page.getByRole("button", { name: "Passkey でサインイン", exact: true }),
    ).toBeVisible()
    await page.getByRole("combobox", { name: "言語", exact: true }).selectOption("zh-TW")
    await expect(page.getByRole("button", { name: "使用 Passkey 登入", exact: true })).toBeVisible()
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-TW")
  })
})
