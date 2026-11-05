import { inherited } from "@narumitw/sumire-policy"
import { expect, type Page, test } from "@playwright/test"
import { navigate, openChatAccess, openDirectoryFilters } from "./admin-fixture.js"
import { remediationFixture } from "./remediation-fixture.js"

const chats = [
  { id: 42, name: "Alice", type: "private" },
  { id: 43, name: "Unapproved user", type: "private" },
  { id: -100, name: "Group with a long name 中文測試群組 ".repeat(5), type: "supergroup" },
  { id: -101, name: "Channel", type: "channel" },
]

async function fixture(page: Page) {
  const state = await remediationFixture(page)
  await page.route("**/api/chats?*", async (route) => {
    const url = new URL(route.request().url())
    const id = url.searchParams.get("id")
    const query = (url.searchParams.get("q") ?? "").toLowerCase()
    const offset = Number(url.searchParams.get("offset") ?? 0)
    await route.fulfill({
      json:
        id !== null
          ? chats.filter((chat) => String(chat.id) === id)
          : chats
              .filter(
                (chat) => chat.name.toLowerCase().includes(query) || String(chat.id) === query,
              )
              .slice(offset, offset + 100),
    })
  })
  await page.reload()
  await expect(page.locator(".chat-card")).toHaveCount(chats.length)
  return state
}

function row(page: Page, id: number) {
  return page.locator(".chat-card").filter({
    has: page.getByRole("link", { name: new RegExp(` · ${id}$`) }),
  })
}

async function action(page: Page, id: number, name: string) {
  await row(page, id)
    .getByRole("button", { name: /^More actions for / })
    .click()
  await page.getByRole("menuitem", { name, exact: true }).click()
}

for (const width of [1440, 390, 320]) {
  test(`chat row menus are separate, contained, and keyboard accessible at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    const state = await fixture(page)
    const navigation = page.getByRole("navigation", {
      name: "Administration sections",
      includeHidden: true,
    })
    await expect(
      navigation.getByRole("link", { name: "Chats", exact: true, includeHidden: true }),
    ).toHaveCount(1)
    await expect(
      navigation.getByRole("link", { name: "Chat access", exact: true, includeHidden: true }),
    ).toHaveCount(0)
    await expect(page.locator("#chat-access-management")).not.toHaveAttribute("open", "")
    const initialUrl = page.url()
    for (const chat of chats) {
      const entry = row(page, chat.id)
      const identity = entry.locator(".directory-chat")
      const menu = entry.getByRole("button", {
        name: `More actions for ${chat.name.trim()}`,
      })
      const identityBox = await identity.boundingBox()
      const menuBox = await menu.boundingBox()
      const entryBox = await entry.boundingBox()
      const actionsBox = await entry.locator(".chat-card-actions").boundingBox()
      if (!identityBox || !menuBox || !entryBox || !actionsBox)
        throw new Error("Missing chat row geometry")
      expect(menuBox.width).toBeGreaterThanOrEqual(44)
      expect(menuBox.height).toBeGreaterThanOrEqual(44)
      expect(menuBox.x).toBeGreaterThanOrEqual(actionsBox.x)
      expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(actionsBox.x + actionsBox.width + 1)
      expect(menuBox.y).toBeGreaterThanOrEqual(entryBox.y)
      expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(entryBox.y + entryBox.height + 1)
      expect(actionsBox.x).toBeGreaterThanOrEqual(entryBox.x)
      expect(actionsBox.x + actionsBox.width).toBeLessThanOrEqual(entryBox.x + entryBox.width + 1)
      expect(
        menuBox.y >= identityBox.y + identityBox.height ||
          menuBox.x >= identityBox.x + identityBox.width,
      ).toBe(true)
      await expect(identity).toHaveAttribute("href", new RegExp(`chat=${chat.id}(?:&|$)`))
      await expect(entry.locator("a button, button button")).toHaveCount(0)
    }
    const trigger = row(page, 42).getByRole("button", {
      name: "More actions for Alice",
      exact: true,
    })
    await trigger.focus()
    await trigger.press("Enter")
    await expect(page.getByRole("menuitem", { name: "View details", exact: true })).toBeFocused()
    await page.keyboard.press("End")
    await expect(page.getByRole("menuitem", { name: "Revoke approval", exact: true })).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(trigger).toBeFocused()
    await expect(page.locator(".directory-chat[aria-current]")).toHaveCount(0)
    await expect(page.locator(".pending-bar")).toHaveCount(0)
    expect(page.url()).toBe(initialUrl)
    expect(state.writes).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({
      path: testInfo.outputPath(`chat-directory-${width}.png`),
      fullPage: true,
    })
  })

  test(`row revoke and undo remain staged for private chats and groups at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    const state = await fixture(page)
    const original = structuredClone(state.policy())
    const initialUrl = page.url()
    for (const id of [42, -100]) {
      await action(page, id, "Revoke approval")
      await expect(row(page, id)).toContainText("Revocation not saved")
      await expect(row(page, id).locator(".chat-card-status")).toHaveText("Enabled")
      await expect(page.locator("#save-status")).toContainText("1 unsaved change")
      await action(page, id, "Cancel pending revocation")
      await expect(row(page, id).locator(".chat-card-pending")).toHaveCount(0)
      await expect(page.locator(".pending-bar")).toHaveCount(0)
    }
    expect(page.url()).toBe(initialUrl)
    expect(state.policy()).toEqual(original)
    expect(state.writes).toEqual([])
  })
}

test("row actions preserve disabled overrides and save only explicit approval changes", async ({
  page,
}) => {
  const state = await fixture(page)
  state.policy().chats["42"] = { ...inherited, enabled: false }
  await page.reload()
  const original = structuredClone(state.policy())
  await action(page, 42, "Revoke approval")
  await action(page, 43, "Approve access")
  await expect(row(page, 43)).toContainText("Approval not saved")
  await action(page, 43, "Cancel pending approval")
  await action(page, -100, "Revoke approval")
  expect(state.writes).toEqual([])
  await page.getByRole("button", { name: "Review and save changes", exact: true }).click()
  const dialog = page.getByRole("alertdialog")
  await expect(dialog).toContainText("Private-message access: revoke 42")
  await expect(dialog).toContainText("Group/channel access: revoke -100")
  await dialog.getByRole("button", { name: "Save changes", exact: true }).click()
  const expected = { ...original, privateUsers: [], groups: [-101] }
  await expect.poll(() => state.policy()).toEqual(expected)
  expect(state.writes).toEqual([{ path: "/api/settings", body: { revision: 1, policy: expected } }])
})

test("revoking a filtered row keeps saved-state access until review", async ({ page }) => {
  const state = await fixture(page)
  const search = page.getByLabel(/Search chats|Search stored chats/, { exact: true })
  await search.fill("Alice")
  await openDirectoryFilters(page)
  await page.getByRole("combobox", { name: "Access status", exact: true }).click()
  await page.getByRole("option", { name: "Approved and enabled", exact: true }).click()
  await action(page, 42, "Revoke approval")
  await expect(page.locator(".chat-card")).toHaveCount(1)
  await expect(page.getByRole("menu")).toHaveCount(0)
  await expect(page.locator(".chat-card")).toContainText("Revocation not saved")
  expect(state.writes).toEqual([])
})

test("row menus close when history hides the directory and can open chat details", async ({
  page,
}) => {
  const state = await fixture(page)
  await action(page, 42, "View details")
  await expect(page.locator(".chat-header").getByRole("heading")).toHaveText("Alice")
  await expect(page.getByRole("menu")).toHaveCount(0)
  await page.getByRole("button", { name: "Back to chat directory", exact: true }).click()
  const trigger = row(page, 42).getByRole("button", { name: /^More actions for / })
  await trigger.click()
  await page.evaluate(() => {
    history.pushState(null, "", "?section=Defaults&chat=42")
    dispatchEvent(new PopStateEvent("popstate"))
  })
  await expect(page.getByRole("menu")).toHaveCount(0)
  await page.goBack()
  await expect(page.locator(".chat-directory")).toBeVisible()
  await expect(page.getByRole("menu")).toHaveCount(0)
  expect(state.writes).toEqual([])
})

test("legacy Access links reveal merged management on load, reload, and history", async ({
  page,
}) => {
  const state = await fixture(page)
  await page.goto("/?section=Access&chat=42&existing=1")
  const input = page.getByLabel("Telegram ID to approve", { exact: true })
  await expect(input).toBeFocused()
  await expect(page.getByRole("heading", { name: "Chats", exact: true })).toBeVisible()
  await expect(page.locator(".chat-header code")).toHaveText("42")
  await page.reload()
  await expect(input).toBeFocused()
  await navigate(page, "Defaults")
  await page.goBack()
  await expect(input).toBeFocused()
  expect(new URL(page.url()).searchParams.get("existing")).toBe("1")
  expect(state.writes).toEqual([])
})

test("unfinished manual approval resumes in a collapsed management area with a retained chat", async ({
  page,
}) => {
  const state = await fixture(page)
  await action(page, 42, "View details")
  await page.getByRole("tab", { name: "History", exact: true }).click()
  await openChatAccess(page)
  await page.getByRole("button", { name: "Show selected chat", exact: true }).click()
  const input = page.getByLabel("Telegram ID to approve", { exact: true })
  await input.fill("-246")
  await page.locator("#chat-access-management > summary").click()
  await navigate(page, "Defaults")
  await page
    .getByRole("button", {
      name: "Continue editing: Chat access — Telegram ID to approve",
      exact: true,
    })
    .click()
  await expect(input).toBeFocused()
  await expect(input).toHaveValue("-246")
  await expect(page.getByRole("tab", { name: "History", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  )
  expect(state.writes).toEqual([])
})

test("direct management anchors open the same approval editor without losing selection", async ({
  page,
}) => {
  const state = await fixture(page)
  await page.goto("/?section=Chats&chat=42#chat-access-management")
  await expect(page.locator("#chat-access-management")).toHaveAttribute("open", "")
  await expect(page.locator("#chat-access-management")).toBeFocused()
  await expect(page.getByLabel("Telegram ID to approve", { exact: true })).toBeVisible()
  await expect(page.locator(".chat-header code")).toHaveText("42")
  expect(state.writes).toEqual([])
})
