import { inherited, initialPolicy, policySchema, validateReferences } from "@narumitw/sumire-policy"
import { expect, type Page, test } from "@playwright/test"
import type { Inventory, Policy } from "../src/api.js"
import { navigate, openChatConfiguration } from "./admin-fixture.js"

async function setup(page: Page) {
  let saved = initialPolicy()
  saved.skills = ["load-public-url", "expenses", "missing"]
  saved.defaults.skills = ["load-public-url", "missing"]
  saved.privateUsers = [42, 43]
  saved.chats["43"] = { ...inherited, enabled: false, skills: ["missing"] }
  const inventory: Inventory = {
    tools: [],
    providers: [],
    mcp: [],
    skills: [
      { name: "load-public-url", description: "Load a public page with URL tools." },
      { name: "expenses", description: "Manage expenses safely." },
      { name: "new-skill", description: "An unavailable default choice." },
    ],
  }
  let revision = 1
  const writes: string[] = []
  await page.route("**/api/**", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() !== "GET") writes.push(url.pathname)
    if (url.pathname === "/api/session")
      return route.fulfill({ json: { actor: "42", csrf: "fixture" } })
    if (url.pathname === "/api/settings") {
      if (request.method() === "PUT") {
        const policy: Policy = policySchema.parse(request.postDataJSON().policy)
        try {
          validateReferences(policy)
        } catch (error) {
          return route.fulfill({ status: 400, json: { error: String(error) } })
        }
        saved = policy
        revision++
      }
      return route.fulfill({
        json: { policy: saved, revision, applied: revision, status: "applied" },
      })
    }
    if (url.pathname === "/api/inventory") return route.fulfill({ json: inventory })
    if (url.pathname === "/api/chats") {
      const chats = [
        { id: 42, name: "Inherited chat", type: "private" },
        { id: 43, name: "Disabled explicit chat", type: "private" },
      ]
      return route.fulfill({
        json: url.searchParams.has("id")
          ? chats.filter((chat) => String(chat.id) === url.searchParams.get("id"))
          : chats,
      })
    }
    return route.fulfill({ json: [] })
  })
  await page.goto("/?section=Skills")
  await expect(page.getByRole("heading", { name: "Skills", exact: true })).toBeVisible()
  return { saved: () => saved, writes }
}

async function save(page: Page) {
  await page.getByRole("button", { name: "Review and save changes", exact: true }).click()
  await page.getByRole("button", { name: "Save changes", exact: true }).click()
}

for (const width of [1440, 390]) {
  test(`skills retain drafts and save independently of tools at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const state = await setup(page)
    const defaults = page.getByRole("checkbox", {
      name: "Default chat selection for skill expenses",
      exact: true,
    })
    await expect(
      page
        .getByRole("region", { name: "Skill load-public-url", exact: true })
        .getByText("Load a public page with URL tools.", { exact: true })
        .first(),
    ).toBeVisible()
    await expect(
      page.getByRole("checkbox", {
        name: "Default chat selection for skill new-skill",
        exact: true,
      }),
    ).toBeDisabled()
    await defaults.focus()
    await page.keyboard.press("Space")
    await expect(defaults).toBeChecked()
    await page.getByRole("textbox", { name: "Search skills" }).fill("expenses")
    await expect(
      page.getByRole("region", { name: "Skill load-public-url", exact: true }),
    ).toHaveCount(0)
    await navigate(page, "Defaults")
    await expect(page.getByRole("list", { name: "Default skill summary" })).toContainText(
      "expenses",
    )
    await page.getByRole("link", { name: "Manage default skills", exact: true }).click()
    await expect(page.getByRole("textbox", { name: "Search skills" })).toHaveValue("expenses")
    await expect(defaults).toBeChecked()
    expect(state.writes).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await save(page)
    await expect(page.getByText("Settings saved and applied.", { exact: true })).toBeVisible()
    expect(state.saved().defaults.skills).toEqual(["load-public-url", "missing", "expenses"])
    expect(state.saved().tools).toEqual([])
    expect(state.saved().chats["43"]?.skills).toEqual(["missing"])
  })
}

test("chat skills distinguish inheritance, explicit empty, and reset", async ({ page }) => {
  const state = await setup(page)
  await page.goto("/?section=Chats&chat=42")
  await openChatConfiguration(page)
  const skills = page.getByRole("group", { name: "Enabled skills", exact: true })
  await expect(
    skills.getByText("Effective: load-public-url, missing", { exact: true }),
  ).toBeVisible()
  await skills.getByRole("checkbox", { name: "Inherit default", exact: true }).uncheck()
  await expect(
    skills.getByText("No options allowed. This does not inherit shared defaults.", { exact: true }),
  ).toBeVisible()
  await save(page)
  expect(state.saved().chats["42"]?.skills).toEqual([])
  await skills.getByRole("checkbox", { name: "expenses", exact: true }).check()
  await save(page)
  expect(state.saved().chats["42"]?.skills).toEqual(["expenses"])
  await skills.getByRole("button", { name: "Reset enabled skills to default", exact: true }).click()
  await save(page)
  expect(state.saved().chats["42"]?.skills).toBeNull()
})

for (const width of [1440, 390]) {
  test(`global removal retains missing default and disabled chat selections for explicit review at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    const state = await setup(page)
    const missing = page.getByRole("region", { name: "Skill missing", exact: true })
    await expect(missing.getByText("Not loaded", { exact: true })).toBeVisible()
    await missing
      .getByRole("checkbox", { name: "Globally enable skill missing", exact: true })
      .uncheck()
    await expect(
      missing.getByText(
        "Clear retained default and chat selections, or restore global availability before saving.",
        { exact: true },
      ),
    ).toBeVisible()
    await expect(
      missing.getByRole("checkbox", {
        name: "Default chat selection for skill missing",
        exact: true,
      }),
    ).toBeChecked()
    await save(page)
    await expect(
      page.getByRole("alert").filter({ hasText: "selection exceeds global availability" }),
    ).toBeVisible()
    expect(state.saved().skills).toContain("missing")
    await missing
      .getByRole("checkbox", { name: "Default chat selection for skill missing", exact: true })
      .uncheck()
    await missing.getByRole("button", { name: "Chat 43", exact: true }).click()
    await expect(page.getByRole("region", { name: "Chat details", exact: true })).toBeVisible()
    await openChatConfiguration(page)
    const chatSkills = page.getByRole("group", { name: "Enabled skills", exact: true })
    await chatSkills
      .getByRole("checkbox", { name: "missing (no longer available)", exact: true })
      .click()
    await expect(
      chatSkills.getByText("No options allowed. This does not inherit shared defaults.", {
        exact: true,
      }),
    ).toBeVisible()
    await save(page)
    expect(state.saved().skills).not.toContain("missing")
    expect(state.saved().defaults.skills).not.toContain("missing")
    expect(state.saved().chats["43"]?.skills).toEqual([])
    expect(state.saved().chats["43"]?.enabled).toBe(false)
  })
}
