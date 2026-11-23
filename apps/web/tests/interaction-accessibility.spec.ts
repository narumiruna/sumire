import { expect, test } from "@playwright/test"
import { adminFixture, navigate, sectionLabel, sections } from "./admin-fixture.js"
import { contrast } from "./contrast.js"

for (const mode of ["font", "zoom"] as const) {
  test(`200% ${mode} enlargement retains the ten page workflows`, async ({ page }, testInfo) => {
    test.setTimeout(90000)
    await page.setViewportSize({ width: mode === "font" ? 1440 : 640, height: 1000 })
    const requests = await adminFixture(page)
    const client = mode === "font" ? await page.context().newCDPSession(page) : undefined
    if (mode === "zoom")
      await page.evaluate(() => {
        document.documentElement.style.zoom = "2"
      })
    for (const section of sections) {
      await navigate(page, section)
      // Chromium resets this CDP override on same-document history navigation.
      // Reapply it to each page, then verify that the measured body text doubled.
      if (client) await client.send("Page.setFontSizes", { fontSizes: { standard: 32 } })
      await expect(page.locator("#current-section-heading")).toHaveText(
        ["Chats", "Access"].includes(section) ? "Chats" : sectionLabel(section),
      )
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      )
      await expect(
        page.getByRole("alert").filter({ hasText: "could not be displayed" }),
      ).toHaveCount(0)
      if (mode === "font") {
        expect(
          await page
            .locator(".admin-theme")
            .first()
            .evaluate((node) => getComputedStyle(node).fontSize),
        ).toBe("32px")
      }
      const focusables = page.locator("main :is(button,a,input,summary)")
      for (const control of await focusables.all()) {
        if (!(await control.isVisible()) || !(await control.isEnabled())) continue
        await control.focus()
        expect(await control.evaluate((node) => node === document.activeElement)).toBe(true)
      }
      await page.evaluate(() => scrollTo(0, 0))
      await page.screenshot({ path: testInfo.outputPath(`${mode}-${section}.png`), fullPage: true })
    }
    expect(requests.every((request) => request.startsWith("GET "))).toBe(true)
  })
}

for (const [layout, width, height] of [
  ["expanded", 1810, 1022],
  ["compact", 1810, 1022],
  ["mobile", 320, 844],
  ["mobile", 390, 844],
] as const) {
  for (const fontScale of [100, 200]) {
    test(`account control in ${layout} navigation at ${width}px and ${fontScale}% text`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height })
      const requests = await adminFixture(page)
      const sidebar = page.getByRole("complementary", { name: "Administration navigation" })
      const expanded = layout === "expanded"
      if (expanded) await sidebar.getByRole("button", { name: "Expand navigation" }).click()
      if (fontScale === 200) {
        const client = await page.context().newCDPSession(page)
        await client.send("Page.setFontSizes", { fontSizes: { standard: 32 } })
        await expect(page.locator(".admin-theme").first()).toHaveCSS("font-size", "32px")
      }
      const footer = sidebar.locator(".sidebar-account")
      const account = footer.getByRole("button", { name: "Account", exact: true })
      await expect(footer.getByRole("button")).toHaveCount(1)
      await expect(footer.locator("svg:visible")).toHaveCount(expanded ? 2 : 1)
      const role = account.getByText("Administrator", { exact: true })
      const id = account.getByText("42", { exact: true })
      if (expanded) {
        await expect(role).toBeVisible()
        await expect(id).toBeVisible()
        expect((await role.boundingBox())?.y).toBeLessThan((await id.boundingBox())?.y ?? 0)
        if (fontScale === 100) {
          // Expanded footer measured 149px at this viewport before consolidation.
          expect((await footer.boundingBox())?.height).toBeLessThan(149)
        } else {
          await expect(id).toHaveCSS("font-size", "32px")
        }
      } else {
        await expect(role).toBeHidden()
        await expect(id).toBeHidden()
      }
      const precedingControl = sidebar.getByRole("button", {
        name: layout === "mobile" ? /^Sections ·/ : /^(Collapse|Expand) navigation$/,
      })
      await precedingControl.focus()
      await page.keyboard.press("Tab")
      await expect(account).toBeFocused()
      await expect(account).toBeInViewport({ ratio: 1 })
      await expect(account).toHaveCSS("outline-style", "solid")
      expect((await contrast(account)).text).toBeGreaterThanOrEqual(4.5)

      const target = await account.boundingBox()
      const launcher = await page.locator(".feedback-launcher").boundingBox()
      if (!target || !launcher)
        throw new Error("Account control and feedback launcher must be visible")
      expect(target.width).toBeGreaterThanOrEqual(44)
      expect(target.height).toBeGreaterThanOrEqual(44)
      expect(
        target.x + target.width <= launcher.x ||
          launcher.x + launcher.width <= target.x ||
          target.y + target.height <= launcher.y ||
          launcher.y + launcher.height <= target.y,
      ).toBe(true)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      )

      await page.keyboard.press("ArrowDown")
      const menu = page.getByRole("menu", { name: "Account", exact: true })
      await expect(menu).toBeInViewport({ ratio: 1 })
      await expect(menu.getByText("Administrator: 42", { exact: true })).toBeVisible()
      await expect(menu.getByRole("menuitem", { name: "Sign out", exact: true })).toBeFocused()
      await page.keyboard.press("Escape")
      await expect(menu).toBeHidden()
      await expect(account).toBeFocused()
      expect(requests.every((request) => request.startsWith("GET "))).toBe(true)
    })
  }
}

test("keyboard sign-out preserves the discard guard and disables the trigger while busy", async ({
  page,
}) => {
  await adminFixture(page)
  const logoutRequests: string[] = []
  let finishLogout = () => {}
  const logoutResponse = new Promise<void>((resolve) => {
    finishLogout = resolve
  })
  await page.route("**/api/logout", async (route) => {
    const request = route.request()
    logoutRequests.push(`${request.method()} ${request.headers()["x-csrf-token"]}`)
    await logoutResponse
    await route.fulfill({ json: {} })
  })
  await navigate(page, "Access")
  const draft = page.getByLabel("Telegram ID to approve", { exact: true })
  await draft.fill("8001")
  const account = page.getByRole("button", { name: "Account", exact: true })
  const signOut = page.getByRole("menuitem", { name: "Sign out", exact: true })
  const discardPrompts: string[] = []
  await account.press("Enter")
  page.once("dialog", async (dialog) => {
    discardPrompts.push(dialog.message())
    await dialog.dismiss()
  })
  await signOut.press("Enter")
  await expect(signOut).toBeHidden()
  await expect(account).toBeEnabled()
  await expect(draft).toHaveValue("8001")
  expect(discardPrompts).toEqual(["Discard pending changes and leave?"])
  expect(logoutRequests).toEqual([])

  await account.press("Enter")
  page.once("dialog", async (dialog) => {
    discardPrompts.push(dialog.message())
    await dialog.accept()
  })
  try {
    await signOut.press("Enter")
    await expect.poll(() => logoutRequests).toEqual(["POST fixture"])
    await expect(account).toBeDisabled()
  } finally {
    finishLogout()
  }
  await expect(
    page.getByRole("button", { name: "Sign in with passkey", exact: true }),
  ).toBeVisible()
  expect(discardPrompts).toEqual(Array(2).fill("Discard pending changes and leave?"))
})
