import { expect, type Locator, test } from "@playwright/test"
import { navigate, openDisclosure } from "./admin-fixture.js"
import { remediationFixture } from "./remediation-fixture.js"

async function activeResultVisible(search: Locator) {
  await expect(search).toBeFocused()
  await expect
    .poll(() =>
      search.evaluate((element) => {
        const active = document.getElementById(element.getAttribute("aria-activedescendant") ?? "")
        const list = active?.closest('[role="listbox"]')
        if (!active || !list || active.getAttribute("data-active") !== "true") return false
        const result = active.getBoundingClientRect()
        const bounds = list.getBoundingClientRect()
        return (
          result.top >= bounds.top &&
          result.bottom <= bounds.bottom &&
          result.top >= 0 &&
          result.bottom <= innerHeight
        )
      }),
    )
    .toBe(true)
}

for (const width of [1440, 390, 320]) {
  for (const label of ["Provider", "Model"]) {
    test(`${label} long-list picker keeps combobox focus and exits in one Tab at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 })
      const state = await remediationFixture(page)
      const provider = state.inventory.providers[0]
      const firstModel = provider?.models[0]
      if (!provider || !firstModel) throw new Error("Missing fixture provider or model")
      provider.models = [
        firstModel,
        ...Array.from({ length: 121 }, (_, index) => ({
          id: `model-${String(index + 1).padStart(3, "0")}`,
          name: `Model ${String(index + 1).padStart(3, "0")}`,
          thinking: ["off" as const],
          reasoning: false,
          image: false,
        })),
      ]
      state.inventory.providers.push(
        ...Array.from({ length: 121 }, (_, index) => ({
          ...provider,
          id: `provider-${String(index + 1).padStart(3, "0")}`,
          name: `Provider ${String(index + 1).padStart(3, "0")}`,
        })),
      )
      await page.reload()
      await navigate(page, "Model providers")
      const trigger = page.getByRole("button", { name: new RegExp(`^${label}: `) })
      const search = page.getByRole("combobox", {
        name: `Search ${label.toLowerCase()}`,
        exact: true,
      })
      const results = page.getByRole("listbox", { name: `${label} results`, exact: true })
      await trigger.click()
      await expect(search).toBeFocused()
      await expect(results.getByRole("option")).toHaveCount(122)
      expect(
        await results
          .getByRole("option")
          .evaluateAll((options) =>
            options.every((option) => option instanceof HTMLElement && option.tabIndex === -1),
          ),
      ).toBe(true)
      for (let index = 0; index < 100; index++) await search.press("ArrowDown")
      await activeResultVisible(search)
      await search.press("ArrowUp")
      await activeResultVisible(search)
      await search.fill("121")
      await expect(results.getByRole("option")).toHaveCount(1)
      await activeResultVisible(search)
      await search.fill("no-synthetic-matches")
      await expect(results.getByRole("option")).toHaveCount(0)
      await expect(search).not.toHaveAttribute("aria-activedescendant")
      await expect(page.getByText("No matches.", { exact: true })).toBeVisible()
      await search.press("ArrowDown")
      await search.press("ArrowUp")
      await search.press("Enter")
      await expect(search).toBeFocused()
      await search.fill("")
      await activeResultVisible(search)
      await search.press("Escape")
      await expect(results).toHaveCount(0)
      await expect(trigger).toBeFocused()

      for (const key of ["Tab", "Shift+Tab"]) {
        // Compare with the closed trigger's native sequential destination, not a popup option.
        await trigger.focus()
        await trigger.press(key)
        const destination = await page.evaluateHandle(() => document.activeElement)
        await expect(page.locator(":focus")).toBeVisible()
        await trigger.click()
        await expect(search).toBeFocused()
        await search.press(key)
        await expect(results).toHaveCount(0)
        await expect
          .poll(() => page.evaluate((element) => document.activeElement === element, destination))
          .toBe(true)
        await expect(page.locator(":focus")).toBeVisible()
        await destination.dispose()
      }

      await trigger.click()
      await search.fill("121")
      await search.press("Enter")
      await expect(trigger).toBeFocused()
      await expect(trigger).toHaveAccessibleName(`${label}: ${label} 121`)
      await trigger.click()
      await search.fill("120")
      const option = results.getByRole("option")
      await option.dispatchEvent("mousedown", { button: 0 })
      await expect(search).toBeFocused()
      await option.click()
      await expect(trigger).toBeFocused()
      await expect(trigger).toHaveAccessibleName(`${label}: ${label} 120`)
      expect(state.writes).toEqual([])
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      )
    })

    test(`${label} picker closes without focusing a hidden trigger on section changes at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 })
      const state = await remediationFixture(page)
      await navigate(page, "Model providers")
      const trigger = page.getByRole("button", {
        name: new RegExp(`^${label}: `),
        includeHidden: true,
      })
      const search = page.getByRole("combobox", {
        name: `Search ${label.toLowerCase()}`,
        exact: true,
      })
      await trigger.click()
      await expect(search).toBeFocused()
      await page.evaluate(() => {
        const target = document.querySelector<HTMLAnchorElement>(
          '.sidebar a[href*="section=Access"]',
        )
        if (!target) throw new Error("Missing Chat access link")
        target.click()
      })
      await expect(page.getByRole("heading", { name: "Chat access", exact: true })).toBeVisible()
      await expect(search).toHaveCount(0)
      await expect(trigger).toBeHidden()
      await expect
        .poll(() =>
          page.evaluate(() => {
            const active = document.activeElement
            return active instanceof HTMLElement && active.checkVisibility()
          }),
        )
        .toBe(true)
      await expect(trigger).not.toBeFocused()
      await page.goBack()
      await expect(trigger).toBeVisible()
      await expect(search).toHaveCount(0)
      await trigger.click()
      await search.press("Escape")
      await expect(trigger).toBeFocused()
      expect(state.writes).toEqual([])
    })
  }

  test(`Audit names match all visible labels and preserve exact UTC filters at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    const state = await remediationFixture(page)
    await navigate(page, "Audit")
    await openDisclosure(page, "Filters")
    for (const [id, label] of [
      ["actor", "Actor (exact)"],
      ["operation", "Operation type"],
      ["outcome", "Result"],
      ["from", "From date (UTC)"],
      ["to", "Through date (UTC)"],
    ] as const) {
      await expect(page.locator(`label[for="audit-${id}"]`)).toBeVisible()
      await expect(page.locator(`label[for="audit-${id}"]`)).toContainText(label)
      const control = page.getByLabel(label, { exact: true })
      await expect(control).toHaveAttribute("id", `audit-${id}`)
      await expect(control).toHaveAccessibleName(label)
    }
    for (const label of ["Operation type", "Result"]) {
      const control = page.getByRole("combobox", { name: label, exact: true })
      const box = await control.boundingBox()
      const fieldWidth = await control.evaluate(
        (element) => element.closest(".form-field")?.getBoundingClientRect().width,
      )
      if (!box || !fieldWidth) throw new Error("Missing Audit field geometry")
      expect(Math.abs(box.width - fieldWidth)).toBeLessThan(1)
      expect(box.height).toBeGreaterThanOrEqual(44)
    }
    await page.getByLabel("Actor (exact)", { exact: true }).fill("  system  ")
    for (const [key, label, value] of [
      ["operation", "Operation type", "historical.operation"],
      ["outcome", "Result", "historical.result"],
    ] as const) {
      const control = page.getByRole("combobox", { name: label, exact: true })
      await control.click()
      await page.getByRole("option", { name: "Other exact value", exact: true }).click()
      const custom = page.getByRole("textbox", {
        name: `Audit ${key} exact value`,
        exact: true,
      })
      await expect(custom).toHaveAccessibleName(`Audit ${key} exact value`)
      await expect(control).toHaveAccessibleName(label)
      await custom.fill(`  ${value}  `)
    }
    await page.getByLabel("From date (UTC)", { exact: true }).fill("2026-10-20")
    await page.getByLabel("Through date (UTC)", { exact: true }).fill("2026-10-21")
    await page.getByRole("button", { name: "Apply audit filters", exact: true }).click()
    await expect.poll(() => state.queries.at(-1)?.get("actor")).toBe("system")
    const query = state.queries.at(-1)
    expect(query?.get("operation")).toBe("historical.operation")
    expect(query?.get("outcome")).toBe("historical.result")
    expect(query?.get("from")).toBe(String(Date.UTC(2026, 9, 20)))
    expect(query?.get("to")).toBe(String(Date.UTC(2026, 9, 22) - 1))
    await expect(page.locator(".audit-active-filters")).toContainText("historical.operation")
    await page.getByRole("button", { name: "Clear audit filters", exact: true }).click()
    await expect.poll(() => state.queries.at(-1)?.toString()).toBe("offset=0")
    await expect(page.getByRole("textbox", { name: /exact value$/ })).toHaveCount(0)
    expect(state.writes).toEqual([])
  })
}
