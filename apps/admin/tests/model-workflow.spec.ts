import { expect, type Page, test } from "@playwright/test"
import type { Policy } from "../src/api.js"
import { basePolicy, inventory, navigate } from "./admin-fixture.js"

async function fixture(
  page: Page,
  options: { oauth?: boolean; configured?: boolean; chat?: boolean } = {},
) {
  const state = {
    policy: structuredClone({
      ...basePolicy,
      skills: [],
      defaults: { ...basePolicy.defaults, skills: null, thinking: "off" },
    }) as Policy,
    inventory: structuredClone(inventory),
    revision: 1,
    applied: 1,
    status: "applied",
    conflict: false,
    failApply: false,
    expired: false,
    login: "pending",
    writes: [] as { path: string; body: Record<string, unknown> }[],
  }
  const provider = state.inventory.providers[0]
  if (!provider) throw new Error("Missing fixture provider")
  provider.configured = options.configured ?? false
  provider.oauth = options.oauth ?? false
  await page.route("**/api/**", async (route) => {
    const req = route.request()
    const path = new URL(req.url()).pathname.slice(5)
    if (state.expired) return route.fulfill({ status: 401, json: { error: "Session expired" } })
    if (req.method() !== "GET") {
      const body = req.postDataJSON()
      state.writes.push({ path, body })
      if (state.conflict)
        return route.fulfill({ status: 409, json: { error: "Revision conflict" } })
      if (path === "settings") {
        state.policy = body.policy
        state.revision++
        state.status = state.failApply ? "failed" : "applied"
        if (!state.failApply) state.applied = state.revision
      } else if (path.endsWith("/credential")) {
        provider.configured = true
        state.applied = ++state.revision
      } else if (path.endsWith("/oauth")) return route.fulfill({ json: { id: "fixture-login" } })
      else if (path === "oauth/fixture-login" && body.cancel) state.login = "cancelled"
      return route.fulfill({ json: {} })
    }
    if (path === "oauth/fixture-login") {
      if (state.login === "completed" && !provider.configured) {
        provider.configured = true
        state.applied = ++state.revision
      }
      return route.fulfill({ json: { status: state.login } })
    }
    const chat = { id: 42, name: "Fixture chat", type: "private" }
    const data: Record<string, unknown> = {
      session: { actor: "42", csrf: "fixture" },
      settings: {
        policy: state.policy,
        revision: state.revision,
        applied: state.applied,
        status: state.status,
      },
      inventory: state.inventory,
      chats: [chat],
      "chats/42": chat,
      audit: [],
      imports: [],
    }
    return route.fulfill({ json: data[path] ?? {} })
  })
  await page.goto(options.chat ? "/?section=Chats&chat=42" : "/?section=Model+Providers")
  return state
}

async function chooseOther(page: Page) {
  await page.getByRole("button", { name: /^Model: / }).click()
  await page.getByRole("option", { name: /Other/ }).click()
}
async function enableModel(page: Page) {
  await page.getByRole("button", { name: "Save model availability", exact: true }).click()
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Save changes", exact: true })
    .click()
  await expect(page.getByRole("button", { name: "Choose model use", exact: true })).toBeEnabled()
}
async function reviewUse(page: Page, target?: string) {
  await page.getByRole("button", { name: "Choose model use", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Choose where to use this model", exact: true })
  if (target) {
    await dialog.getByRole("combobox", { name: "Model use", exact: true }).click()
    await page.getByRole("option", { name: target, exact: true }).click()
  }
  await dialog.getByRole("button", { name: "Review model use", exact: true }).click()
  await expect(
    page.getByRole("alertdialog", { name: "Save settings changes?", exact: true }),
  ).toBeVisible()
}
async function saveReview(page: Page) {
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Save changes", exact: true })
    .click()
  await expect(page.locator("#save-status")).toContainText("Settings saved and applied.")
}

test("API key, model availability, and shared use have separate writes and retain completed steps on cancellation", async ({
  page,
}) => {
  const state = await fixture(page)
  await chooseOther(page)
  await page.getByRole("button", { name: "Configure authentication", exact: true }).click()
  await page.getByLabel("API key", { exact: true }).fill("fixture-secret-not-real")
  await page.getByRole("button", { name: "Save API key", exact: true }).click()
  await expect(page.getByRole("button", { name: "Model: Other", exact: true })).toBeVisible()
  expect(state.writes.map((w) => w.path)).toEqual(["providers/fixture/credential"])
  expect(state.policy.models).toEqual(["fixture/test"])
  await enableModel(page)
  expect(state.policy.defaults.model).toBe("fixture/test")
  expect(state.policy.models).toEqual(["fixture/test", "fixture/other"])
  await page.getByRole("button", { name: "Choose model use", exact: true }).click()
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click()
  expect(state.writes).toHaveLength(2)
  await reviewUse(page)
  await expect(page.getByRole("alertdialog")).not.toContainText("fixture-secret-not-real")
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel", exact: true }).click()
  expect(state.policy.defaults.model).toBe("fixture/test")
  await page.getByRole("button", { name: "Review and save changes", exact: true }).click()
  await saveReview(page)
  expect(state.policy).toEqual({
    ...basePolicy,
    skills: [],
    models: ["fixture/test", "fixture/other"],
    defaults: {
      ...basePolicy.defaults,
      skills: null,
      model: "fixture/other",
      models: ["fixture/test", "fixture/other"],
    },
  })
  expect(state.writes).toHaveLength(3)
  expect(page.url()).not.toContain("fixture-secret-not-real")
})

for (const target of ["Chat 42 override", "Chat 42 inherits shared model"]) {
  test(`originating chat setup preserves all other scopes: ${target}`, async ({ page }) => {
    const state = await fixture(page, { chat: true })
    state.policy.chats["42"] = {
      model: "fixture/test",
      models: ["fixture/test"],
      thinking: "off",
      tools: [],
      servers: null,
      skills: null,
      enabled: true,
    }
    await page.getByRole("button", { name: "Configure authentication", exact: true }).click()
    await expect(page.getByRole("button", { name: "Back to chat 42", exact: true })).toBeVisible()
    if (target.endsWith("override")) {
      await chooseOther(page)
      await enableModel(page)
    } else {
      await page.getByRole("button", { name: "Reload", exact: true }).click()
    }
    const before = structuredClone(state.policy)
    await reviewUse(page, target)
    await saveReview(page)
    expect(state.policy.defaults).toEqual(before.defaults)
    expect(state.policy.models).toEqual(before.models)
    expect(state.policy.chats["42"]).toEqual({
      ...before.chats["42"],
      model: target.endsWith("override") ? "fixture/other" : null,
      thinking: target.endsWith("override") ? "off" : null,
      models: target.endsWith("override") ? ["fixture/test", "fixture/other"] : null,
    })
    await page.getByRole("button", { name: "Back to chat 42", exact: true }).click()
    await expect(page.getByRole("tab", { name: "Model & Tools", exact: true })).toHaveAttribute(
      "data-state",
      "active",
    )
    await page.goBack()
    await expect(page.getByRole("button", { name: /^Model: / })).toBeVisible()
  })
}

test("OAuth completion retains the selected model and supports subsequent use", async ({
  page,
}) => {
  const state = await fixture(page, { oauth: true })
  await chooseOther(page)
  await page.getByRole("button", { name: "Configure authentication", exact: true }).click()
  await page.getByRole("button", { name: "Sign in with account", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Cancel provider login", exact: true }),
  ).toBeVisible()
  state.login = "completed"
  await expect(page.getByRole("dialog", { name: "Connect Fixture", exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Model: Other", exact: true })).toBeVisible()
  await enableModel(page)
  await reviewUse(page)
  await saveReview(page)
  expect(state.writes.map((w) => w.path)).toEqual([
    "providers/fixture/oauth",
    "settings",
    "settings",
  ])
})

test("conflicts retain model-use drafts, failed application remains distinct from persistence, and expiry clears setup", async ({
  page,
}) => {
  const state = await fixture(page, { configured: true })
  await chooseOther(page)
  await enableModel(page)
  await reviewUse(page)
  state.conflict = true
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Save changes", exact: true })
    .click()
  await expect(page.getByRole("alert")).toContainText("Revision conflict")
  await expect(
    page.getByRole("button", { name: "Review and save changes", exact: true }),
  ).toBeVisible()
  state.conflict = false
  state.failApply = true
  await page.getByRole("button", { name: "Review and save changes", exact: true }).click()
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Save changes", exact: true })
    .click()
  await expect(page.locator("#save-status")).toContainText("Saved, but application failed")
  expect(state.policy.defaults.model).toBe("fixture/other")
  state.expired = true
  await page.getByRole("button", { name: "Reload", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Sign in with passkey", exact: true }),
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "Choose model use", exact: true })).toHaveCount(0)
})

test("OAuth cancellation and browser history retain the model preview without extra writes", async ({
  page,
}) => {
  const state = await fixture(page, { oauth: true })
  await chooseOther(page)
  await navigate(page, "Defaults")
  await page.goBack()
  await expect(page.getByRole("button", { name: "Model: Other", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Configure authentication", exact: true }).click()
  await page.getByRole("button", { name: "Sign in with account", exact: true }).click()
  await page.getByRole("button", { name: "Cancel provider login", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Connect Fixture", exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Model: Other", exact: true })).toBeVisible()
  expect(state.writes.map((entry) => entry.path)).toEqual([
    "providers/fixture/oauth",
    "oauth/fixture-login",
  ])
  expect(state.inventory.providers[0]?.configured).toBe(false)
})

test("chat authentication repair carries its model rather than the shared default", async ({
  page,
}) => {
  const state = await fixture(page, { chat: true })
  state.policy.models.push("fixture/other")
  state.policy.chats["42"] = {
    model: "fixture/other",
    models: ["fixture/other"],
    thinking: "off",
    tools: null,
    servers: null,
    skills: null,
    enabled: true,
  }
  await page.getByRole("button", { name: "Reload", exact: true }).click()
  await page.getByRole("button", { name: "Configure authentication", exact: true }).click()
  await expect(page.getByRole("button", { name: "Model: Other", exact: true })).toBeVisible()
  expect(state.writes).toEqual([])
})

test("missing catalog and unsupported thinking prevent model-use staging", async ({ page }) => {
  const state = await fixture(page)
  const model = state.inventory.providers[0]?.models[0]
  if (!model) throw new Error("Missing fixture model")
  model.thinking = []
  await page.getByRole("button", { name: "Reload", exact: true }).click()
  await expect(page.getByRole("button", { name: "Choose model use", exact: true })).toBeDisabled()
  state.inventory.providers[0]?.models.splice(0)
  await page.getByRole("button", { name: "Reload", exact: true }).click()
  await expect(page.getByRole("button", { name: "Choose model use", exact: true })).toBeDisabled()
  await expect(
    page.getByText(
      "The selected model is no longer in the catalog. Choose another model before saving.",
      { exact: true },
    ),
  ).toBeVisible()
  state.inventory.providers = []
  await page.getByRole("button", { name: "Reload", exact: true }).click()
  await expect(page.getByRole("button", { name: "Choose model use", exact: true })).toBeDisabled()
  expect(state.writes).toEqual([])
})

test("final use preserves unrelated policy drafts and does not save them before review", async ({
  page,
}) => {
  const state = await fixture(page, { configured: true })
  await chooseOther(page)
  await enableModel(page)
  await navigate(page, "Tool permissions")
  await page
    .getByRole("checkbox", {
      name: "Default chat permission for tool read_url_content",
      exact: true,
    })
    .uncheck()
  await navigate(page, "Model providers")
  await reviewUse(page)
  expect(state.policy.defaults.tools).toEqual(["read_url_content"])
  await saveReview(page)
  expect(state.policy.defaults.tools).toEqual([])
  expect(state.policy.defaults.model).toBe("fixture/other")
  expect(state.writes).toHaveLength(2)
})
