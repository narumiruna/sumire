import { expect, test } from "@playwright/test"
import { navigate } from "./admin-fixture.js"
import { clarityFixture } from "./clarity-fixture.js"

for (const scenario of [
  "pending",
  "failed",
  "unknown inventory",
  "local only",
  "no default",
] as const) {
  test(`saved model setup remains scoped with ${scenario}`, async ({ page }) => {
    const state = await clarityFixture(page)
    if (scenario === "pending") state.application.lag = 1
    if (scenario === "failed") state.application.status = "failed"
    if (scenario === "unknown inventory") state.inventory.providers = []
    if (scenario === "no default") state.policy().defaults.model = null
    await page.reload()
    const bar = page.locator("#save-status")
    if (scenario === "pending") await expect(bar).toContainText("waiting to apply")
    else if (scenario === "failed") await expect(bar).toContainText("application failed")
    else await expect(bar).toContainText("Settings saved and applied.")
    await navigate(page, "Defaults")
    const setup = page.getByRole("region", { name: "Shared default model setup", exact: true })
    await expect(setup).toContainText(
      scenario === "unknown inventory"
        ? "Status unknown"
        : scenario === "no default"
          ? "No effective model configured."
          : "Model response not checked.",
    )
    await expect(setup).not.toContainText("Ready")
    if (scenario === "no default") {
      await navigate(page, "Chats")
      await page.getByRole("button", { name: "Duplicate name, 43", exact: true }).click()
      await expect(
        page.getByRole("region", { name: "Chat setup status", exact: true }),
      ).toContainText("Model authentication is not configured.")
      expect(state.policy().chats["43"]?.model).toBe("second/model")
    }
    expect(state.writes).toEqual([])
  })
}

test("an unsaved default cannot repair saved setup and missing references stay visible", async ({
  page,
}) => {
  const state = await clarityFixture(page)
  state.policy().defaults.model = "missing/model"
  await page.reload()
  await navigate(page, "Defaults")
  const setup = page.getByRole("region", { name: "Shared default model setup", exact: true })
  const model = page.getByRole("combobox", { name: "Shared default model", exact: true })
  await expect(model).toContainText("missing/model")
  await expect(setup).toContainText("excluded by model availability")
  await model.click()
  await expect(
    page.getByRole("option", { name: "missing/model (unavailable)", exact: true }),
  ).toBeDisabled()
  await page.getByRole("option", { name: "Other", exact: true }).click()
  await expect(setup).toContainText("For the draft selection.")
  await expect(setup).toContainText("Shared defaults are not saved yet.")
  await expect(model).toHaveAttribute("title", "fixture/other")
  expect(state.policy().defaults.model).toBe("missing/model")
  await navigate(page, "Model Providers")
  await expect(
    page.getByText("Shared bot default in current settings", { exact: true }).locator(".."),
  ).toContainText("missing/model")
  expect(state.writes).toEqual([])
})

test("authentication repair targets a chat override and pending provider replacement is explicit", async ({
  page,
}) => {
  const state = await clarityFixture(page)
  state.policy().models = state.policy().models.filter((ref) => ref !== "fixture/other")
  await page.reload()
  await navigate(page, "Model Providers")
  await page.getByRole("button", { name: /^Model: / }).click()
  await page.getByRole("option", { name: /Other/ }).click()
  const repair = async () => {
    await navigate(page, "Chats")
    await page.getByRole("button", { name: "Duplicate name, 43", exact: true }).click()
    await page
      .getByRole("region", { name: "Chat setup status", exact: true })
      .getByRole("button", { name: "Configure authentication", exact: true })
      .click()
  }
  page.once("dialog", (dialog) => dialog.dismiss())
  await repair()
  await expect(page.getByRole("button", { name: /^Model: / })).toContainText("Other")
  await expect(page.locator("#save-status")).toContainText("Provider: Unsaved selection")
  page.once("dialog", (dialog) => dialog.accept())
  await repair()
  await expect(page.getByRole("button", { name: /^Provider: / })).toContainText("Second")
  await expect(page.locator("#provider-authentication")).toBeFocused()
  expect(state.writes).toEqual([])
})

test("clear-default confirmation stages only its fields and closes on history navigation", async ({
  page,
}) => {
  const state = await clarityFixture(page)
  const before = structuredClone(state.policy())
  await navigate(page, "Defaults")
  const clear = page.getByRole("button", { name: "Clear shared default model", exact: true })
  await clear.click()
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  expect(state.policy()).toEqual(before)
  await clear.click()
  await page.goBack()
  await expect(page.getByRole("alertdialog")).toHaveCount(0)
  await navigate(page, "Defaults")
  await clear.click()
  await page.getByRole("button", { name: "Clear default in draft", exact: true }).click()
  expect(state.writes).toEqual([])
  await page.getByRole("button", { name: "Review and save changes", exact: true }).click()
  await page.getByRole("button", { name: "Save changes", exact: true }).click()
  await expect.poll(() => state.policy().defaults.model).toBeNull()
  expect(state.policy()).toEqual({
    ...before,
    defaults: { ...before.defaults, model: null, thinking: null },
  })
})

test("filters compose with search and do not overwrite expansion, capabilities, or duplicate-name permissions", async ({
  page,
}) => {
  const state = await clarityFixture(page)
  await navigate(page, "Tool permissions")
  await page.getByRole("button", { name: "Collapse all", exact: true }).click()
  const filter = page.getByRole("combobox", { name: "Tool status", exact: true })
  await filter.click()
  await page.getByRole("option", { name: "Capability unavailable", exact: true }).click()
  await expect(page.locator(".permission-row:visible")).toHaveCount(1)
  await expect(page.locator(".permission-row:visible")).toContainText("Requires local credentials")
  await page
    .getByRole("checkbox", { name: "Default chat permission for tool builtin_0", exact: true })
    .uncheck()
  const search = page.getByRole("textbox", { name: "Search tools and servers", exact: true })
  await search.fill("unknown")
  await expect(page.getByText("No matching tools or servers.", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Clear tool filters", exact: true }).click()
  await expect(page.locator(".permission-group .permission-row:visible")).toHaveCount(0)
  await page.getByRole("button", { name: "Expand all", exact: true }).click()
  await expect(
    page.getByRole("checkbox", { name: "Default chat permission for tool builtin_0", exact: true }),
  ).not.toBeChecked()
  const duplicate = page.getByRole("checkbox", {
    name: "Default chat permission for tool mcp__example__tool_0",
    exact: true,
  })
  await expect(duplicate).toHaveCount(2)
  await duplicate.first().uncheck()
  await expect(duplicate.last()).not.toBeChecked()
  await expect(
    page.getByRole("region", { name: "Permission editing scope", exact: true }),
  ).toContainText("2 default changes")
  expect(state.writes).toEqual([])
})

test("model review renders catalog text without interpreting markup", async ({ page }) => {
  const state = await clarityFixture(page)
  const provider = state.inventory.providers[0]
  if (!provider) throw new Error("Missing provider fixture")
  const id = "<script>globalThis.fixtureExecuted=true</script>"
  const ref = `fixture/${id}`
  provider.models.push({
    id,
    name: "Markup fixture",
    thinking: ["off"],
    reasoning: false,
    image: false,
  })
  state.policy().models.push(ref)
  await page.reload()
  await navigate(page, "Defaults")
  await page.getByRole("combobox", { name: "Shared default model", exact: true }).click()
  await page.getByRole("option", { name: "Markup fixture", exact: true }).click()
  await page.getByRole("button", { name: "Review and save changes", exact: true }).click()
  const review = page.getByRole("alertdialog")
  await expect(review).toContainText(ref)
  await expect(review.locator("script")).toHaveCount(0)
  expect(await page.evaluate(() => Object.hasOwn(globalThis, "fixtureExecuted"))).toBe(false)
  expect(state.writes).toEqual([])
})

test("a filtered global conflict cannot bypass save validation or erase retained references", async ({
  page,
}) => {
  const state = await clarityFixture(page)
  await navigate(page, "Tool permissions")
  await page.getByRole("button", { name: "Edit global limits", exact: true }).click()
  await page
    .getByRole("checkbox", { name: "Globally allow tool builtin_99", exact: true })
    .uncheck()
  await page.getByRole("combobox", { name: "Tool status", exact: true }).click()
  await page.getByRole("option", { name: "Not in inventory", exact: true }).click()
  await expect(
    page.getByRole("region", { name: "Permission editing scope", exact: true }),
  ).toContainText("1 global change")
  await page.getByRole("button", { name: "Review and save changes", exact: true }).click()
  await expect(page.getByRole("alertdialog")).toContainText(
    "limits shared defaults and all chat selections",
  )
  await page.getByRole("button", { name: "Save changes", exact: true }).click()
  await expect(page.getByRole("alert").first()).toContainText(
    "selection exceeds global availability: builtin_99",
  )
  expect(state.policy().tools).toContain("builtin_99")
  await page.getByRole("button", { name: "Clear tool filters", exact: true }).click()
  const row = page.locator(".permission-row").filter({
    has: page.getByRole("checkbox", { name: "Globally allow tool builtin_99", exact: true }),
  })
  await expect(row).toContainText("Cannot save while this name remains selected")
  await expect(
    row.getByRole("checkbox", { name: "Default chat permission for tool builtin_99", exact: true }),
  ).toBeChecked()
  expect(state.writes).toHaveLength(0)
})
