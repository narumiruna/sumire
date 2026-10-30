import { expect, type Locator, type Page, test } from "@playwright/test"
import { navigate, openChatAccess, openDisclosure } from "./admin-fixture.js"
import { remediationFixture } from "./remediation-fixture.js"

async function activate(control: Locator, method: "pointer" | "keyboard") {
  if (method === "pointer") await control.click()
  else {
    await control.evaluate((element) => (element as HTMLElement).focus({ preventScroll: true }))
    await control.press("Enter")
  }
}

async function expectAvailability(page: Page) {
  const target = page.locator("#model-availability")
  await expect(target).toBeFocused()
  await expect(target).toBeInViewport({ ratio: 1 })
  const targetBox = await target.boundingBox()
  const changesBar = page.locator(".changes-bar")
  const statusBox = (await changesBar.count()) ? await changesBar.boundingBox() : null
  if (!targetBox) throw new Error("Missing availability geometry")
  const visibleBottom = statusBox?.y ?? (await page.evaluate(() => innerHeight))
  expect(targetBox.y + targetBox.height).toBeLessThanOrEqual(visibleBottom)
  await expect(page).toHaveURL(/#model-availability$/)
  expect(new URL(page.url()).searchParams.get("chat")).toBe("42")
}

for (const width of [1440, 390, 320]) {
  for (const method of ["pointer", "keyboard"] as const) {
    test(`explicit availability navigation reveals its target and retains drafts with ${method} at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 })
      const state = await remediationFixture(page)
      await page
        .getByRole("list", { name: "Chats on this page" })
        .locator(".directory-chat")
        .click()
      await navigate(page, "Access")
      await page.getByRole("button", { name: "Revoke access for ID 42", exact: true }).click()
      await page.getByLabel("Telegram ID to approve", { exact: true }).fill("8001")
      await navigate(page, "MCP connections")
      await page.getByRole("button", { name: "Add connection", exact: true }).click()
      await page.getByLabel("MCP server name", { exact: true }).fill("navigation-draft")
      await page.getByLabel("Connection command", { exact: true }).fill("npx")
      await navigate(page, "Defaults")
      await openDisclosure(page, "Allowed models · 1 effective")
      await page.evaluate(() => {
        const url = new URL(window.location.href)
        url.searchParams.set("existing", "retained")
        window.history.replaceState(null, "", url)
        window.scrollTo(0, document.documentElement.scrollHeight)
      })
      expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
      const manage = page.getByRole("button", { name: "Manage model availability", exact: true })
      await activate(manage, method)
      await expectAvailability(page)
      expect(new URL(page.url()).searchParams.get("existing")).toBe("retained")

      // Sections stay mounted to retain drafts. Invoke the retained source again to exercise
      // an explicit same-page request without adding a test-only route or UI control.
      const historyLength = await page.evaluate(() => window.history.length)
      await page.getByRole("heading", { name: "Model providers", exact: true }).focus()
      await page.evaluate(() => window.scrollTo(0, 0))
      await page
        .locator("button")
        .filter({ hasText: /^Manage model availability$/ })
        .evaluate((element) => (element as HTMLButtonElement).click())
      await expectAvailability(page)
      expect(await page.evaluate(() => window.history.length)).toBe(historyLength)

      await page.goBack()
      await expect(page.locator('.admin-page[aria-label="Shared defaults"]')).toBeVisible()
      await page.goForward()
      await expect(page.locator("#model-availability")).toBeVisible()
      await navigate(page, "Access")
      await expect(page.getByLabel("Telegram ID to approve", { exact: true })).toHaveValue("8001")
      await expect(
        page.getByRole("button", { name: "Undo revocation for 42", exact: true }),
      ).toBeVisible()
      expect(new URL(page.url()).hash).toBe("")
      expect(new URL(page.url()).searchParams.get("chat")).toBe("42")
      await navigate(page, "MCP connections")
      await expect(page.getByLabel("MCP server name", { exact: true })).toHaveValue(
        "navigation-draft",
      )
      await expect(page.getByLabel("Connection command", { exact: true })).toHaveValue("npx")
      await navigate(page, "Chats")
      await expect(
        page
          .getByRole("list", { name: "Chats on this page", includeHidden: true })
          .locator(".directory-chat"),
      ).toHaveAttribute("aria-current", "true")
      expect(state.writes).toEqual([])
    })
  }

  test(`ordinary sidebar and browser history keep their focus behavior at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    const state = await remediationFixture(page)
    await navigate(page, "Access")
    await page.getByLabel("Telegram ID to approve", { exact: true }).fill("8001")
    await navigate(page, "Defaults")
    const destination =
      width === 1440
        ? page.getByRole("heading", { name: "Shared defaults", exact: true })
        : page.getByRole("button", { name: "Sections · Shared defaults", exact: true })
    await expect(destination).toBeFocused()
    if (width === 1440) expect(await page.evaluate(() => window.scrollY)).toBe(0)
    else await expect(destination).toHaveAttribute("aria-expanded", "false")
    await page.goBack()
    await expect(page.getByLabel("Telegram ID to approve", { exact: true })).toHaveValue("8001")
    await page.getByLabel("Telegram ID to approve", { exact: true }).focus()
    await page.goForward()
    await expect(page.getByRole("heading", { name: "Shared defaults", exact: true })).toBeVisible()
    await expect(page.locator("#model-availability")).not.toBeFocused()
    await expect(
      page.getByRole("heading", { name: "Shared defaults", exact: true }),
    ).not.toBeFocused()
    expect(state.writes).toEqual([])
  })

  for (const accept of [true, false]) {
    test(`keyboard MCP discard ${accept ? "accepts and returns to Add" : "cancels and retains focus"} at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 })
      const state = await remediationFixture(page)
      await navigate(page, "MCP connections")
      await page.getByRole("button", { name: "Add connection", exact: true }).click()
      await page.getByLabel("MCP server name", { exact: true }).fill("discard-draft")
      await page.getByLabel("Connection command", { exact: true }).fill("npx")
      await openDisclosure(page, "Secrets (optional)")
      await page.getByLabel("Secret field name", { exact: true }).fill("DRAFT_KEY")
      await page.getByLabel("New secret value", { exact: true }).fill("synthetic-draft-value")
      const discard = page.getByRole("button", { name: "Discard MCP draft", exact: true })
      await discard.focus()
      page.once("dialog", (dialog) => (accept ? dialog.accept() : dialog.dismiss()))
      await discard.press("Enter")
      if (accept) {
        const add = page.getByRole("button", { name: "Add connection", exact: true })
        await expect(add).toBeFocused()
        await expect(add).toBeVisible()
        await expect(add).toBeEnabled()
        await expect(page.getByLabel("MCP server name", { exact: true })).toBeHidden()
        await expect(page.locator("#save-status")).not.toContainText("MCP: Unsaved configuration")
        await add.press("Enter")
        await expect(page.getByLabel("MCP server name", { exact: true })).toHaveValue("")
        await expect(page.getByLabel("Connection command", { exact: true })).toHaveValue("")
        await openDisclosure(page, "Secrets (optional)")
        await expect(page.getByLabel("Secret field name", { exact: true })).toHaveValue("")
        await expect(page.getByLabel("New secret value", { exact: true })).toHaveValue("")
      } else {
        await expect(discard).toBeFocused()
        await expect(page.getByLabel("MCP server name", { exact: true })).toHaveValue(
          "discard-draft",
        )
        await expect(page.getByLabel("Connection command", { exact: true })).toHaveValue("npx")
        await expect(page.getByLabel("Secret field name", { exact: true })).toHaveValue("DRAFT_KEY")
        await expect(page.getByLabel("New secret value", { exact: true })).toHaveValue(
          "synthetic-draft-value",
        )
        await expect(page.locator("#save-status")).toContainText("MCP: Unsaved configuration")
      }
      expect(state.writes).toEqual([])
    })
  }
}

// Hold animation frames so route changes can invalidate focus work before it executes.
async function holdFocusFrames(page: Page) {
  await page.evaluate(() => {
    const request = window.requestAnimationFrame
    const cancel = window.cancelAnimationFrame
    const callbacks = new Map<number, FrameRequestCallback>()
    let next = 1
    window.requestAnimationFrame = (callback) => {
      const id = next++
      callbacks.set(id, callback)
      return id
    }
    window.cancelAnimationFrame = (id) => {
      callbacks.delete(id)
    }
    ;(window as typeof window & { releaseFocusFrames(): void }).releaseFocusFrames = () => {
      window.requestAnimationFrame = request
      window.cancelAnimationFrame = cancel
      for (const callback of callbacks.values()) callback(performance.now())
      callbacks.clear()
    }
  })
}

async function releaseFocusFrames(page: Page) {
  await page.evaluate(() => {
    ;(window as typeof window & { releaseFocusFrames(): void }).releaseFocusFrames()
  })
}

test("later navigation and history cancel explicit target focus before its frame", async ({
  page,
}) => {
  const state = await remediationFixture(page)
  await navigate(page, "Defaults")
  await holdFocusFrames(page)
  await page
    .getByRole("button", { name: "Manage model availability", exact: true })
    .evaluate((element) => (element as HTMLButtonElement).click())
  await expect(page.locator("#model-availability")).toBeVisible()
  await page
    .getByRole("link", { name: "Audit", exact: true })
    .evaluate((element) => (element as HTMLAnchorElement).click())
  await expect(page.getByRole("heading", { name: "Audit", exact: true })).toBeVisible()
  await releaseFocusFrames(page)
  await expect(page.getByRole("heading", { name: "Audit", exact: true })).toBeFocused()
  await expect(page.locator("#model-availability")).not.toBeFocused()

  await navigate(page, "Defaults")
  await holdFocusFrames(page)
  await page
    .getByRole("button", { name: "Manage model availability", exact: true })
    .evaluate((element) => (element as HTMLButtonElement).click())
  await expect(page.locator("#model-availability")).toBeVisible()
  await page.goBack()
  await expect(page.getByRole("heading", { name: "Shared defaults", exact: true })).toBeVisible()
  const model = page.getByRole("combobox", { name: "Shared default model", exact: true })
  await model.focus()
  await releaseFocusFrames(page)
  await expect(model).toBeFocused()
  await page.goForward()
  await expect(page.locator("#model-availability")).toBeVisible()
  await expect(page.locator("#model-availability")).not.toBeFocused()
  expect(state.writes).toEqual([])
})

test("MCP discard and queued editor focus cannot take focus after navigation or expiry", async ({
  page,
}) => {
  const state = await remediationFixture(page)
  await navigate(page, "MCP connections")
  await page.getByRole("button", { name: "Add connection", exact: true }).click()
  await page.getByLabel("MCP server name", { exact: true }).fill("discard-draft")
  await holdFocusFrames(page)
  page.once("dialog", (dialog) => dialog.accept())
  await page
    .getByRole("button", { name: "Discard MCP draft", exact: true })
    .evaluate((element) => (element as HTMLButtonElement).click())
  await page
    .getByRole("link", { name: "Chats", exact: true })
    .evaluate((element) => (element as HTMLAnchorElement).click())
  await expect(page.getByRole("heading", { name: "Chats", exact: true })).toBeVisible()
  await releaseFocusFrames(page)
  await openChatAccess(page)
  const access = page.getByLabel("Telegram ID to approve", { exact: true })
  await access.fill("8001")
  await expect(access).toBeFocused()
  await expect(page.getByRole("button", { name: "Add connection", exact: true })).toBeHidden()

  await navigate(page, "MCP connections")
  await holdFocusFrames(page)
  await page
    .getByRole("button", { name: "Add connection", exact: true })
    .evaluate((element) => (element as HTMLButtonElement).click())
  await expect(page.getByLabel("MCP server name", { exact: true })).toBeVisible()
  await page
    .getByRole("link", { name: "Chats", exact: true })
    .evaluate((element) => (element as HTMLAnchorElement).click())
  await expect(page.getByRole("heading", { name: "Chats", exact: true })).toBeVisible()
  await releaseFocusFrames(page)
  await expect(page.getByRole("heading", { name: "Chats", exact: true })).toBeFocused()
  await expect(page.getByLabel("MCP server name", { exact: true })).not.toBeFocused()
  expect(state.writes).toEqual([])

  await access.fill("")
  await navigate(page, "MCP connections")
  await page.getByRole("button", { name: "Close connection editor", exact: true }).click()
  await holdFocusFrames(page)
  await page
    .getByRole("button", { name: "Resume connection draft", exact: true })
    .evaluate((element) => (element as HTMLButtonElement).click())
  await page.route("**/api/settings", (route) =>
    route.fulfill({ status: 401, json: { error: "Session expired" } }),
  )
  await page
    .getByRole("button", { name: "Reload", exact: true })
    .evaluate((element) => (element as HTMLButtonElement).click())
  const signIn = page.getByRole("button", { name: "Sign in with passkey", exact: true })
  await expect(signIn).toBeVisible()
  await signIn.focus()
  await releaseFocusFrames(page)
  await expect(signIn).toBeFocused()
  await expect(page.getByLabel("MCP server name", { exact: true })).toHaveCount(0)
})

for (const cancelBeforeReady of [false, true]) {
  test(`a delayed direct availability anchor ${cancelBeforeReady ? "is cancelled by history before render" : "waits for the destination render"}`, async ({
    page,
  }) => {
    const state = await remediationFixture(page)
    let respond: () => void = () => undefined
    const response = new Promise<void>((resolve) => {
      respond = resolve
    })
    await page.route("**/api/settings", async (route) => {
      await response
      await route.fallback()
    })
    await page.goto("/?section=Model+Providers&chat=42&existing=retained#model-availability")
    await expect(page.getByText("Loading settings…", { exact: true })).toBeVisible()
    if (cancelBeforeReady) {
      await holdFocusFrames(page)
      await page.evaluate(() => {
        window.history.pushState(null, "", "?section=Defaults&chat=42&existing=retained")
        window.dispatchEvent(new PopStateEvent("popstate"))
        window.history.pushState(null, "", "?section=Model+Providers&chat=42&existing=retained")
        window.dispatchEvent(new PopStateEvent("popstate"))
      })
    }
    respond()
    if (cancelBeforeReady) {
      const heading = page.getByRole("heading", { name: "Model providers", exact: true })
      await expect(heading).toBeVisible()
      await heading.focus()
      await releaseFocusFrames(page)
      await expect(heading).toBeFocused()
      await expect(page.locator("#model-availability")).not.toBeFocused()
      expect(new URL(page.url()).hash).toBe("")
    } else {
      await expectAvailability(page)
    }
    expect(new URL(page.url()).searchParams.get("existing")).toBe("retained")
    expect(state.writes).toEqual([])
  })
}

test("session expiry cancels an explicit target frame", async ({ page }) => {
  const state = await remediationFixture(page)
  await navigate(page, "Defaults")
  await holdFocusFrames(page)
  await page
    .getByRole("button", { name: "Manage model availability", exact: true })
    .evaluate((element) => (element as HTMLButtonElement).click())
  await expect(page.locator("#model-availability")).toBeVisible()
  await page.route("**/api/settings", (route) =>
    route.fulfill({ status: 401, json: { error: "Session expired" } }),
  )
  await page
    .getByRole("button", { name: "Reload", exact: true })
    .evaluate((element) => (element as HTMLButtonElement).click())
  const signIn = page.getByRole("button", { name: "Sign in with passkey", exact: true })
  await expect(signIn).toBeVisible()
  await signIn.focus()
  await releaseFocusFrames(page)
  await expect(signIn).toBeFocused()
  await expect(page.locator("#model-availability")).toHaveCount(0)
  expect(state.writes).toEqual([])
})

test("later navigation and history do not revive a cancelled explicit editor request", async ({
  page,
}) => {
  const state = await remediationFixture(page)
  await navigate(page, "Tool permissions")
  await openDisclosure(page, "Approve an exact tool name")
  await page
    .getByLabel("Additional approved tool name", { exact: true })
    .fill("retained-tool-draft")
  await navigate(page, "Defaults")
  const resume = page.getByRole("button", {
    name: "Continue editing: Tool permissions — Additional approved tool name",
    exact: true,
  })
  for (const method of ["sections", "history"]) {
    await holdFocusFrames(page)
    await resume.evaluate((element) => (element as HTMLButtonElement).click())
    await expect(page.getByRole("heading", { name: "Tool permissions", exact: true })).toBeVisible()
    if (method === "sections") {
      for (const name of ["Chats", "Tool permissions"]) {
        await page
          .getByRole("link", { name, exact: true })
          .evaluate((element) => (element as HTMLAnchorElement).click())
      }
    } else {
      await page.evaluate(() => {
        for (const section of ["Chats", "Tool permissions"]) {
          const url = new URL(location.href)
          url.searchParams.set("section", section)
          history.pushState(null, "", url)
          window.dispatchEvent(new PopStateEvent("popstate"))
        }
      })
      await page.getByRole("heading", { name: "Tool permissions", exact: true }).focus()
    }
    await releaseFocusFrames(page)
    await expect(page.getByRole("heading", { name: "Tool permissions", exact: true })).toBeFocused()
    await expect(page.locator("#tool-input")).not.toBeFocused()
    await expect(page.getByLabel("Additional approved tool name", { exact: true })).toHaveValue(
      "retained-tool-draft",
    )
  }
  expect(state.writes).toEqual([])
})

test("modified sidebar clicks remain native links", async ({ page }) => {
  const state = await remediationFixture(page)
  const audit = page.getByRole("link", { name: "Audit", exact: true })
  const href = await audit.getAttribute("href")
  for (const modifier of ["ctrlKey", "metaKey", "shiftKey", "altKey"]) {
    const prevented = await audit.evaluate((element, key) => {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, [key]: true })
      // Stop the native default after React has handled the link, without opening another tab.
      let intercepted = false
      const stop = (event: MouseEvent) => {
        intercepted = event.defaultPrevented
        event.preventDefault()
      }
      window.addEventListener("click", stop, { once: true })
      element.dispatchEvent(event)
      return intercepted
    }, modifier)
    expect(prevented).toBe(false)
    await expect(page.getByRole("heading", { name: "Chats", exact: true })).toBeVisible()
    expect(await audit.getAttribute("href")).toBe(href)
  }
  expect(state.writes).toEqual([])
})
