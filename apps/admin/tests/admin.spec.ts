import { expect, type Page, test } from "@playwright/test"

const policy = {
  tools: ["load_public_url"],
  servers: [],
  models: ["fixture/test"],
  defaults: {
    tools: ["load_public_url"],
    servers: [],
    models: ["fixture/test"],
    model: "fixture/test",
    thinking: "off",
  },
  privateUsers: [42],
  groups: [],
  chats: {},
  providers: [],
}
async function setup(page: Page, signedIn = true) {
  let revision = 1
  let saved: unknown = structuredClone(policy)
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url())
    let data: unknown = {}
    if (url.pathname === "/api/session") {
      if (!signedIn) {
        await route.fulfill({ status: 401, json: { error: "Sign in" } })
        return
      }
      data = { csrf: "browser-fixture", actor: "42" }
    } else if (url.pathname === "/api/settings") {
      if (route.request().method() === "PUT") {
        expect(route.request().headers()["x-csrf-token"]).toBe("browser-fixture")
        saved = route.request().postDataJSON().policy
        revision++
      }
      data = { revision, applied: revision, status: "applied", policy: saved }
    } else if (url.pathname === "/api/inventory")
      data = {
        tools: ["load_public_url", "bash"],
        providers: [
          {
            id: "fixture",
            name: "Fixture",
            configured: true,
            apiKey: true,
            oauth: true,
            models: [{ id: "test", name: "Test", thinking: ["off", "low"] }],
          },
        ],
        mcp: [],
      }
    else if (url.pathname === "/api/chats")
      data = [
        {
          id: 42,
          name: "Fixture chat",
          type: "private",
          effective: { enabled: true, tools: ["load_public_url"], sources: { tools: "default" } },
        },
      ]
    else if (url.pathname === "/api/audit") data = []
    await route.fulfill({ json: data })
  })
  await page.goto("/")
}
test("unauthorized visitor sees only Telegram sign-in", async ({ page }) => {
  await setup(page, false)
  await expect(page.getByRole("link", { name: "Sign in with Telegram" })).toHaveAttribute(
    "href",
    "/auth/telegram",
  )
  await expect(page.getByRole("button", { name: "Save settings", exact: true })).toHaveCount(0)
})
test("edits private access and saves with a confirmation", async ({ page }) => {
  await setup(page)
  await page.getByRole("button", { name: "Access", exact: true }).click()
  await page.getByLabel("Allowed private user IDs (comma separated)").fill("42, 43")
  await page.getByRole("button", { name: "Set private users" }).click()
  await page.getByRole("button", { name: "Save settings", exact: true }).click()
  await expect(page.getByRole("alertdialog")).toBeVisible()
  await page.getByRole("button", { name: "Save and apply" }).click()
  await expect(page.getByText("Saved 2 · Applied 2 · applied")).toBeVisible()
})
test("shows inherited chat settings and supported thinking levels", async ({ page }) => {
  await setup(page)
  await page.getByLabel("Chat ID (can configure before first message)").fill("42")
  await expect(page.getByRole("checkbox", { name: "Inherit default" }).first()).toBeChecked()
  await page.getByRole("combobox", { name: "Thinking level", exact: true }).click()
  await expect(page.getByRole("option", { name: "low", exact: true })).toBeVisible()
  await expect(page.getByRole("option", { name: "high", exact: true })).toHaveCount(0)
  await page.getByRole("option", { name: "low", exact: true }).click()
  await expect(page.getByText("Unsaved changes", { exact: true }).first()).toBeVisible()
})
test("secret input is masked and credential removal needs confirmation", async ({ page }) => {
  await setup(page)
  await page.getByRole("button", { name: "Model Providers", exact: true }).click()
  await page.getByLabel("Provider authentication").click()
  await page.getByRole("option", { name: "Fixture · configured" }).click()
  await expect(
    page.getByLabel("Replacement API key (existing key is never displayed)"),
  ).toHaveAttribute("type", "password")
  await page.getByRole("button", { name: "Remove credential", exact: true }).click()
  await expect(page.getByRole("alertdialog")).toContainText(
    "Ambient environment credentials are not removed",
  )
})
test("configures multiple custom models without exposing an existing key", async ({ page }) => {
  await setup(page)
  await page.getByRole("button", { name: "Model Providers", exact: true }).click()
  await page.getByLabel("Provider ID", { exact: true }).fill("custom")
  await page
    .getByLabel("API base URL (leave empty for built-in)")
    .fill("https://models.example.test/v1")
  await page.getByLabel("Model ID (required for custom endpoint)").fill("one")
  await page.getByRole("button", { name: "Add / update model" }).click()
  await page.getByLabel("Model ID (required for custom endpoint)").fill("two")
  await page.getByRole("button", { name: "Set provider configuration" }).click()
  await page.getByRole("button", { name: "Save settings", exact: true }).click()
  const saving = page.waitForRequest(
    (r) => r.url().endsWith("/api/settings") && r.method() === "PUT",
  )
  await page.getByRole("button", { name: "Save and apply" }).click()
  expect(
    (await saving).postDataJSON().policy.providers[0].models.map((m: { id: string }) => m.id),
  ).toEqual(["one", "two"])
})

test("retains edits and reports revision conflicts", async ({ page }) => {
  await setup(page)
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() === "PUT")
      await route.fulfill({
        status: 409,
        json: { error: "Settings changed; reload before saving" },
      })
    else await route.fallback()
  })
  await page.getByRole("button", { name: "Tools / MCP", exact: true }).click()
  await page.getByRole("checkbox", { name: "bash", exact: true }).check()
  await page.getByRole("button", { name: "Save settings", exact: true }).click()
  await page.getByRole("button", { name: "Save and apply" }).click()
  await expect(page.getByRole("alert")).toContainText("Settings changed")
  await expect(page.getByText("Unsaved changes", { exact: true }).first()).toBeVisible()
  await expect(page.getByRole("checkbox", { name: "bash", exact: true })).toBeChecked()
})

test("completes a browser-initiated provider interaction with a masked response", async ({
  page,
}) => {
  await setup(page)
  const id = "a".repeat(43)
  let status = "pending"
  await page.route("**/api/providers/fixture/oauth", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ revision: 1 })
    await route.fulfill({ json: { id } })
  })
  await page.route(`**/api/oauth/${id}`, async (route) => {
    if (route.request().method() === "POST") {
      expect(route.request().postDataJSON()).toEqual({ answer: "approved-fixture" })
      status = "completed"
      await route.fulfill({ json: { ok: true } })
    } else
      await route.fulfill({
        json: {
          status,
          ...(status === "pending"
            ? { prompt: { type: "manual_code", message: "Enter fixture code" } }
            : {}),
        },
      })
  })
  await page.getByRole("button", { name: "Model Providers", exact: true }).click()
  await page.getByLabel("Provider authentication").click()
  await page.getByRole("option", { name: "Fixture · configured" }).click()
  await page.getByRole("button", { name: "Start provider OAuth" }).click()
  const response = page.getByLabel("Provider login response")
  await expect(response).toHaveAttribute("type", "password")
  await response.fill("approved-fixture")
  await page.getByRole("button", { name: "Submit response" }).click()
  await expect(page.getByText("Provider login: completed")).toBeVisible()
  await expect(page.getByLabel("Provider login response")).toHaveCount(0)
})

test("reports failed runtime application without claiming success", async ({ page }) => {
  await setup(page)
  await page.route("**/api/settings", (route) =>
    route.fulfill({ json: { revision: 2, applied: 1, status: "failed", policy } }),
  )
  await page.route("**/api/apply", (route) =>
    route.fulfill({ status: 500, json: { error: "Settings could not be applied" } }),
  )
  await page.reload()
  await expect(page.getByText("Saved 2 · Applied 1 · failed")).toBeVisible()
  await page.getByRole("button", { name: "Retry application" }).click()
  await expect(page.getByRole("alert")).toContainText("Settings could not be applied")
  await expect(page.getByText("Saved 2 · Applied 1 · failed")).toBeVisible()
})
test("uses masked MCP secret replacements instead of displaying them in JSON", async ({ page }) => {
  await setup(page)
  await page.getByRole("button", { name: "Tools / MCP", exact: true }).click()
  await page.getByLabel("MCP server name").fill("fixture")
  await page.getByLabel("Server configuration JSON").fill('{"command":"fixture-server"}')
  await page.getByLabel("Secret field name").fill("TOKEN")
  const secret = page.getByLabel("New secret value")
  await expect(secret).toHaveAttribute("type", "password")
  await secret.fill("fixture-secret")
  await page.getByRole("button", { name: "Set pending secret replacement" }).click()
  await expect(secret).toHaveValue("")
  await expect(page.getByLabel("Server configuration JSON")).not.toHaveValue(/fixture-secret/)
  const saving = page.waitForRequest(
    (r) => r.url().endsWith("/api/mcp/fixture") && r.method() === "PUT",
  )
  await page.getByRole("button", { name: "Save MCP configuration and apply" }).click()
  expect((await saving).postDataJSON().config.env.TOKEN).toBe("fixture-secret")
})

test("supports narrow layouts and keyboard dialog cancellation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await setup(page)
  await page.getByRole("button", { name: "Tools / MCP", exact: true }).click()
  await page.getByRole("checkbox", { name: "bash", exact: true }).check()
  await page.getByRole("button", { name: "Save settings", exact: true }).click()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("alertdialog")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Save settings", exact: true })).toBeFocused()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
})
