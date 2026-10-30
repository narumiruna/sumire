import { expect, type Locator, type Page, test } from "@playwright/test"
import {
  adminFixture,
  basePolicy,
  inventory,
  navigate,
  openDirectoryFilters,
} from "./admin-fixture.js"

const views = ["Overview", "Access", "Model & Tools", "History"] as const
const chats = [
  { id: 42, name: "Fixture chat", type: "private" },
  { id: 43, name: "Fixture pending chat", type: "private" },
  { id: -100, name: "Fixture group", type: "supergroup" },
  { id: -101, name: "Fixture channel", type: "channel" },
]

async function fixture(page: Page) {
  const requests = await adminFixture(page)
  const policy = {
    ...basePolicy,
    models: ["fixture/test", "fixture/other"],
    defaults: { ...basePolicy.defaults, models: ["fixture/test", "fixture/other"] },
  }
  // Keep the overview configured and allow one local model draft. All routes still reject writes.
  await page.route("**/api/**", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (!["/api/chats", "/api/settings", "/api/inventory"].includes(url.pathname)) {
      await route.fallback()
      return
    }
    requests.push(`${request.method()} ${url.pathname}`)
    expect(request.method()).toBe("GET")
    if (url.pathname === "/api/settings") {
      await route.fulfill({ json: { revision: 1, applied: 1, status: "applied", policy } })
    } else if (url.pathname === "/api/inventory") {
      await route.fulfill({
        json: {
          ...inventory,
          providers: inventory.providers.map((provider) => ({ ...provider, configured: true })),
        },
      })
    } else {
      const id = url.searchParams.get("id")
      const query = (url.searchParams.get("q") ?? "").trim().toLowerCase()
      const offset = Number(url.searchParams.get("offset") ?? 0)
      await route.fulfill({
        json:
          id === null
            ? chats
                .filter(
                  (chat) => chat.name.toLowerCase().includes(query) || String(chat.id) === query,
                )
                .slice(offset, offset + 100)
            : chats.filter((chat) => String(chat.id) === id),
      })
    }
  })
  await page.reload()
  await expect(page.getByRole("list", { name: "Chats on this page", exact: true })).toBeVisible()
  return requests
}

async function bounds(locator: Locator) {
  await expect(locator).toBeVisible()
  const box = await locator.boundingBox()
  if (!box) throw new Error(`Missing geometry for ${locator}`)
  return box
}

async function expectActionSize(locator: Locator) {
  const box = await bounds(locator)
  expect(box.height).toBeGreaterThanOrEqual(44)
  expect(box.width).toBeGreaterThanOrEqual(44)
}

async function expectPane(page: Page, directoryVisible: boolean) {
  const directory = page.locator(".chat-directory")
  const details = page.locator(".chat-detail")
  await expect(directoryVisible ? directory : details).toBeVisible()
  await expect(directoryVisible ? details : directory).toBeHidden()
  await expect(
    page.locator(
      ".chat-workspace > .chat-directory:visible, .chat-workspace > .chat-detail:visible",
    ),
  ).toHaveCount(1)
}

async function expectNoOverflow(page: Page) {
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= innerWidth &&
        document.body.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
}

async function expectAllTabs(page: Page) {
  const list = page.getByRole("tablist", { name: "Selected chat views", exact: true })
  await expect(list.getByRole("tab")).toHaveCount(views.length)
  const listBox = await bounds(list)
  const viewport = page.viewportSize()
  if (!viewport) throw new Error("Missing viewport")
  expect(await list.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  for (const name of views) {
    const tab = list.getByRole("tab", { name, exact: true })
    await expectActionSize(tab)
    const box = await bounds(tab)
    expect(box.x).toBeGreaterThanOrEqual(Math.max(0, listBox.x))
    expect(box.x + box.width).toBeLessThanOrEqual(
      Math.min(viewport.width, listBox.x + listBox.width) + 1,
    )
    await expect(tab).toBeInViewport({ ratio: 1 })
  }
}

function expectNoWrites(requests: string[]) {
  expect(requests.filter((request) => !request.startsWith("GET "))).toEqual([])
}

for (const width of [1440, 851, 850, 390, 320]) {
  test.describe(`${width}px single chat workspace`, () => {
    test.use({ viewport: { width, height: width === 1440 ? 900 : 844 } })

    test("shows one pane, readable current facts, and one shared chat actions menu", async ({
      page,
    }) => {
      const requests = await fixture(page)
      await expectPane(page, true)
      await expectNoOverflow(page)
      const row = page.getByRole("button", { name: "Fixture chat · 42", exact: true })
      await expectActionSize(row)
      await row.click()
      await expectPane(page, false)
      const details = page.locator(".chat-detail")
      await expect(
        details.getByRole("heading", { name: "Fixture chat", exact: true }),
      ).toBeVisible()
      const overview = details.getByRole("tabpanel", { name: "Overview", exact: true })
      const facts = overview.locator(".chat-overview-facts")

      // Measure the initial overview before any action can scroll it into view.
      if (width === 1440) {
        expect((await bounds(details)).width).toBeLessThanOrEqual(800)
        expect((await bounds(facts)).width).toBeLessThanOrEqual(800)
      }
      if (width === 390) {
        const firstFact = await bounds(facts.locator(".rt-DataListItem").first())
        expect(firstFact.y).toBeGreaterThanOrEqual(0)
        expect(firstFact.y).toBeLessThanOrEqual(400)
      }
      for (const [label, value] of [
        ["Access", "Approved and enabled"],
        ["Model", "fixture/test"],
        ["Tools", "1 allowed"],
      ] as const) {
        const term = facts.getByRole("term").filter({ hasText: new RegExp(`^${label}$`) })
        await expect(term).toBeVisible()
        await expect(term.locator("..").getByRole("definition")).toContainText(value)
      }
      for (const name of ["Manage access", "Change model", "View tool permissions"]) {
        const action = overview.getByRole("button", { name, exact: true })
        await expectActionSize(action)
        if (width !== 320) await expect(action).toBeInViewport({ ratio: 1 })
      }
      await expectActionSize(
        details.getByRole("button", { name: "Back to chat directory", exact: true }),
      )
      await expectAllTabs(page)
      await expectNoOverflow(page)

      const actions = details.getByRole("button", { name: "Chat actions", exact: true })
      await expect(actions).toHaveCount(1)
      await expectActionSize(actions)
      await expect(details.getByRole("button", { name: "Copy chat ID", exact: true })).toHaveCount(
        0,
      )
      await expect(
        details.getByRole("button", { name: "View conversation records", exact: true }),
      ).toHaveCount(0)
      await expect(
        details.getByRole("link", { name: "View conversation records", exact: true }),
      ).toHaveCount(0)
      await actions.click()
      const menu = page.getByRole("menu")
      await expect(menu.getByRole("menuitem")).toHaveCount(2)
      await expect(menu.getByRole("menuitem", { name: "Copy chat ID", exact: true })).toBeVisible()
      await expect(
        menu.getByRole("menuitem", { name: "View conversation records", exact: true }),
      ).toBeVisible()
      await expectNoOverflow(page)
      await page.keyboard.press("Escape")
      await expect(menu).toBeHidden()
      await expect(actions).toBeFocused()
      expectNoWrites(requests)
    })

    test("Back preserves search, filters, selection, and drafts; Show selected chat restores details", async ({
      page,
    }) => {
      const requests = await fixture(page)
      const directory = page.locator(".chat-directory")
      const search = directory.getByRole("textbox", { name: "Search stored chats", exact: true })
      await search.fill("Fixture")
      await expect(directory.getByRole("list").locator(".directory-chat")).toHaveCount(4)
      await openDirectoryFilters(page)
      const type = directory.getByRole("combobox", { name: "Chat type", exact: true })
      const access = directory.getByRole("combobox", { name: "Access status", exact: true })
      await expectActionSize(type)
      await expectActionSize(access)
      await type.click()
      await page.getByRole("option", { name: "Private", exact: true }).click()
      await access.click()
      await page.getByRole("option", { name: "Approved and enabled", exact: true }).click()
      await expect(directory.getByRole("list").locator(".directory-chat")).toHaveCount(1)
      const selected = directory.getByRole("button", { name: "Fixture chat · 42", exact: true })
      await selected.click()
      await expectPane(page, false)
      const details = page.locator(".chat-detail")
      await details.getByRole("button", { name: "Change model", exact: true }).click()
      const model = details.getByRole("combobox", { name: "Chat model override", exact: true })
      await model.click()
      await page.getByRole("option", { name: "fixture/other", exact: true }).click()
      await expect(page.locator("#save-status")).toContainText("2 unsaved changes")
      const idDraft = directory.getByRole("textbox", {
        name: "Chat ID (can configure before first message)",
        exact: true,
      })

      for (let visit = 0; visit < 2; visit++) {
        await details.getByRole("button", { name: "Back to chat directory", exact: true }).click()
        await expectPane(page, true)
        await expect(selected).toBeFocused()
        await expect(search).toHaveValue("Fixture")
        await expect(type).toHaveText("Private")
        await expect(access).toHaveText("Approved and enabled")
        await expect(directory.getByRole("list").locator(".directory-chat")).toHaveCount(1)
        await expect(selected).toHaveAttribute("aria-current", "true")
        await expect(
          directory.locator('.chat-list .directory-chat[aria-current="true"]'),
        ).toHaveCount(1)
        if (visit === 0) {
          await directory.locator(".configure-id > summary").click()
          await idDraft.fill("-9999")
        }
        await expect(idDraft).toHaveValue("-9999")
        await expectNoOverflow(page)
        const show = directory.getByRole("button", { name: "Show selected chat", exact: true })
        await expectActionSize(show)
        await show.click()
        await expectPane(page, false)
        await expect(details.locator(".chat-header code")).toHaveText("42")
        await expect(
          details.getByRole("tab", { name: "Model & Tools", exact: true }),
        ).toHaveAttribute("aria-selected", "true")
        await expect(model).toHaveText("fixture/other")
        await expect(page.locator("#save-status")).toContainText("2 unsaved changes")
        await expectNoOverflow(page)
      }
      expectNoWrites(requests)
    })
  })
}

test("desktop keyboard navigation moves between the directory, details, and chat actions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const requests = await fixture(page)
  const directory = page.locator(".chat-directory")
  const search = directory.getByRole("textbox", { name: "Search stored chats", exact: true })
  await search.fill("Fixture chat")
  await expect(directory.getByRole("list").locator(".directory-chat")).toHaveCount(1)
  await search.press("Tab")
  await expect(directory.locator(".directory-options > summary")).toBeFocused()
  await page.keyboard.press("Tab")
  const selected = directory.getByRole("button", { name: "Fixture chat · 42", exact: true })
  await expect(selected).toBeFocused()
  await page.keyboard.press("Enter")
  await expectPane(page, false)
  const details = page.locator(".chat-detail")
  await expect(details.getByRole("heading", { name: "Fixture chat", exact: true })).toBeFocused()
  await page.keyboard.press("Tab")
  const actions = details.getByRole("button", { name: "Chat actions", exact: true })
  await expect(actions).toBeFocused()
  await page.keyboard.press("Enter")
  const menu = page.getByRole("menu")
  const copy = menu.getByRole("menuitem", { name: "Copy chat ID", exact: true })
  await expect(copy).toBeFocused()
  await page.keyboard.press("End")
  await expect(
    menu.getByRole("menuitem", { name: "View conversation records", exact: true }),
  ).toBeFocused()
  await page.keyboard.press("Home")
  await expect(copy).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(actions).toBeFocused()
  await page.keyboard.press("Shift+Tab")
  await expect(
    details.getByRole("button", { name: "Back to chat directory", exact: true }),
  ).toBeFocused()
  await page.keyboard.press("Enter")
  await expectPane(page, true)
  await expect(selected).toBeFocused()
  await expect(search).toHaveValue("Fixture chat")
  await expect(selected).toHaveAttribute("aria-current", "true")
  await page.keyboard.press("Tab")
  await expect(
    directory.getByRole("button", { name: "Actions for Fixture chat · 42", exact: true }),
  ).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(directory.getByRole("button", { name: "Refresh chats", exact: true })).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(
    directory.getByRole("button", { name: "Show selected chat", exact: true }),
  ).toBeFocused()
  await page.keyboard.press("Enter")
  await expectPane(page, false)
  await expect(details.getByRole("heading", { name: "Fixture chat", exact: true })).toBeFocused()
  await expectNoOverflow(page)
  expectNoWrites(requests)
})

for (const width of [1440, 390]) {
  test(`history closes directory selectors when the details pane opens at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    const requests = await fixture(page)
    await openDirectoryFilters(page)
    await page.getByRole("combobox", { name: "Chat type", exact: true }).click()
    await expect(page.getByRole("listbox")).toBeVisible()
    await page.evaluate(() => {
      history.pushState(null, "", "?section=Chats&chat=42")
      dispatchEvent(new PopStateEvent("popstate"))
    })
    await expectPane(page, false)
    await expect(page.getByRole("listbox")).toHaveCount(0)
    await expect(page.locator(".chat-header").getByRole("heading")).toBeFocused()
    expectNoWrites(requests)
  })

  test(`browser Back closes chat actions and restores the empty-selection directory at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    const requests = await fixture(page)
    await page.getByRole("button", { name: "Fixture chat · 42", exact: true }).click()
    await page.getByRole("button", { name: "Chat actions", exact: true }).click()
    await expect(page.getByRole("menu")).toBeVisible()
    await page.goBack()
    await expectPane(page, true)
    await expect(page.getByRole("menu")).toHaveCount(0)
    await expect(
      page.getByRole("textbox", { name: "Search stored chats", exact: true }),
    ).toBeFocused()
    expectNoWrites(requests)
  })
}

for (const width of [1440, 390]) {
  test(`return from Chat access reveals and focuses the retained chat at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    const requests = await fixture(page)
    const management = page.locator("details#chat-access-management")
    const details = page.locator(".chat-detail")
    const id = management.locator("#access-id-input")
    await expect(management.locator(":scope > summary")).toHaveText("Manage chat access")
    await expect(management).not.toHaveAttribute("open", "")
    await expect(management.locator(".access-approve-form")).toBeHidden()
    await expect(management.locator(".access-lists")).toBeHidden()
    await expect(page.locator("#chat-access-management + .chat-workspace")).toHaveCount(1)
    await page.getByRole("button", { name: "Fixture chat · 42", exact: true }).click()
    await details.getByRole("button", { name: "Manage access", exact: true }).click()
    const chatUrl = page.url()
    const access = details.getByRole("tab", { name: "Access", exact: true })
    for (let visit = 0; visit < 2; visit++) {
      await details.getByRole("button", { name: "Manage chat access", exact: true }).click()
      await expect(management).toHaveAttribute("open", "")
      await expect(id).toBeFocused()
      await expect(page).toHaveURL(chatUrl)
      await expect(page.locator("#current-section-heading")).toHaveText("Chats")
      await expectPane(page, false)
      await expect(details.locator(".chat-header code")).toHaveText("42")
      await expect(access).toHaveAttribute("aria-selected", "true")
      if (visit === 0) await id.fill("43")
      await management.getByRole("button", { name: "Back to chat details", exact: true }).click()
      await expect(management).not.toHaveAttribute("open", "")
      await expectPane(page, false)
      await expect(details.locator(".chat-header").getByRole("heading")).toBeFocused()
      await expect(details.locator(".chat-header code")).toHaveText("42")
      await expect(access).toHaveAttribute("aria-selected", "true")
      await expect(id).toHaveValue("43")
    }
    expectNoWrites(requests)
  })
}

test("retained access target returns to that chat after history clears the current selection", async ({
  page,
}) => {
  const requests = await fixture(page)
  const management = page.locator("details#chat-access-management")
  await page.getByRole("button", { name: "Fixture chat · 42", exact: true }).click()
  await page.getByRole("button", { name: "Manage access", exact: true }).click()
  await page.getByRole("button", { name: "Manage chat access", exact: true }).click()
  await expect(management.locator("#access-id-input")).toBeFocused()
  await expect(
    management.getByRole("heading", { name: "Access for chat 42", exact: true }),
  ).toBeVisible()
  await page.evaluate(() => {
    history.pushState(null, "", "?section=Chats")
    dispatchEvent(new PopStateEvent("popstate"))
  })
  await expectPane(page, true)
  await expect(page.locator('.chat-list .directory-chat[aria-current="true"]')).toHaveCount(0)
  await management.locator(":scope > summary").click()
  await expect(management).not.toHaveAttribute("open", "")
  await navigate(page, "Access")
  await expect(management).toHaveAttribute("open", "")
  await expect(page.locator("#current-section-heading")).toHaveText("Chats")
  await management.getByRole("button", { name: "Back to chat details", exact: true }).click()
  await expect(management).not.toHaveAttribute("open", "")
  await expectPane(page, false)
  await expect(page.locator(".chat-header code")).toHaveText("42")
  await expect(page.locator(".chat-header").getByRole("heading")).toBeFocused()
  expectNoWrites(requests)
})

for (const activation of ["Control+Enter", "Shift+Enter", "Control+click"]) {
  test(`record menu link preserves native ${activation} activation`, async ({ page }) => {
    await fixture(page)
    await page.getByRole("button", { name: "Fixture chat · 42", exact: true }).click()
    await page.getByRole("button", { name: "Chat actions", exact: true }).click()
    const records = page.getByRole("menuitem", { name: "View conversation records", exact: true })
    const href = await records.getAttribute("href")
    if (!href) throw new Error("Missing conversation records link")
    const url = new URL(href, page.url()).href
    // The new tab is a synthetic document, never a live bot/provider session.
    await page.context().route(url, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Fixture records</title><h1>Fixture records</h1>",
      }),
    )
    await records.focus()
    const popupWait = page.context().waitForEvent("page")
    if (activation === "Control+click") await records.click({ modifiers: ["Control"] })
    else await records.press(activation)
    const popup = await popupWait
    await popup.waitForLoadState()
    expect(popup.url()).toBe(url)
    await expect(popup.getByRole("heading", { name: "Fixture records" })).toBeVisible()
    await expect(page.locator("#current-section-heading")).toHaveText("Chats")
    await popup.close()
  })
}

test("all four tabs remain visible at 320px and support Home, End, and wrapping arrow keys", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 })
  const requests = await fixture(page)
  await page.getByRole("button", { name: "Fixture chat · 42", exact: true }).click()
  await expectPane(page, false)
  await expectAllTabs(page)
  await page.getByRole("tab", { name: "Overview", exact: true }).focus()
  for (const [key, name] of [
    ["End", "History"],
    ["Home", "Overview"],
    ["ArrowRight", "Access"],
    ["ArrowRight", "Model & Tools"],
    ["ArrowRight", "History"],
    ["ArrowRight", "Overview"],
    ["ArrowLeft", "History"],
  ] as const) {
    await page.keyboard.press(key)
    const tab = page.getByRole("tab", { name, exact: true })
    await expect(tab).toBeFocused()
    await expect(tab).toHaveAttribute("aria-selected", "true")
    await expect(page.getByRole("tabpanel")).toHaveCount(1)
    await expect(page.getByRole("tabpanel", { name, exact: true })).toBeVisible()
    await expectAllTabs(page)
    await expectNoOverflow(page)
  }
  expectNoWrites(requests)
})
