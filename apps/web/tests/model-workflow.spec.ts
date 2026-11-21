import { inherited, validateReferences } from "@narumitw/sumire-policy"
import { expect, type Page, test } from "@playwright/test"
import type { Policy } from "../src/api.js"
import { basePolicy, inventory, navigate, reviewPolicyRecovery } from "./admin-fixture.js"

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
    failCredential: false,
    expired: false,
    login: "pending",
    writes: [] as { path: string; body: Record<string, unknown> }[],
  }
  const snapshot = () => ({
    policy: state.policy,
    revision: state.revision,
    applied: state.applied,
    status: state.status,
    epoch: state.revision,
  })
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
        try {
          validateReferences(body.policy)
        } catch (error) {
          return route.fulfill({ status: 400, json: { error: (error as Error).message } })
        }
        state.policy = body.policy
        state.revision++
        state.status = state.failApply ? "failed" : "applied"
        if (!state.failApply) state.applied = state.revision
        return route.fulfill({ json: snapshot() })
      }
      if (path.endsWith("/credential")) {
        if (state.failCredential)
          return route.fulfill({ status: 400, json: { error: "Credential was not saved" } })
        provider.configured = true
        state.applied = ++state.revision
      } else if (path.endsWith("/oauth")) return route.fulfill({ json: { id: "fixture-login" } })
      else if (path === "oauth/fixture-login" && body.cancel) state.login = "cancelled"
      else if (path.endsWith("/test"))
        return route.fulfill({ json: { configured: provider.configured } })
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
      settings: snapshot(),
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

// Provider list/detail entry is explicit. Viewing or choosing a provider performs no write.
async function enterProviderDetail(page: Page, provider = "fixture") {
  await page.getByRole("button", { name: `Manage provider ${provider}`, exact: true }).click()
  await expect(page.getByRole("heading", { name: "Connection", exact: true })).toBeVisible()
}
async function openAuthentication(page: Page) {
  const summary = page.locator("#provider-authentication")
  if (!(await summary.locator("..").evaluate((element) => (element as HTMLDetailsElement).open)))
    await summary.click()
}
async function chooseOther(page: Page) {
  await page.getByRole("button", { name: /^Model: / }).click()
  await page.getByRole("option", { name: /Other/ }).click()
  await expect(page.getByRole("button", { name: "Model: Other", exact: true })).toBeVisible()
  await expect(page.getByRole("listbox", { name: "Model results", exact: true })).toHaveCount(0)
}
async function enableModel(page: Page) {
  await page.getByRole("button", { name: "Save model availability", exact: true }).click()
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Save changes", exact: true })
    .click()
  await expect(
    page.getByRole("button", { name: "Save model availability", exact: true }),
  ).toBeDisabled()
}
async function stageSharedModel(page: Page) {
  await page.getByRole("button", { name: "Edit shared default", exact: true }).click()
  await page.getByRole("combobox", { name: "Shared default model", exact: true }).click()
  await page.getByRole("option", { name: "Other", exact: true }).click()
}
async function review(page: Page) {
  await page.getByRole("button", { name: "Review and save changes", exact: true }).click()
  return page.getByRole("alertdialog", { name: "Save settings changes?", exact: true })
}
async function saveReview(page: Page) {
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Save changes", exact: true })
    .click()
  await expect(page.locator("#save-status")).toContainText("Settings saved and applied.")
}

test("provider list shows configured/referenced entries and Add opens supported setup without writes", async ({
  page,
}) => {
  const state = await fixture(page)
  state.inventory.providers.push({
    id: "catalog",
    name: "Catalog only",
    configured: false,
    apiKey: true,
    oauth: false,
    models: [],
  })
  await page.getByRole("button", { name: "Refresh settings", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Manage provider fixture", exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Manage provider catalog", exact: true }),
  ).toHaveCount(0)
  await expect(page.getByRole("button", { name: /^Model: / })).toHaveCount(0)
  await expect(page.getByRole("list", { name: "Model setup steps" })).toHaveCount(0)
  const before = structuredClone(state.policy)
  await page.getByRole("button", { name: "Add provider", exact: true }).click()
  await page.getByRole("textbox", { name: "Search providers", exact: true }).fill("Catalog")
  await page.getByRole("button", { name: "Set up provider catalog", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Connection", exact: true })).toBeVisible()
  await expect(page.getByText("Missing credential", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Choose model use", exact: true })).toHaveCount(0)
  expect(state.policy).toEqual(before)
  expect(state.writes).toEqual([])
})

test("endpoint draft survives list/detail navigation and provider switching requires explicit discard", async ({
  page,
}) => {
  const state = await fixture(page)
  state.inventory.providers.push({
    id: "catalog",
    name: "Catalog only",
    configured: false,
    apiKey: true,
    oauth: false,
    models: [],
  })
  await page.getByRole("button", { name: "Refresh settings", exact: true }).click()
  await enterProviderDetail(page)
  await page
    .locator("summary")
    .filter({ hasText: /^Custom endpoint$/ })
    .click()
  await page.getByLabel("Provider ID", { exact: true }).fill("draft-endpoint")
  await page.getByRole("button", { name: "Back to providers", exact: true }).click()
  await page
    .getByRole("button", {
      name: "Continue editing: Providers & models — Custom endpoint",
      exact: true,
    })
    .click()
  await expect(page.getByLabel("Provider ID", { exact: true })).toBeFocused()
  await expect(page.getByLabel("Provider ID", { exact: true })).toHaveValue("draft-endpoint")
  await page.getByRole("button", { name: "Back to providers", exact: true }).click()
  await page.getByRole("button", { name: "Add provider", exact: true }).click()
  page.once("dialog", (dialog) => dialog.dismiss())
  await page.getByRole("button", { name: "Set up provider catalog", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Add provider", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Back to providers", exact: true }).click()
  await enterProviderDetail(page)
  await expect(page.getByLabel("Provider ID", { exact: true })).toHaveValue("draft-endpoint")
  await page.getByRole("button", { name: "Back to providers", exact: true }).click()
  await page.getByRole("button", { name: "Add provider", exact: true }).click()
  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "Set up provider catalog", exact: true }).click()
  await expect(page.getByLabel("Provider ID", { exact: true })).toHaveValue("")
  expect(state.writes).toEqual([])
})

test("model removal review covers disabled/off-page entries, inherited result and restore limits", async ({
  page,
}) => {
  const state = await fixture(page, { configured: true })
  state.policy.models.push("fixture/other")
  state.policy.defaults.models?.push("fixture/other")
  state.policy.chats = {
    "999999": {
      ...inherited,
      enabled: false,
      tools: [],
      models: ["fixture/test", "fixture/other"],
      model: "fixture/test",
      thinking: "high",
    },
    "43": { ...inherited, enabled: true },
    "44": { ...inherited, enabled: true, models: [] },
  }
  const before = structuredClone(state.policy)
  await page.getByRole("button", { name: "Refresh settings", exact: true }).click()
  await enterProviderDetail(page)
  const model = page.getByRole("checkbox", { name: "fixture/test", exact: true })
  await model.uncheck()
  expect(state.writes).toEqual([])
  expect(state.policy).toEqual(before)
  const dialog = await review(page)
  const impact = dialog.getByRole("region", { name: "Model removal impact", exact: true })
  await expect(impact).toContainText("Chat 999999 (disabled)")
  await expect(impact).toContainText("Chat 43")
  await expect(impact).toContainText("Not configured")
  await expect(impact).toContainText("Restoring availability does not restore")
  await expect(impact).toContainText("GitHub replies use the shared model")
  await expect(impact).toContainText("pending outbox effects are unknown")
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
  await model.check()
  const restoredReview = await review(page)
  await expect(
    restoredReview.getByRole("region", { name: "Model removal impact", exact: true }),
  ).toContainText("Restoring availability does not restore")
  await restoredReview.getByRole("button", { name: "Cancel", exact: true }).click()
  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "Discard settings changes", exact: true }).click()
  await expect(model).toBeChecked()
  expect(state.policy).toEqual(before)
  await model.uncheck()
  await review(page)
  await saveReview(page)
  expect(state.policy).toEqual({
    ...before,
    models: ["fixture/other"],
    defaults: { ...before.defaults, models: ["fixture/other"], model: null, thinking: null },
    chats: {
      ...before.chats,
      "999999": {
        ...before.chats["999999"],
        models: ["fixture/other"],
        model: null,
        thinking: null,
      },
    },
  })
  expect(state.writes.map((write) => write.path)).toEqual(["settings"])
})

test("authentication check reports local credential availability without granting models or remote verification", async ({
  page,
}) => {
  const state = await fixture(page, { configured: true })
  await enterProviderDetail(page)
  await openAuthentication(page)
  const before = structuredClone(state.policy)
  await page.getByRole("button", { name: "Check authentication", exact: true }).click()
  await expect(
    page.getByText(
      "Credentials are configured locally. Remote acceptance was not checked; no model output was generated.",
      { exact: true },
    ),
  ).toBeVisible()
  expect(state.policy).toEqual(before)
  expect(state.writes.map((entry) => entry.path)).toEqual(["providers/fixture/test"])
})

test("credentials, one-model availability and inline shared default have separate writes", async ({
  page,
}) => {
  const state = await fixture(page)
  await enterProviderDetail(page)
  await chooseOther(page)
  await page.getByRole("button", { name: "Configure authentication", exact: true }).click()
  await page.getByLabel("API key", { exact: true }).fill("fixture-secret-not-real")
  await page.getByRole("button", { name: "Save API key", exact: true }).click()
  await expect(page.getByRole("button", { name: "Model: Other", exact: true })).toBeVisible()
  expect(state.writes.map((write) => write.path)).toEqual(["providers/fixture/credential"])
  expect(state.policy.models).toEqual(["fixture/test"])
  await enableModel(page)
  expect(state.policy.defaults.model).toBe("fixture/test")
  expect(state.policy.chats).toEqual({})
  expect(state.policy.models).toEqual(["fixture/test", "fixture/other"])
  await stageSharedModel(page)
  const dialog = await review(page)
  await expect(dialog).toContainText("fixture/other")
  await expect(dialog).not.toContainText("fixture-secret-not-real")
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
  expect(state.policy.defaults.model).toBe("fixture/test")
  expect(state.writes).toHaveLength(2)
  await review(page)
  await saveReview(page)
  expect(state.policy.defaults.model).toBe("fixture/other")
  expect(state.policy.defaults.models).toEqual(["fixture/test", "fixture/other"])
  expect(state.writes.map((write) => write.path)).toEqual([
    "providers/fixture/credential",
    "settings",
    "settings",
  ])
  expect(page.url()).not.toContain("fixture-secret-not-real")
})

test("provider repair returns to chat editor and never duplicates model-use editing", async ({
  page,
}) => {
  const state = await fixture(page, { chat: true })
  state.policy.chats["42"] = {
    ...inherited,
    enabled: true,
    model: "fixture/test",
    models: ["fixture/test"],
    thinking: "off",
    tools: [],
  }
  await page.getByRole("button", { name: "Refresh settings", exact: true }).click()
  await page.getByRole("button", { name: "Configure authentication", exact: true }).click()
  await expect(page.getByRole("button", { name: "Back to chat 42", exact: true })).toBeVisible()
  await chooseOther(page)
  await enableModel(page)
  const explicit = structuredClone(state.policy.chats)
  await stageSharedModel(page)
  await review(page)
  await saveReview(page)
  expect(state.policy.chats).toEqual(explicit)
  expect(state.policy.defaults.model).toBe("fixture/other")
  await page.goBack()
  await page.getByRole("button", { name: "Back to chat 42", exact: true }).click()
  await expect(page.getByRole("tab", { name: "Model & Tools", exact: true })).toHaveAttribute(
    "data-state",
    "active",
  )
  expect(state.policy.chats).toEqual(explicit)
})

test("OAuth completion retains model preview; availability still does not choose model use", async ({
  page,
}) => {
  const state = await fixture(page, { oauth: true })
  await enterProviderDetail(page)
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
  expect(state.policy.defaults.model).toBe("fixture/test")
  expect(state.writes.map((write) => write.path)).toEqual(["providers/fixture/oauth", "settings"])
})

test("conflicts retain inline model drafts and failed application is not failed persistence", async ({
  page,
}) => {
  const state = await fixture(page, { configured: true })
  await enterProviderDetail(page)
  await chooseOther(page)
  await enableModel(page)
  await stageSharedModel(page)
  await review(page)
  state.conflict = true
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Save changes", exact: true })
    .click()
  await expect(page.getByRole("alert")).toContainText("Revision conflict")
  await expect(
    page.getByRole("button", { name: "Review and save changes", exact: true }),
  ).toBeVisible()
  expect(state.policy.defaults.model).toBe("fixture/test")
  state.conflict = false
  state.failApply = true
  await reviewPolicyRecovery(page)
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Save changes", exact: true })
    .click()
  await expect(page.locator("#save-status")).toContainText("Saved, but application failed")
  expect(state.policy.defaults.model).toBe("fixture/other")
})

test("credential failure retains input for retry; cancellation and expiry clear sensitive inputs", async ({
  page,
}) => {
  const state = await fixture(page)
  await enterProviderDetail(page)
  await chooseOther(page)
  await page.getByRole("button", { name: "Configure authentication", exact: true }).click()
  const key = page.getByLabel("API key", { exact: true })
  await key.fill("fixture-secret-not-real")
  state.failCredential = true
  await page.getByRole("button", { name: "Save API key", exact: true }).click()
  await expect(key).toHaveValue("fixture-secret-not-real")
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click()
  await page.getByRole("button", { name: "Configure authentication", exact: true }).click()
  await expect(key).toHaveValue("")
  await key.fill("fixture-secret-not-real")
  state.expired = true
  await page.getByRole("button", { name: "Save API key", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Sign in with passkey", exact: true }),
  ).toBeVisible()
  await expect(key).toHaveCount(0)
  expect(page.url()).not.toContain("fixture-secret-not-real")
  expect(
    await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
  ).not.toContain("fixture-secret-not-real")
})

test("OAuth cancellation and history retain preview without extra policy writes", async ({
  page,
}) => {
  const state = await fixture(page, { oauth: true })
  await enterProviderDetail(page)
  await chooseOther(page)
  await navigate(page, "Defaults")
  await page.goBack()
  await expect(page.getByRole("button", { name: "Model: Other", exact: true })).toBeVisible()
  await openAuthentication(page)
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
    ...inherited,
    enabled: true,
    model: "fixture/other",
    models: ["fixture/other"],
    thinking: "off",
  }
  await page.getByRole("button", { name: "Refresh settings", exact: true }).click()
  await page.getByRole("button", { name: "Configure authentication", exact: true }).click()
  await expect(page.getByRole("button", { name: "Model: Other", exact: true })).toBeVisible()
  expect(state.writes).toEqual([])
})

test("missing catalog and unsupported thinking prevent model availability saves without erasing references", async ({
  page,
}) => {
  const state = await fixture(page)
  const model = state.inventory.providers[0]?.models[0]
  if (!model) throw new Error("Missing fixture model")
  model.thinking = []
  await page.getByRole("button", { name: "Refresh settings", exact: true }).click()
  await enterProviderDetail(page)
  await expect(
    page.getByRole("button", { name: "Save model availability", exact: true }),
  ).toBeDisabled()
  await expect(
    page.getByText("The selected thinking level is unavailable. Choose a supported level.", {
      exact: true,
    }),
  ).toBeVisible()
  state.inventory.providers[0]?.models.splice(0)
  await page.getByRole("button", { name: "Refresh settings", exact: true }).click()
  await expect(
    page.getByText(
      "The selected model is no longer in the catalog. Choose another model before saving.",
      { exact: true },
    ),
  ).toBeVisible()
  state.inventory.providers = []
  await page.getByRole("button", { name: "Refresh settings", exact: true }).click()
  await expect(
    page.getByRole("heading", { name: "Usage policy references", exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Save model availability", exact: true }),
  ).toHaveCount(0)
  expect(state.policy.defaults.model).toBe("fixture/test")
  expect(state.writes).toEqual([])
})

test("inline shared model review preserves unrelated drafts and explicit chat overrides", async ({
  page,
}) => {
  const state = await fixture(page, { configured: true })
  await enterProviderDetail(page)
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
  await stageSharedModel(page)
  const dialog = await review(page)
  await expect(dialog).toContainText("Shared defaults")
  expect(state.policy.defaults.tools).toEqual(["read_url_content"])
  await saveReview(page)
  expect(state.policy.defaults.tools).toEqual([])
  expect(state.policy.defaults.model).toBe("fixture/other")
  expect(state.writes).toHaveLength(2)
})
