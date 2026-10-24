import { expect, test } from "@playwright/test"
import { navigate } from "./admin-fixture.js"
import { clarityFixture } from "./clarity-fixture.js"

test("baseline: existing source groups retain metadata and explicit empty overrides", async ({
  page,
}) => {
  const state = await clarityFixture(page)
  await navigate(page, "Tool permissions")
  await page.getByRole("button", { name: "Expand all", exact: true }).click()
  await expect(page.getByRole("region", { name: "MCP: example", exact: true })).toBeVisible()
  await expect(page.getByRole("region", { name: "MCP: second", exact: true })).toBeVisible()
  await expect(page.locator(".permission-row:visible")).toHaveCount(205)
  expect(state.policy().chats["44"]?.tools).toEqual([])
  expect(state.writes).toEqual([])
})

test("settings application and scoped model setup are separate", async ({ page }) => {
  const state = await clarityFixture(page)
  state.inventory.providers.forEach((provider) => {
    if (provider.id === "fixture") provider.configured = false
  })
  await page.reload()
  await expect(page.locator("#save-status")).toContainText("Settings saved and applied.")
  await navigate(page, "Defaults")
  const setup = page.getByRole("region", { name: "Shared default model setup", exact: true })
  await expect(setup).toContainText("Authentication required")
  await setup.getByRole("button", { name: "Configure provider", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Model providers", exact: true })).toBeVisible()
  await expect(page.locator("#provider-auth-action")).toBeVisible()
  expect(state.writes).toEqual([])
})

test("status filters retain hidden tool edits", async ({ page }) => {
  const state = await clarityFixture(page)
  await navigate(page, "Tool permissions")
  await page
    .getByRole("checkbox", { name: "Default chat permission for tool builtin_1", exact: true })
    .uncheck()
  const filter = page.getByRole("combobox", { name: "Tool status", exact: true })
  await filter.click()
  await page.getByRole("option", { name: "Not in inventory", exact: true }).click()
  await expect(page.locator(".permission-row:visible")).toHaveCount(1)
  await expect(page.locator(".permission-row:visible")).toContainText("stored_missing")
  await expect(
    page.getByRole("region", { name: "Permission editing scope", exact: true }),
  ).toContainText("1 default change")
  await filter.click()
  await page.getByRole("option", { name: "All", exact: true }).click()
  await expect(
    page.getByRole("checkbox", { name: "Default chat permission for tool builtin_1", exact: true }),
  ).not.toBeChecked()
  expect(state.writes).toEqual([])
})

test("shared model stages an exact allowed-model addition without leaving Defaults", async ({
  page,
}) => {
  const state = await clarityFixture(page)
  const before = structuredClone(state.policy())
  await navigate(page, "Defaults")
  await page.getByRole("combobox", { name: "Shared default model", exact: true }).click()
  await page.getByRole("option", { name: "Other", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Shared defaults", exact: true })).toBeVisible()
  expect(state.writes).toEqual([])
  await page.getByRole("button", { name: "Review and save changes", exact: true }).click()
  await expect(page.getByRole("alertdialog")).toContainText("fixture/other")
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Save changes", exact: true })
    .click()
  await expect.poll(() => state.policy().defaults.model).toBe("fixture/other")
  expect(state.policy().defaults.models).toEqual(["fixture/test", "fixture/other"])
  expect(state.policy().models).toEqual(["fixture/test", "fixture/other", "second/model"])
  expect(state.policy().chats["43"]?.model).toBe("second/model")
  expect(state.writes).toEqual([
    {
      path: "/api/settings",
      body: {
        revision: 1,
        policy: {
          ...before,
          defaults: {
            ...before.defaults,
            model: "fixture/other",
            models: ["fixture/test", "fixture/other"],
          },
        },
      },
    },
  ])
})

test("directory groups authentication issues for the displayed page only", async ({ page }) => {
  const state = await clarityFixture(page)
  state.inventory.providers.forEach((provider) => {
    if (provider.id === "fixture") provider.configured = false
  })
  await page.reload()
  const summary = page.getByRole("region", {
    name: "Authentication on this directory page",
    exact: true,
  })
  await expect(summary).toContainText("fixture")
  await expect(summary).toContainText("99 chats")
  await expect(summary).toContainText("second")
  await expect(summary).toContainText("1 chat")
  await expect(page.locator(".directory-status-reason")).toHaveCount(0)
  expect(state.writes).toEqual([])
})
