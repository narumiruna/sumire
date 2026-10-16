import { expect, type Page, test } from "@playwright/test"

const policy = {
  tools: ["read_url_content"],
  servers: [],
  models: ["fixture/test"],
  defaults: {
    tools: ["read_url_content"],
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
const inventory = {
  tools: ["read_url_content", "bash"],
  providers: [
    {
      id: "fixture",
      name: "Fixture",
      configured: true,
      apiKey: true,
      oauth: true,
      models: [
        { id: "test", name: "Test", thinking: ["off", "low"], reasoning: true, image: true },
        {
          id: "other",
          name: "Other model",
          thinking: ["off"],
          reasoning: false,
          image: false,
        },
      ],
    },
  ],
  mcp: [],
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
    } else if (url.pathname === "/api/inventory") data = inventory
    else if (url.pathname === "/api/chats")
      data = [
        {
          id: 42,
          name: "Fixture chat",
          type: "private",
          effective: { enabled: true, tools: ["read_url_content"], sources: { tools: "default" } },
        },
      ]
    else if (url.pathname === "/api/audit") data = []
    else if (url.pathname === "/api/providers/fixture/credential") {
      expect(route.request().postDataJSON().revision).toBe(revision)
      expect(route.request().headers()["x-csrf-token"]).toBe("browser-fixture")
      revision++
    }
    await route.fulfill({ json: data })
  })
  await page.goto("/")
}
test("shows the model conflict beside its allowed list", async ({ page }) => {
  await setup(page)
  await page.getByRole("button", { name: "Defaults", exact: true }).click()
  await page.getByRole("checkbox", { name: "fixture/test", exact: true }).uncheck()
  await expect(page.getByRole("alert")).toContainText(
    'Model "fixture/test" is not in Allowed models',
  )
  await page.getByRole("checkbox", { name: "fixture/test", exact: true }).check()
  await expect(page.getByRole("alert")).toHaveCount(0)
})

test("stages inheritance for all chat overrides without changing access or enabled switches", async ({
  page,
}) => {
  await setup(page)
  const inherited = { tools: null, servers: null, models: null, model: null, thinking: null }
  const original = {
    ...structuredClone(policy),
    groups: [-100],
    chats: {
      "42": { ...inherited, tools: [], model: "fixture/test", enabled: true },
      "-100": { ...inherited, models: [], thinking: "high", enabled: false },
      "999": { ...inherited, servers: [], enabled: true },
    },
  }
  let saved = structuredClone(original)
  let writes = 0
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() === "PUT") {
      saved = route.request().postDataJSON().policy
      writes++
    }
    await route.fulfill({
      json: { revision: 1 + writes, applied: 1 + writes, status: "applied", policy: saved },
    })
  })
  await page.reload()
  await page.getByRole("button", { name: "Defaults", exact: true }).click()
  const bulk = page.getByRole("button", { name: "Use Defaults for all chats", exact: true })
  await bulk.click()
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Apply policy changes", exact: true }),
  ).toBeDisabled()
  await bulk.click()
  await page.getByRole("button", { name: "Stage inheritance for all chats", exact: true }).click()
  expect(writes).toBe(0)
  await expect(bulk).toBeDisabled()
  await page.getByRole("button", { name: "Apply policy changes", exact: true }).click()
  await page.getByRole("button", { name: "Save and apply", exact: true }).click()
  await expect(page.getByText("Saved revision applied.", { exact: true })).toBeVisible()
  expect(writes).toBe(1)
  expect(saved).toEqual({
    ...original,
    chats: {
      "42": { ...inherited, enabled: true },
      "-100": { ...inherited, enabled: false },
      "999": { ...inherited, enabled: true },
    },
  })
})

async function chooseProvider(page: Page) {
  await page.getByRole("button", { name: "Provider", exact: true }).click()
  await page.getByRole("combobox", { name: "Search provider" }).fill("fixt")
  await page.getByRole("combobox", { name: "Search provider" }).press("Enter")
}
async function chooseModel(page: Page, query = "Other") {
  await page.getByRole("button", { name: "Model", exact: true }).click()
  await page.getByRole("combobox", { name: "Search model" }).fill(query)
  await page.getByRole("combobox", { name: "Search model" }).press("Enter")
}
for (const existing of [false, true]) {
  test(`discards a ${existing ? "saved" : "new"} custom endpoint draft without changing policy`, async ({
    page,
  }) => {
    await setup(page)
    const custom = {
      id: "custom",
      enabled: true,
      baseUrl: "https://models.example.test/v1",
      api: "openai-completions",
      models: [],
    }
    if (existing) {
      await page.route("**/api/settings", (route) =>
        route.fulfill({
          json: {
            revision: 1,
            applied: 1,
            status: "applied",
            policy: { ...policy, providers: [custom] },
          },
        }),
      )
      await page.reload()
    }
    const mutations: string[] = []
    page.on("request", (r) => {
      if (r.method() !== "GET") mutations.push(r.url())
    })
    await page.getByRole("button", { name: "Access", exact: true }).click()
    await page.getByRole("button", { name: "Revoke access for ID 42" }).click()
    await page.getByRole("button", { name: "Model Providers", exact: true }).click()
    await page.getByText("Custom endpoint", { exact: true }).click()
    if (existing)
      await page.getByRole("button", { name: "Edit configuration custom", exact: true }).click()
    await page.getByLabel("Provider ID", { exact: true }).fill("abandoned")
    await page.getByLabel("Model ID (required for custom endpoint)").fill("abandoned-model")
    await page.getByRole("button", { name: "Add / update model", exact: true }).click()
    await expect(
      page.getByRole("button", { name: "Apply policy changes", exact: true }),
    ).toBeDisabled()
    await page.getByRole("button", { name: "Discard custom endpoint draft", exact: true }).click()
    await expect(page.getByLabel("Provider ID", { exact: true })).toHaveValue(
      existing ? "custom" : "",
    )
    await expect(page.getByLabel("API base URL")).toHaveValue(existing ? custom.baseUrl : "")
    await expect(
      page.getByRole("button", { name: "Edit model abandoned-model", exact: true }),
    ).toHaveCount(0)
    await expect(
      page.getByRole("button", { name: "Apply policy changes", exact: true }),
    ).toBeEnabled()
    await expect(page.getByText(/\d+ pending policy changes/).first()).toBeVisible()
    await page.getByRole("button", { name: "Access", exact: true }).click()
    await expect(page.getByRole("button", { name: "Revoke access for ID 42" })).toHaveCount(0)
    expect(mutations).toEqual([])
    page.once("dialog", (dialog) => dialog.accept())
    await page.getByRole("button", { name: "Discard policy changes", exact: true }).click()
    await expect(page.getByRole("button", { name: "Reload", exact: true })).toBeEnabled()
    expect(
      await page.evaluate(() => {
        const event = new Event("beforeunload", { cancelable: true })
        window.dispatchEvent(event)
        return event.defaultPrevented
      }),
    ).toBe(false)
  })
}

for (const customDraft of [false, true]) {
  test(`keeps the MCP ${customDraft ? "custom draft" : "new-server template"} through an existing name prefix`, async ({
    page,
  }) => {
    await setup(page)
    await page.route("**/api/inventory", (route) =>
      route.fulfill({
        json: {
          ...inventory,
          mcp: [
            {
              name: "existing",
              enabled: true,
              exposure: "codemode",
              connection: "not tested",
              tools: [],
              env: {},
              headers: {},
            },
          ],
        },
      }),
    )
    await page.reload()
    await page.getByRole("button", { name: "Tools / MCP", exact: true }).click()
    await page.getByText("Advanced server configuration JSON", { exact: true }).click()
    const json = page.getByLabel("Server configuration JSON")
    if (customDraft) await json.fill('{"command":"draft-server","args":["--draft"]}')
    const draft = await json.inputValue()
    let mutations = 0
    page.on("request", (r) => {
      if (r.method() !== "GET") mutations++
    })
    const name = page.getByLabel("MCP server name")
    await name.pressSequentially("existing")
    await expect(json).toHaveValue(draft)
    await name.pressSequentially("-v2")
    await expect(name).toHaveValue("existing-v2")
    await expect(json).toHaveValue(draft)
    page.once("dialog", (dialog) => dialog.dismiss())
    await page.getByRole("button", { name: "Edit fields for existing", exact: true }).click()
    await expect(name).toHaveValue("existing-v2")
    await expect(json).toHaveValue(draft)
    page.once("dialog", (dialog) => dialog.accept())
    await page.getByRole("button", { name: "Edit fields for existing", exact: true }).click()
    await expect(name).toHaveValue("existing")
    await expect(json).toHaveValue("{}")
    expect(mutations).toBe(0)
  })
}

for (const transport of ["stdio", "http"]) {
  test(`starts an empty update after explicit selection of an existing ${transport} MCP server`, async ({
    page,
  }) => {
    await setup(page)
    await page.route("**/api/inventory", (route) =>
      route.fulfill({
        json: {
          ...inventory,
          mcp: [
            {
              name: "existing",
              enabled: true,
              exposure: "codemode",
              connection: "not tested",
              tools: [],
              env: transport === "stdio" ? { TOKEN_A: null, TOKEN_B: null } : {},
              headers: transport === "http" ? { TOKEN_A: null, TOKEN_B: null } : {},
            },
          ],
        },
      }),
    )
    await page.reload()
    await page.getByRole("button", { name: "Tools / MCP", exact: true }).click()
    await page.getByRole("button", { name: "Edit fields for existing", exact: true }).click()
    await expect(page.getByLabel("Server configuration JSON")).toHaveValue("{}")
    await expect(page.getByText("Omitted keys are removed.", { exact: false })).toBeVisible()
    const scope = transport === "stdio" ? "env" : "headers"
    await page
      .getByLabel("Server configuration JSON")
      .fill(JSON.stringify({ [scope]: { TOKEN_A: null } }))
    const saving = page.waitForRequest(
      (r) => r.url().endsWith("/api/mcp/existing") && r.method() === "PUT",
    )
    await page.getByRole("button", { name: "Save MCP configuration and apply" }).click()
    expect((await saving).postDataJSON().config).toEqual({ [scope]: { TOKEN_A: null } })
  })
}

test("unauthorized visitor sees only passkey sign-in", async ({ page }) => {
  await setup(page, false)
  await expect(page.getByRole("button", { name: "Sign in with passkey" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Apply policy changes", exact: true })).toHaveCount(
    0,
  )
})
test("registers and signs in with a browser passkey without Telegram Web Login", async ({
  page,
  context,
}) => {
  await setup(page, false)
  const client = await context.newCDPSession(page)
  await client.send("WebAuthn.enable")
  await client.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  const challenge = Buffer.from("registration-challenge-fixture-32").toString("base64url")
  const user = Buffer.from("administrator-fixture").toString("base64url")
  let registrations = 0
  let authentications = 0
  await page.route("**/auth/passkey/**", async (route) => {
    const path = new URL(route.request().url()).pathname
    expect(route.request().method()).toBe("POST")
    expect(route.request().headers().origin).toBe("http://localhost:17466")
    if (path === "/auth/passkey/register/options") {
      expect(route.request().postDataJSON()).toEqual({ setup: "s".repeat(43) })
      await route.fulfill({
        json: {
          challenge,
          rp: { id: "localhost", name: "Sumire" },
          user: { id: user, name: "Administrator", displayName: "Administrator" },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          authenticatorSelection: { residentKey: "required", userVerification: "required" },
          attestation: "none",
        },
      })
    } else if (path === "/auth/passkey/authenticate/options")
      await route.fulfill({ json: { challenge, rpId: "localhost", userVerification: "required" } })
    else {
      const response = route.request().postDataJSON().response
      expect(response.type).toBe("public-key")
      expect(response.id).toBeTruthy()
      if (path === "/auth/passkey/register/verify") {
        registrations++
        expect(response.response.attestationObject).toBeTruthy()
      } else {
        authentications++
        expect(response.response.signature).toBeTruthy()
        expect(response.response.userHandle).toBe(user)
      }
      await route.fulfill({ json: { csrf: "browser-fixture", actor: "42" } })
    }
  })
  await page.goto(`http://localhost:17466/#setup=${"s".repeat(43)}`)
  await expect(page.getByRole("button", { name: "Register passkey" })).toBeVisible()
  await expect(page).toHaveURL("http://localhost:17466/")
  await page.getByRole("button", { name: "Register passkey" }).click()
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible()
  await page.getByRole("button", { name: "Sign out" }).click()
  await page.getByRole("button", { name: "Sign in with passkey" }).click()
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible()
  expect(registrations).toBe(1)
  expect(authentications).toBe(1)
})

test("confirms MCP deletion, sends the saved revision, and refreshes inventory", async ({
  page,
}) => {
  await setup(page)
  let deleted = false
  let attempts = 0
  await page.route("**/api/inventory", (route) =>
    route.fulfill({
      json: {
        ...inventory,
        mcp: deleted
          ? []
          : [
              {
                name: "obsolete",
                enabled: false,
                connection: "not tested",
                tools: [],
                env: { TOKEN: null },
                headers: {},
              },
            ],
      },
    }),
  )
  await page.route("**/api/mcp/obsolete", async (route) => {
    attempts++
    expect(route.request().method()).toBe("DELETE")
    expect(route.request().headers()["x-csrf-token"]).toBe("browser-fixture")
    expect(route.request().postDataJSON()).toEqual({ revision: 1 })
    if (attempts === 1) {
      await route.fulfill({ status: 409, json: { error: "Settings changed; reload" } })
      return
    }
    deleted = true
    await route.fulfill({ json: { ok: true } })
  })
  await page.reload()
  await page.getByRole("button", { name: "Tools / MCP", exact: true }).click()
  await page.getByRole("button", { name: "Delete obsolete", exact: true }).click()
  await expect(page.getByRole("alertdialog")).toContainText("stored secrets")
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  expect(attempts).toBe(0)
  await page.getByRole("button", { name: "Delete obsolete", exact: true }).click()
  await page.getByRole("button", { name: "Delete server and apply", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("Settings changed; reload")
  await expect(page.getByRole("button", { name: "Delete obsolete", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Delete obsolete", exact: true }).click()
  await page.getByRole("button", { name: "Delete server and apply", exact: true }).click()
  await expect(page.getByRole("button", { name: "Delete obsolete", exact: true })).toHaveCount(0)
  expect(attempts).toBe(2)
})

test("edits private access and saves with a confirmation", async ({ page }) => {
  await setup(page)
  await page.getByRole("button", { name: "Access", exact: true }).click()
  await page.getByLabel("Private user ID to add").fill("43")
  await page.getByRole("button", { name: "Add ID to pending settings" }).first().click()
  await page.getByRole("button", { name: "Apply policy changes", exact: true }).click()
  await expect(page.getByRole("alertdialog")).toBeVisible()
  await page.getByRole("button", { name: "Save and apply" }).click()
  await expect(page.getByText("Saved revision applied.", { exact: true })).toBeVisible()
})
test("shows inherited chat settings and supported thinking levels", async ({ page }) => {
  await setup(page)
  await page.getByRole("button", { name: "Known chat", exact: true }).click()
  await page.getByRole("combobox", { name: "Search known chat" }).press("Enter")
  await expect(page.getByRole("checkbox", { name: "Inherit default" }).first()).toBeChecked()
  await page.getByRole("combobox", { name: "Thinking level", exact: true }).click()
  await expect(page.getByRole("option", { name: "low", exact: true })).toBeVisible()
  await expect(page.getByRole("option", { name: "high", exact: true })).toHaveCount(0)
  await page.getByRole("option", { name: "low", exact: true }).click()
  await expect(page.getByText(/\d+ pending policy changes/).first()).toBeVisible()
})
test("loads the saved bot provider, model, thinking level, and default state", async ({ page }) => {
  await setup(page)
  await page.route("**/api/settings", (route) =>
    route.fulfill({
      json: {
        revision: 1,
        applied: 1,
        status: "applied",
        policy: { ...policy, defaults: { ...policy.defaults, thinking: "low" } },
      },
    }),
  )
  await page.reload()
  let mutations = 0
  page.on("request", (r) => {
    if (r.method() === "PUT") mutations++
  })
  await page.getByRole("button", { name: "Model Providers", exact: true }).click()
  await expect(page.getByRole("button", { name: "Provider", exact: true })).toHaveText(/Fixture/)
  await expect(page.getByRole("button", { name: "Model", exact: true })).toHaveText(/Test/)
  await expect(page.getByRole("combobox", { name: "Thinking level" })).toHaveText("low")
  await expect(page.getByRole("checkbox", { name: "Use as the bot default" })).toBeChecked()
  await expect(page.getByRole("button", { name: "Save model and apply" })).toBeDisabled()
  expect(mutations).toBe(0)
})

test("updates untouched provider fields when saved settings are reloaded", async ({ page }) => {
  await setup(page)
  let current = structuredClone(policy)
  await page.route("**/api/settings", (route) =>
    route.fulfill({ json: { revision: 2, applied: 2, status: "applied", policy: current } }),
  )
  await page.reload()
  await page.getByRole("button", { name: "Model Providers", exact: true }).click()
  await expect(page.getByRole("button", { name: "Model", exact: true })).toHaveText(/Test/)
  current = {
    ...policy,
    models: ["fixture/test", "fixture/other"],
    defaults: {
      ...policy.defaults,
      models: ["fixture/test", "fixture/other"],
      model: "fixture/other",
    },
  }
  await page.getByRole("button", { name: "Reload", exact: true }).click()
  await expect(page.getByRole("button", { name: "Model", exact: true })).toHaveText(/Other model/)
  await expect(page.getByRole("checkbox", { name: "Use as the bot default" })).toBeChecked()
})

test("keeps a local preview on refresh and restores saved values on request", async ({ page }) => {
  await setup(page)
  await page.getByRole("button", { name: "Model Providers", exact: true }).click()
  await chooseModel(page)
  await page.route("**/api/settings", (route) =>
    route.fulfill({
      json: {
        revision: 2,
        applied: 2,
        status: "applied",
        policy: { ...policy, defaults: { ...policy.defaults, thinking: "low" } },
      },
    }),
  )
  await page.getByRole("button", { name: "Reload", exact: true }).click()
  await expect(page.getByRole("button", { name: "Model", exact: true })).toHaveText(/Other model/)
  await page.getByRole("button", { name: "Use saved selection", exact: true }).click()
  await expect(page.getByRole("button", { name: "Model", exact: true })).toHaveText(/Test/)
  await expect(page.getByRole("combobox", { name: "Thinking level" })).toHaveText("low")
  await expect(page.getByRole("checkbox", { name: "Use as the bot default" })).toBeChecked()
})

test("loads an existing chat model without creating a shared bot default", async ({ page }) => {
  await setup(page)
  const legacy = {
    ...policy,
    models: ["fixture/other"],
    defaults: { ...policy.defaults, models: [], model: null },
    chats: {
      "42": {
        ...policy.defaults,
        enabled: true,
        models: ["fixture/other"],
        model: "fixture/other",
      },
    },
  }
  await page.route("**/api/settings", (route) =>
    route.fulfill({ json: { revision: 1, applied: 1, status: "applied", policy: legacy } }),
  )
  await page.reload()
  let mutations = 0
  page.on("request", (r) => {
    if (r.method() === "PUT") mutations++
  })
  await page.getByRole("button", { name: "Model Providers", exact: true }).click()
  await expect(page.getByRole("button", { name: "Provider", exact: true })).toHaveText(/Fixture/)
  await expect(page.getByRole("button", { name: "Model", exact: true })).toHaveText(/Other model/)
  await expect(page.getByRole("checkbox", { name: "Use as the bot default" })).not.toBeChecked()
  await expect(page.getByText("Existing chat model:", { exact: false })).toContainText(
    "fixture/other",
  )
  await page.getByText("Chat-specific models (1)", { exact: true }).click()
  await expect(page.getByRole("listitem")).toContainText("Chat 42: fixture/other")
  expect(mutations).toBe(0)
})

test("shows different chat models without choosing one as the shared default", async ({ page }) => {
  await setup(page)
  const next = {
    ...policy,
    models: ["fixture/test", "fixture/other"],
    defaults: { ...policy.defaults, model: null },
    chats: {
      "42": { ...policy.defaults, enabled: true },
      "43": {
        ...policy.defaults,
        enabled: true,
        models: ["fixture/other"],
        model: "fixture/other",
      },
    },
  }
  await page.route("**/api/settings", (route) =>
    route.fulfill({ json: { revision: 1, applied: 1, status: "applied", policy: next } }),
  )
  await page.reload()
  await page.getByRole("button", { name: "Model Providers", exact: true }).click()
  await expect(page.getByRole("button", { name: "Provider", exact: true })).toHaveText(/Fixture/)
  await expect(page.getByRole("button", { name: "Model", exact: true })).toHaveText(/Choose model/)
  await page.getByText("Chat-specific models (2)", { exact: true }).click()
  await expect(page.getByRole("listitem")).toHaveCount(2)
  await expect(page.getByRole("button", { name: "Save model and apply" })).toHaveCount(0)
})

test("retains an unavailable saved provider instead of choosing a configured replacement", async ({
  page,
}) => {
  await setup(page)
  const next = {
    ...policy,
    models: ["missing/test"],
    defaults: { ...policy.defaults, models: ["missing/test"], model: "missing/test" },
  }
  await page.route("**/api/settings", (route) =>
    route.fulfill({ json: { revision: 1, applied: 1, status: "applied", policy: next } }),
  )
  await page.reload()
  await page.getByRole("button", { name: "Model Providers", exact: true }).click()
  await expect(page.getByRole("button", { name: "Provider", exact: true })).toHaveText(/missing/)
  await expect(page.getByText("The selected provider missing", { exact: false })).toBeVisible()
  await expect(page.getByRole("button", { name: "Save model and apply" })).toHaveCount(0)
})

test("searches built-in catalogs and adds only the selected model", async ({ page }) => {
  await setup(page)
  await page.getByRole("button", { name: "Model Providers", exact: true }).click()
  await chooseProvider(page)
  await expect(page.getByLabel("Provider ID", { exact: true })).not.toBeVisible()
  await chooseModel(page)
  await expect(page.getByText("No reasoning", { exact: true })).toBeVisible()
  await expect(page.getByRole("combobox", { name: "Thinking level" })).toHaveCount(0)
  await page.getByRole("button", { name: "Save model and apply" }).click()
  const saving = page.waitForRequest(
    (r) => r.url().endsWith("/api/settings") && r.method() === "PUT",
  )
  await page.getByRole("button", { name: "Save and apply", exact: true }).click()
  expect((await saving).postDataJSON()).toEqual({
    revision: 1,
    policy: { ...policy, models: ["fixture/test", "fixture/other"] },
  })
  await expect(page.getByText("Saved revision applied.", { exact: true })).toBeVisible()
})

test("sets a bot default only after explicit selection and confirmation", async ({ page }) => {
  await setup(page)
  await page.getByRole("button", { name: "Model Providers", exact: true }).click()
  await chooseProvider(page)
  await chooseModel(page, "Test")
  await expect(page.getByText("Image input", { exact: true })).toBeVisible()
  await page.getByRole("combobox", { name: "Thinking level" }).click()
  await expect(page.getByRole("option", { name: "high", exact: true })).toHaveCount(0)
  await page.getByRole("option", { name: "low", exact: true }).click()
  await page.getByRole("checkbox", { name: "Use as the bot default" }).check()
  await page.getByRole("button", { name: "Save model and apply" }).click()
  await expect(page.getByRole("alertdialog")).toContainText("thinking low")
  const saving = page.waitForRequest(
    (r) => r.url().endsWith("/api/settings") && r.method() === "PUT",
  )
  await page.getByRole("button", { name: "Save and apply", exact: true }).click()
  expect((await saving).postDataJSON().policy).toEqual({
    ...policy,
    defaults: { ...policy.defaults, thinking: "low" },
  })
})

test("opens a single API-key method directly and preserves model selection after refresh", async ({
  page,
}) => {
  await setup(page)
  await page.route("**/api/inventory", (route) =>
    route.fulfill({
      json: { ...inventory, providers: [{ ...inventory.providers[0], oauth: false }] },
    }),
  )
  await page.reload()
  await page.getByRole("button", { name: "Model Providers", exact: true }).click()
  await chooseProvider(page)
  await chooseModel(page)
  await page.getByRole("button", { name: "Configure authentication" }).click()
  await expect(page.getByRole("button", { name: "Sign in with account" })).toHaveCount(0)
  await page.getByLabel("API key", { exact: true }).fill("fixture-secret")
  const saving = page.waitForRequest((r) => r.url().endsWith("/api/providers/fixture/credential"))
  await page.getByRole("button", { name: "Save API key", exact: true }).click()
  expect((await saving).postDataJSON()).toEqual({ key: "fixture-secret", revision: 1 })
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Model", exact: true })).toHaveText(/Other model/)
  await expect(page.getByText("Saved revision applied.", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Configure authentication" }).click()
  await expect(page.getByLabel("API key", { exact: true })).toHaveValue("")
})

test("blocks credential and model saves while other policy edits are unsaved", async ({ page }) => {
  await setup(page)
  await page.getByRole("button", { name: "Tools / MCP", exact: true }).click()
  await page.getByRole("checkbox", { name: "bash", exact: true }).check()
  await page.getByRole("button", { name: "Model Providers", exact: true }).click()
  await chooseProvider(page)
  await chooseModel(page)
  await expect(page.getByRole("button", { name: "Configure authentication" })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Save model and apply" })).toBeDisabled()
  await page.getByRole("button", { name: "Tools / MCP", exact: true }).click()
  await expect(page.getByRole("checkbox", { name: "bash", exact: true })).toBeChecked()
})

test("retains the selected model after a revision conflict", async ({ page }) => {
  await setup(page)
  await page.route("**/api/settings", (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({ status: 409, json: { error: "Settings changed; reload before saving" } })
      : route.fallback(),
  )
  await page.getByRole("button", { name: "Model Providers", exact: true }).click()
  await chooseProvider(page)
  await chooseModel(page)
  await page.getByRole("button", { name: "Save model and apply" }).click()
  await page.getByRole("button", { name: "Save and apply", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("Settings changed")
  await expect(page.getByRole("button", { name: "Model", exact: true })).toHaveText(/Other model/)
})

test("opens account-only authentication directly and cancels it on Escape", async ({ page }) => {
  await setup(page)
  await page.route("**/api/inventory", (route) =>
    route.fulfill({
      json: { ...inventory, providers: [{ ...inventory.providers[0], apiKey: false }] },
    }),
  )
  const id = "c".repeat(43)
  let cancelled = false
  await page.route("**/api/settings", (route) =>
    cancelled
      ? route.fulfill({ json: { revision: 2, applied: 2, status: "applied", policy } })
      : route.fallback(),
  )
  await page.route("**/api/providers/fixture/oauth", (route) => route.fulfill({ json: { id } }))
  await page.route(`**/api/oauth/${id}`, (route) => {
    if (route.request().method() === "POST") {
      expect(route.request().postDataJSON()).toEqual({ cancel: true })
      cancelled = true
    }
    return route.fulfill({
      json: {
        status: "pending",
        event: { type: "auth", verificationUri: "https://example.test/device", userCode: "ABCD" },
      },
    })
  })
  await page.reload()
  await page.getByRole("button", { name: "Model Providers", exact: true }).click()
  await chooseProvider(page)
  await page.getByRole("button", { name: "Configure authentication" }).click()
  await expect(page.getByRole("link", { name: "Open provider sign-in" })).toHaveAttribute(
    "href",
    "https://example.test/device",
  )
  await expect(page.getByText("Verification code:")).toContainText("ABCD")
  await expect(page.getByRole("button", { name: "Use API key" })).toHaveCount(0)
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog")).toHaveCount(0)
  expect(cancelled).toBe(true)
  await expect(page.getByText("Saved revision applied.", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Configure authentication" })).toBeFocused()
})

test("keeps a failed login cancellation open until the server accepts it", async ({ page }) => {
  await setup(page)
  const id = "d".repeat(43)
  let rejectCancel = true
  await page.route("**/api/providers/fixture/oauth", (route) => route.fulfill({ json: { id } }))
  await page.route(`**/api/oauth/${id}`, (route) =>
    route.fulfill(
      route.request().method() === "POST" && rejectCancel
        ? { status: 500, json: { error: "Cancellation failed" } }
        : { json: { status: "pending" } },
    ),
  )
  await page.getByRole("button", { name: "Model Providers", exact: true }).click()
  await chooseProvider(page)
  await page.getByRole("button", { name: "Configure authentication" }).click()
  await page.getByRole("button", { name: "Sign in with account" }).click()
  await page.getByRole("button", { name: "Cancel provider login" }).click()
  await expect(page.getByRole("dialog")).toBeVisible()
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Cancellation failed")
  rejectCancel = false
  await page.getByRole("button", { name: "Cancel provider login" }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
})

test("shows host setup instead of unsupported login methods", async ({ page }) => {
  await setup(page)
  await page.route("**/api/inventory", (route) =>
    route.fulfill({
      json: {
        ...inventory,
        providers: [{ ...inventory.providers[0], apiKey: false, oauth: false, configured: false }],
      },
    }),
  )
  await page.reload()
  await page.getByRole("button", { name: "Model Providers", exact: true }).click()
  await chooseProvider(page)
  await expect(
    page.getByText("This provider uses host credentials.", { exact: false }),
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "Configure authentication" })).toHaveCount(0)
})

test("keeps unavailable model selections visible instead of selecting a fallback", async ({
  page,
}) => {
  await setup(page)
  let removed = false
  await page.route("**/api/inventory", (route) =>
    route.fulfill({
      json: {
        ...inventory,
        providers: [
          {
            ...inventory.providers[0],
            oauth: false,
            models: removed ? [] : (inventory.providers[0]?.models ?? []),
          },
        ],
      },
    }),
  )
  await page.route("**/api/providers/fixture/credential", (route) => {
    removed = true
    return route.fulfill({ json: { ok: true } })
  })
  await page.reload()
  await page.getByRole("button", { name: "Model Providers", exact: true }).click()
  await chooseProvider(page)
  await chooseModel(page)
  await page.getByRole("button", { name: "Configure authentication" }).click()
  await page.getByLabel("API key", { exact: true }).fill("fixture-secret")
  await page.getByRole("button", { name: "Save API key", exact: true }).click()
  await expect(
    page.getByText("The selected model is no longer in the catalog.", { exact: false }),
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "Model", exact: true })).toHaveText(/other/)
  await expect(page.getByRole("button", { name: "Save model and apply" })).toHaveCount(0)
})

test("keeps removed approved models available to undo an unsaved edit", async ({ page }) => {
  await setup(page)
  await page.getByRole("button", { name: "Model Providers", exact: true }).click()
  await page.getByText("Manage model availability", { exact: true }).click()
  const approved = page.getByRole("checkbox", { name: "fixture/test", exact: true })
  await approved.uncheck()
  await expect(approved).not.toBeChecked()
  await approved.check()
  await expect(approved).toBeChecked()
  await expect(page.getByRole("checkbox", { name: "fixture/other", exact: true })).toHaveCount(0)
})

test("requires an explicit supported thinking choice after catalog changes", async ({ page }) => {
  await setup(page)
  let changed = false
  await page.route("**/api/inventory", (route) =>
    route.fulfill({
      json: {
        ...inventory,
        providers: [
          {
            ...inventory.providers[0],
            oauth: false,
            models: inventory.providers[0]?.models.map((m) => ({
              ...m,
              thinking: changed ? ["off"] : m.thinking,
            })),
          },
        ],
      },
    }),
  )
  await page.route("**/api/providers/fixture/credential", (route) => {
    changed = true
    return route.fulfill({ json: { ok: true } })
  })
  await page.reload()
  await page.getByRole("button", { name: "Model Providers", exact: true }).click()
  await chooseProvider(page)
  await chooseModel(page, "Test")
  await page.getByRole("combobox", { name: "Thinking level" }).click()
  await page.getByRole("option", { name: "low", exact: true }).click()
  await page.getByRole("button", { name: "Configure authentication" }).click()
  await page.getByLabel("API key", { exact: true }).fill("fixture-secret")
  await page.getByRole("button", { name: "Save API key", exact: true }).click()
  await expect(page.getByRole("button", { name: "Save model and apply" })).toBeDisabled()
  await expect(
    page.getByText("The selected thinking level is unavailable.", { exact: false }),
  ).toBeVisible()
  await page.getByRole("combobox", { name: "Thinking level" }).click()
  await page.getByRole("option", { name: "off", exact: true }).click()
  await expect(
    page.getByText("The selected thinking level is unavailable.", { exact: false }),
  ).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Save model and apply" })).toBeDisabled()
  await expect(
    page.getByText("Selection matches current settings.", { exact: false }),
  ).toBeVisible()
})

test("provider search works with the keyboard on narrow screens", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await setup(page)
  await page.getByRole("button", { name: "Model Providers", exact: true }).click()
  await chooseProvider(page)
  await page.getByRole("button", { name: "Model", exact: true }).click()
  const search = page.getByRole("combobox", { name: "Search model" })
  await search.fill("no-such-model")
  await expect(page.getByText("No matches.")).toBeVisible()
  await search.fill("")
  await search.press("ArrowDown")
  await search.press("Enter")
  await expect(page.getByRole("button", { name: "Model", exact: true })).toHaveText(/Other model/)
  await expect(page.getByRole("button", { name: "Model", exact: true })).toBeFocused()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
})

test("secret input is masked and credential removal needs confirmation", async ({ page }) => {
  await setup(page)
  await page.getByRole("button", { name: "Model Providers", exact: true }).click()
  await chooseProvider(page)
  await page.getByRole("button", { name: "Configure authentication" }).click()
  await page.getByRole("button", { name: "Use API key" }).click()
  await expect(page.getByLabel("API key", { exact: true })).toHaveAttribute("type", "password")
  await page.getByRole("button", { name: "Close", exact: true }).click()
  await page.getByRole("button", { name: "Remove credential", exact: true }).click()
  await expect(page.getByRole("alertdialog")).toContainText(
    "Ambient environment credentials are not removed",
  )
})
test("configures multiple custom models without exposing an existing key", async ({ page }) => {
  await setup(page)
  await page.getByRole("button", { name: "Model Providers", exact: true }).click()
  await page.getByText("Custom endpoint", { exact: true }).click()
  await page.getByLabel("Provider ID", { exact: true }).fill("custom")
  await page.getByLabel("API base URL", { exact: true }).fill("https://models.example.test/v1")
  await page.getByLabel("Model ID (required for custom endpoint)").fill("one")
  await page.getByRole("button", { name: "Add / update model" }).click()
  await page.getByLabel("Model ID (required for custom endpoint)").fill("two")
  await page.getByRole("button", { name: "Set provider configuration" }).click()
  await page.getByRole("button", { name: "Apply policy changes", exact: true }).click()
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
  await page.getByRole("button", { name: "Apply policy changes", exact: true }).click()
  await page.getByRole("button", { name: "Save and apply" }).click()
  await expect(page.getByRole("alert")).toContainText("Settings changed")
  await expect(page.getByText(/\d+ pending policy changes/).first()).toBeVisible()
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
            ? {
                event: {
                  type: "auth",
                  url: "https://example.test/login",
                  userCode: "fixture-code",
                },
                prompt: { type: "manual_code", message: "Enter fixture code" },
              }
            : {}),
        },
      })
  })
  await page.getByRole("button", { name: "Model Providers", exact: true }).click()
  await chooseProvider(page)
  await page.getByRole("button", { name: "Configure authentication" }).click()
  await page.getByRole("button", { name: "Sign in with account" }).click()
  await expect(page.getByRole("link", { name: "Open provider sign-in" })).toHaveAttribute(
    "href",
    "https://example.test/login",
  )
  const response = page.getByLabel("Provider login response")
  await expect(response).toHaveAttribute("type", "password")
  await response.fill("approved-fixture")
  await page.getByRole("button", { name: "Submit response" }).click()
  await expect(
    page.getByText("Provider authenticated. Your model selection is retained."),
  ).toBeVisible()
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
  await expect(
    page.getByText("Saved, but application failed. Retry application.", { exact: true }),
  ).toBeVisible()
  await page.getByRole("button", { name: "Retry application" }).click()
  await expect(page.getByRole("alert")).toContainText("Settings could not be applied")
  await expect(
    page.getByText("Saved, but application failed. Retry application.", { exact: true }),
  ).toBeVisible()
})
test("uses masked MCP secret replacements instead of displaying them in JSON", async ({ page }) => {
  await setup(page)
  await page.getByRole("button", { name: "Tools / MCP", exact: true }).click()
  await page.getByLabel("MCP server name").fill("fixture")
  await page.getByText("Advanced server configuration JSON", { exact: true }).click()
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
  await page.getByRole("button", { name: "Apply policy changes", exact: true }).click()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("alertdialog")).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "Apply policy changes", exact: true }),
  ).toBeFocused()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
})

test("keeps policy, MCP, and authentication save scopes separate", async ({ page }) => {
  await setup(page)
  const mutations: string[] = []
  page.on("request", (r) => {
    if (r.method() !== "GET") mutations.push(new URL(r.url()).pathname)
  })
  await page.getByRole("button", { name: "Access", exact: true }).click()
  await page.getByLabel("Private user ID to add").fill("43")
  await page.getByRole("button", { name: "Add ID to pending settings" }).first().click()
  await page.getByRole("button", { name: "Tools / MCP", exact: true }).click()
  await page.getByLabel("MCP server name").fill("draft-server")
  await page.getByRole("button", { name: "Model Providers", exact: true }).click()
  await expect(page.getByRole("button", { name: "Configure authentication" })).toBeDisabled()
  await page.getByRole("button", { name: "Apply policy changes", exact: true }).click()
  await expect(page.getByRole("alertdialog")).toContainText(
    "MCP connection edits and authentication are separate",
  )
  const saving = page.waitForRequest(
    (r) => r.url().endsWith("/api/settings") && r.method() === "PUT",
  )
  await page.getByRole("button", { name: "Save and apply", exact: true }).click()
  expect((await saving).postDataJSON().policy.privateUsers).toEqual([42, 43])
  await expect(page.getByText("Pending MCP configuration", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Tools / MCP", exact: true }).click()
  await expect(page.getByLabel("MCP server name")).toHaveValue("draft-server")
  expect(mutations).toEqual(["/api/settings"])
})

test("distinguishes inherited, empty, and customized chat authorization", async ({ page }) => {
  await setup(page)
  await page.getByRole("button", { name: "Known chat", exact: true }).click()
  await page.getByRole("combobox", { name: "Search known chat" }).fill("Fixture")
  await page.keyboard.press("Enter")
  const tools = page.getByRole("group", { name: "Authorized tools", exact: true }).first()
  await expect(tools).toContainText("Inherited · Effective: read_url_content")
  await tools.getByRole("checkbox", { name: "Inherit default", exact: true }).uncheck()
  await expect(tools).toContainText("None allowed. This does not inherit the default.")
  await expect(tools).toContainText("Customized · Effective: None")
  const save = async () => {
    await page.getByRole("button", { name: "Apply policy changes", exact: true }).click()
    const pending = page.waitForRequest(
      (r) => r.url().endsWith("/api/settings") && r.method() === "PUT",
    )
    await page.getByRole("button", { name: "Save and apply", exact: true }).click()
    return (await pending).postDataJSON().policy.chats["42"].tools
  }
  expect(await save()).toEqual([])
  await tools.getByRole("button", { name: "Reset authorized tools to default" }).click()
  expect(await save()).toBeNull()
  await tools.getByRole("checkbox", { name: "Inherit default", exact: true }).uncheck()
  await tools.getByRole("checkbox", { name: "read_url_content", exact: true }).check()
  expect(await save()).toEqual(["read_url_content"])
})

test("validates access rows without approving history or restoring removals", async ({ page }) => {
  await setup(page)
  await page.route("**/api/imports", (route) =>
    route.fulfill({
      json: [
        {
          name: "environment-access:5",
          report: { decisions: [{ id: 99, decision: "retain-denial" }] },
        },
      ],
    }),
  )
  await page.reload()
  await page.getByRole("button", { name: "Access", exact: true }).click()
  await page.getByLabel("Private user ID to add").fill("-99")
  await page.getByRole("button", { name: "Add ID to pending settings" }).first().click()
  await expect(page.getByRole("alert")).toContainText("positive whole-number")
  await page.getByLabel("Private user ID to add").fill("")
  await page.getByRole("button", { name: "Revoke access for ID 42", exact: true }).click()
  await page.getByRole("button", { name: "Apply policy changes", exact: true }).click()
  const saving = page.waitForRequest(
    (r) => r.url().endsWith("/api/settings") && r.method() === "PUT",
  )
  await page.getByRole("button", { name: "Save and apply", exact: true }).click()
  expect((await saving).postDataJSON().policy.privateUsers).toEqual([])
})

test("retains unfinished editors across sections and guards reload and sign-out", async ({
  page,
}) => {
  await setup(page)
  await page.getByRole("button", { name: "Access", exact: true }).click()
  await page.getByLabel("Private user ID to add").fill("43")
  await expect(page.getByRole("button", { name: "Reload", exact: true })).toBeDisabled()
  await page.getByRole("button", { name: "Defaults", exact: true }).click()
  await page.getByRole("button", { name: "Access", exact: true }).click()
  await expect(page.getByLabel("Private user ID to add")).toHaveValue("43")
  const unloadPrevented = await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  })
  expect(unloadPrevented).toBe(true)
  page.once("dialog", (dialog) => dialog.dismiss())
  await page.getByRole("button", { name: "Sign out", exact: true }).click()
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible()
})

test("uses Model Providers as the only shared default model editor", async ({ page }) => {
  await setup(page)
  await page.getByRole("button", { name: "Defaults", exact: true }).click()
  await expect(page.getByRole("group", { name: "Allowed models", exact: true })).toBeVisible()
  await expect(page.getByRole("combobox", { name: "Chat model override" })).toHaveCount(0)
  await page.getByRole("button", { name: "Edit default model in Model Providers" }).click()
  await expect(page.getByRole("button", { name: "Provider", exact: true })).toBeVisible()
})

test("shows readable audit and import summaries with raw details and server pagination", async ({
  page,
}) => {
  await setup(page)
  await page.route("**/api/imports", (route) =>
    route.fulfill({
      json: [
        {
          name: "models",
          report: { imported: 3, failedChatIds: [43], unscannedEntries: 2, reviewRequired: true },
        },
      ],
    }),
  )
  await page.route("**/api/audit?offset=0", (route) =>
    route.fulfill({
      json: Array.from({ length: 100 }, (_, id) => ({
        id,
        time: 1700000000000,
        actor: "42",
        operation: "settings.apply",
        revision: id + 1,
        outcome: id === 0 ? "failed" : "applied",
        target: "settings",
      })),
    }),
  )
  await page.reload()
  await page.getByRole("button", { name: "Audit", exact: true }).click()
  await expect(page.getByText("Review required at import")).toBeVisible()
  await expect(page.getByText(/3 model settings imported/)).toContainText("1 chats failed")
  await expect(
    page.getByRole("list", { name: "Configuration activity" }).getByRole("listitem").first(),
  ).toContainText("Settings application — failed")
  await expect(
    page.getByRole("list", { name: "Configuration activity" }).getByRole("listitem").first(),
  ).toContainText("Actor 42 · Revision 1")
  await page.getByText("Raw audit record", { exact: true }).first().click()
  await expect(page.getByText(/"operation": "settings.apply"/).first()).toBeVisible()
  const older = page.waitForRequest("**/api/audit?offset=100")
  await page.getByRole("button", { name: "Older", exact: true }).click()
  await older
  await expect(page.getByText("No audit records on this page.")).toBeVisible()
  await expect(page.getByRole("button", { name: "Newer", exact: true })).toBeEnabled()
})

test("edits MCP fields without exposing secrets and preserves omitted replacement values", async ({
  page,
}) => {
  await setup(page)
  await page.route("**/api/inventory", (route) =>
    route.fulfill({
      json: {
        ...inventory,
        mcp: [
          {
            name: "existing",
            enabled: true,
            exposure: "codemode",
            connection: "not tested",
            tools: ["mcp_existing_read"],
            env: { OLD_TOKEN: null, TOKEN: null },
            headers: { Authorization: null },
          },
        ],
      },
    }),
  )
  await page.reload()
  await page.getByRole("button", { name: "Tools / MCP", exact: true }).click()
  await expect(page.getByText("Connection test:", { exact: false })).toContainText("not tested")
  await page.getByRole("button", { name: "Edit fields for existing", exact: true }).click()
  await expect(page.getByLabel("Server configuration JSON")).toHaveValue("{}")
  await page.getByLabel("Secret field name").fill("TOKEN")
  await page.getByLabel("New secret value").fill("replacement-fixture")
  await expect(
    page.getByRole("button", { name: "Save MCP configuration and apply" }),
  ).toBeDisabled()
  await page.getByRole("button", { name: "Set pending secret replacement" }).click()
  const saving = page.waitForRequest(
    (r) => r.url().endsWith("/api/mcp/existing") && r.method() === "PUT",
  )
  await page.getByRole("button", { name: "Save MCP configuration and apply" }).click()
  const config = (await saving).postDataJSON().config
  expect(config).toEqual({ env: { OLD_TOKEN: null, TOKEN: "replacement-fixture" } })
  expect(config).not.toHaveProperty("headers")
  await expect(page.getByLabel("Server configuration JSON")).not.toHaveValue(/replacement-fixture/)
  await expect(page.getByText("Pending MCP configuration", { exact: true })).toHaveCount(0)
})

test("never saves plaintext secrets from the advanced JSON editor", async ({ page }) => {
  await setup(page)
  let saves = 0
  page.on("request", (r) => {
    if (r.url().endsWith("/api/mcp/new") && r.method() === "PUT") saves++
  })
  await page.getByRole("button", { name: "Tools / MCP", exact: true }).click()
  await page.getByLabel("MCP server name").fill("new")
  await page.getByText("Advanced server configuration JSON", { exact: true }).click()
  await page.getByLabel("Server configuration JSON").fill('{"env":{"TOKEN":"unsafe-fixture"}}')
  await page.getByRole("button", { name: "Save MCP configuration and apply" }).click()
  await expect(page.getByRole("alert")).toContainText(
    "Use the masked field for secret replacements",
  )
  expect(saves).toBe(0)
  await expect(page.getByText("Pending MCP configuration", { exact: true })).toBeVisible()
})

test("clears the shared model only through an explicit scoped confirmation", async ({ page }) => {
  await setup(page)
  await page.getByRole("button", { name: "Model Providers", exact: true }).click()
  await page.getByRole("button", { name: "Clear shared default model", exact: true }).click()
  await expect(page.getByRole("alertdialog")).toContainText(
    "Allowed models, authentication, and chat overrides stay unchanged",
  )
  const saving = page.waitForRequest(
    (r) => r.url().endsWith("/api/settings") && r.method() === "PUT",
  )
  await page.getByRole("button", { name: "Clear default and apply", exact: true }).click()
  const saved = (await saving).postDataJSON().policy
  expect(saved.defaults.model).toBeNull()
  expect(saved.defaults.thinking).toBeNull()
  expect(saved.defaults.models).toEqual(policy.defaults.models)
  expect(saved.models).toEqual(policy.models)
  expect(saved.chats).toEqual(policy.chats)
  expect(saved.privateUsers).toEqual(policy.privateUsers)
})

test("locks configuration inputs while policy submission is in flight", async ({ page }) => {
  await setup(page)
  let finish!: () => void
  const waiting = new Promise<void>((resolve) => {
    finish = resolve
  })
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() === "PUT") await waiting
    await route.fallback()
  })
  await page.getByRole("button", { name: "Access", exact: true }).click()
  await page.getByRole("button", { name: "Revoke access for ID 42" }).click()
  await page.getByRole("button", { name: "Apply policy changes", exact: true }).click()
  await page.getByRole("button", { name: "Save and apply", exact: true }).click()
  await expect(page.getByLabel("Private user ID to add")).toBeDisabled()
  await expect(page.getByText("Saving or checking…", { exact: true })).toBeVisible()
  finish()
  await expect(page.getByLabel("Private user ID to add")).toBeEnabled()
  await expect(page.getByText("Saved revision applied.", { exact: true })).toBeVisible()
})

test("clears unstaged secrets when an unnamed MCP draft is discarded", async ({ page }) => {
  await setup(page)
  await page.getByRole("button", { name: "Tools / MCP", exact: true }).click()
  await page.getByLabel("Secret field name").fill("TOKEN")
  await page.getByLabel("New secret value").fill("discard-fixture")
  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "Discard MCP draft", exact: true }).click()
  await expect(page.getByLabel("Secret field name")).toHaveValue("")
  await expect(page.getByLabel("New secret value")).toHaveValue("")
  await expect(page.getByRole("button", { name: "Reload", exact: true })).toBeEnabled()
})

for (const control of ["Reasoning supported", "Image input supported", "API"] as const) {
  test(`guards unsaved custom provider edits made only through ${control}`, async ({ page }) => {
    await setup(page)
    const custom = {
      id: "custom",
      enabled: true,
      baseUrl: "https://models.example.test/v1",
      api: "openai-completions",
      models: [
        {
          id: "one",
          name: "One",
          reasoning: false,
          image: false,
          contextWindow: 128000,
          maxTokens: 8192,
        },
      ],
    }
    await page.route("**/api/settings", (route) =>
      route.request().method() === "GET"
        ? route.fulfill({
            json: {
              revision: 1,
              applied: 1,
              status: "applied",
              policy: { ...policy, providers: [custom] },
            },
          })
        : route.fallback(),
    )
    await page.reload()
    await page.getByRole("button", { name: "Model Providers", exact: true }).click()
    await page.getByText("Custom endpoint", { exact: true }).click()
    await page.getByRole("button", { name: "Edit configuration custom", exact: true }).click()
    await page.getByRole("button", { name: "Edit model one", exact: true }).click()
    await expect(page.getByRole("button", { name: "Reload", exact: true })).toBeEnabled()
    if (control === "API") {
      await page.getByText("Advanced protocol", { exact: true }).click()
      await page.getByRole("combobox", { name: "API", exact: true }).click()
      await page.getByRole("option", { name: "openai-responses", exact: true }).click()
    } else {
      await page.getByText("Advanced model metadata", { exact: true }).click()
      await page.getByRole("checkbox", { name: control, exact: true }).check()
    }
    await expect(page.getByRole("button", { name: "Reload", exact: true })).toBeDisabled()
    expect(
      await page.evaluate(() => {
        const event = new Event("beforeunload", { cancelable: true })
        window.dispatchEvent(event)
        return event.defaultPrevented
      }),
    ).toBe(true)
    const dialog = page.waitForEvent("dialog")
    const signingOut = page.getByRole("button", { name: "Sign out", exact: true }).click()
    const warning = await dialog
    expect(warning.message()).toBe("Discard pending changes and leave?")
    await warning.dismiss()
    await signingOut
    await page.getByRole("button", { name: "Set provider configuration", exact: true }).click()
    await page.getByRole("button", { name: "Apply policy changes", exact: true }).click()
    const saving = page.waitForRequest(
      (r) => r.url().endsWith("/api/settings") && r.method() === "PUT",
    )
    await page.getByRole("button", { name: "Save and apply", exact: true }).click()
    const saved = (await saving).postDataJSON().policy.providers[0]
    expect(saved.api).toBe(control === "API" ? "openai-responses" : "openai-completions")
    expect(saved.models[0].reasoning).toBe(control === "Reasoning supported")
    expect(saved.models[0].image).toBe(control === "Image input supported")
  })
}

for (const scenario of [
  { name: "clears a matching MCP draft after deletion", draft: "obsolete", fails: false },
  { name: "retains a different MCP draft after deletion", draft: "other", fails: false },
  { name: "retains the matching MCP draft when deletion fails", draft: "obsolete", fails: true },
]) {
  test(scenario.name, async ({ page }) => {
    await setup(page)
    let deleted = false
    await page.route("**/api/inventory", (route) =>
      route.fulfill({
        json: {
          ...inventory,
          mcp: ["obsolete", "other"]
            .filter((name) => !deleted || name !== "obsolete")
            .map((name) => ({
              name,
              enabled: true,
              exposure: "codemode",
              connection: "not tested",
              tools: [],
              env: {},
              headers: {},
            })),
        },
      }),
    )
    await page.route("**/api/mcp/obsolete", (route) => {
      expect(route.request().method()).toBe("DELETE")
      expect(route.request().postDataJSON()).toEqual({ revision: 1 })
      if (scenario.fails) return route.fulfill({ status: 500, json: { error: "Deletion failed" } })
      deleted = true
      return route.fulfill({ json: { ok: true } })
    })
    await page.reload()
    await page.getByRole("button", { name: "Tools / MCP", exact: true }).click()
    await page
      .getByRole("button", { name: `Edit fields for ${scenario.draft}`, exact: true })
      .click()
    await page.getByLabel("Server configuration JSON").fill('{"enabled":false}')
    await page.getByLabel("Secret field name").fill("TOKEN")
    await page.getByLabel("New secret value").fill("pending-fixture")
    await page.getByRole("button", { name: "Set pending secret replacement", exact: true }).click()
    await page.getByRole("button", { name: "Delete obsolete", exact: true }).click()
    await page.getByRole("button", { name: "Delete server and apply", exact: true }).click()
    if (scenario.fails) await expect(page.getByRole("alert")).toContainText("Deletion failed")
    else
      await expect(page.getByRole("button", { name: "Delete obsolete", exact: true })).toHaveCount(
        0,
      )
    if (scenario.draft === "obsolete" && !scenario.fails) {
      await expect(page.getByText("Pending MCP configuration", { exact: true })).toHaveCount(0)
      await expect(page.getByLabel("MCP server name")).toHaveValue("")
      await expect(page.getByLabel("Server configuration JSON")).toHaveValue("{}")
      await expect(page.getByText("Pending secret fields:", { exact: false })).toContainText("none")
      await expect(page.getByRole("button", { name: "Reload", exact: true })).toBeEnabled()
    } else {
      await expect(page.getByText("Pending MCP configuration", { exact: true })).toBeVisible()
      await expect(page.getByLabel("MCP server name")).toHaveValue(scenario.draft)
      await expect(page.getByLabel("Server configuration JSON")).toHaveValue('{"enabled":false}')
      await expect(page.getByText("Pending secret fields:", { exact: false })).toContainText(
        "TOKEN",
      )
      await expect(page.getByRole("button", { name: "Reload", exact: true })).toBeEnabled()
    }
    expect(
      await page.evaluate(() => {
        const event = new Event("beforeunload", { cancelable: true })
        window.dispatchEvent(event)
        return event.defaultPrevented
      }),
    ).toBe(scenario.draft !== "obsolete" || scenario.fails)
  })
}

for (const method of ["PUT", "DELETE"] as const) {
  test(`reloads saved state without discarding an MCP draft after ${method} application fails`, async ({
    page,
  }) => {
    await setup(page)
    let revision = 1
    let status = "applied"
    let attempts = 0
    await page.route("**/api/settings", (route) =>
      route.fulfill({
        json: { revision, applied: status === "applied" ? revision : revision - 1, status, policy },
      }),
    )
    await page.route("**/api/inventory", (route) =>
      route.fulfill({
        json: {
          ...inventory,
          mcp:
            method === "DELETE" && revision > 1
              ? []
              : [
                  {
                    name: "existing",
                    enabled: true,
                    exposure: "codemode",
                    connection: "not tested",
                    tools: [],
                    env: { TOKEN: null },
                    headers: {},
                  },
                ],
        },
      }),
    )
    await page.route("**/api/mcp/existing", (route) => {
      expect(route.request().method()).toBe(method)
      expect(route.request().postDataJSON().revision).toBe(1)
      if (method === "PUT")
        expect(route.request().postDataJSON().config.env.TOKEN).toBe("uncertain-fixture")
      attempts++
      revision = 2
      status = "failed"
      return route.fulfill({ status: 500, json: { error: "Application failed after saving" } })
    })
    await page.route("**/api/apply", (route) => {
      expect(route.request().method()).toBe("POST")
      status = "applied"
      return route.fulfill({ json: { ok: true } })
    })
    await page.reload()
    await page.getByRole("button", { name: "Tools / MCP", exact: true }).click()
    await page.getByRole("button", { name: "Edit fields for existing", exact: true }).click()
    await page.getByLabel("Server configuration JSON").fill('{"enabled":false}')
    await page.getByLabel("Secret field name").fill("TOKEN")
    await page.getByLabel("New secret value").fill("uncertain-fixture")
    await page.getByRole("button", { name: "Set pending secret replacement", exact: true }).click()
    if (method === "PUT")
      await page
        .getByRole("button", { name: "Save MCP configuration and apply", exact: true })
        .click()
    else {
      await page.getByRole("button", { name: "Delete existing", exact: true }).click()
      await page.getByRole("button", { name: "Delete server and apply", exact: true }).click()
    }
    await expect(page.getByRole("alert")).toContainText("Application failed after saving")
    await expect(page.getByRole("button", { name: "Reload", exact: true })).toBeEnabled()
    await page.getByRole("button", { name: "Reload", exact: true }).click()
    await expect(
      page.getByText("Saved, but application failed. Retry application.", { exact: true }),
    ).toBeVisible()
    await page.getByText("Revision details", { exact: true }).click()
    await expect(page.getByText("Saved 2 · Applied 1 · failed", { exact: false })).toBeVisible()
    const checkDraft = async () => {
      await expect(page.getByLabel("MCP server name")).toHaveValue("existing")
      await expect(page.getByLabel("Server configuration JSON")).toHaveValue('{"enabled":false}')
      await expect(page.getByText("Pending MCP configuration", { exact: true })).toBeVisible()
      await expect(page.getByText("Pending secret fields:", { exact: false })).toContainText(
        "TOKEN",
      )
      await expect(page.getByLabel("Server configuration JSON")).not.toHaveValue(
        /uncertain-fixture/,
      )
      expect(
        await page.evaluate(() => {
          const event = new Event("beforeunload", { cancelable: true })
          window.dispatchEvent(event)
          return event.defaultPrevented
        }),
      ).toBe(true)
    }
    await checkDraft()
    await page.getByRole("button", { name: "Retry application", exact: true }).click()
    await expect(page.getByText("Saved revision applied.", { exact: true })).toBeVisible()
    await checkDraft()
    expect(attempts).toBe(1)
  })
}

for (const destination of ["Access", "Model Providers"]) {
  test(`closes the known-chat portal on navigation to ${destination} without moving focus to a hidden trigger`, async ({
    page,
  }) => {
    await setup(page)
    const trigger = page.getByRole("button", { name: "Known chat", exact: true })
    await trigger.click()
    await expect(page.getByRole("dialog", { name: "Choose known chat" })).toBeVisible()
    const navigation = page.getByRole("button", { name: destination, exact: true })
    await navigation.click()
    await expect(page.getByRole("dialog", { name: "Choose known chat" })).toHaveCount(0)
    await expect(navigation).toBeFocused()
    await page.getByRole("button", { name: "Chats", exact: true }).click()
    await expect(trigger).toBeVisible()
    await expect(page.getByRole("dialog", { name: "Choose known chat" })).toHaveCount(0)
  })
}

test("dismisses chat search with Escape and outside click, restoring focus for Escape", async ({
  page,
}) => {
  await setup(page)
  const trigger = page.getByRole("button", { name: "Known chat", exact: true })
  await trigger.click()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog", { name: "Choose known chat" })).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await trigger.click()
  await page.getByRole("heading", { name: "Find a chat", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Choose known chat" })).toHaveCount(0)
})

test("closes provider search on navigation without clearing its model draft", async ({ page }) => {
  await setup(page)
  await page.getByRole("button", { name: "Model Providers", exact: true }).click()
  await chooseModel(page)
  await page.getByRole("button", { name: "Provider", exact: true }).click()
  await page.getByRole("button", { name: "Chats", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Choose provider", exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "Model Providers", exact: true }).click()
  await expect(page.getByRole("button", { name: "Model", exact: true })).toContainText("Other")
})

test("shows truthful chat search scope, unknown names, and no-results states on a narrow viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await setup(page)
  await page.route("**/api/chats?*", (route) =>
    route.fulfill({
      json: [
        { id: 42, name: "42", type: "private" },
        { id: -100, name: "", type: "supergroup" },
      ],
    }),
  )
  await page.reload()
  await expect(page.getByRole("heading", { name: "Select a chat", exact: true })).toBeVisible()
  await expect(page.getByText("Search covers this page", { exact: false })).toBeVisible()
  const search = page.getByLabel("Search this page", { exact: true })
  await search.fill("missing")
  await expect(page.getByText("No chats match on this page.", { exact: false })).toBeVisible()
  await search.fill("-100")
  const row = page.getByRole("button").filter({ hasText: "Unnamed supergroup" })
  await row.focus()
  await page.keyboard.press("Enter")
  const detail = page.getByRole("region", { name: "Chat details" })
  await expect(detail.getByRole("heading", { name: "Unnamed supergroup" })).toBeVisible()
  await expect(detail).toContainText("Access approval is missing.")
  await expect(detail).toContainText("Configured locally; remote authentication not checked here.")
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
  await detail.getByRole("button", { name: "Review access approval" }).click()
  await expect(page.getByRole("heading", { name: "Access for chat -100" })).toBeVisible()
  await expect(page.getByLabel("Search group and channel access")).toHaveValue("-100")
})

test("summarizes effective draft states without remote checks or implicit writes", async ({
  page,
}) => {
  await setup(page)
  const writes: string[] = []
  page.on("request", (r) => {
    if (r.method() !== "GET") writes.push(r.url())
  })
  await page.route("**/api/settings", (route) =>
    route.fulfill({
      json: {
        revision: 1,
        applied: 1,
        status: "applied",
        policy: {
          ...policy,
          chats: {
            "42": {
              tools: [],
              servers: null,
              models: null,
              model: null,
              thinking: null,
              enabled: false,
            },
          },
        },
      },
    }),
  )
  await page.route("**/api/inventory", (route) =>
    route.fulfill({
      json: { ...inventory, providers: [{ ...inventory.providers[0], configured: false }] },
    }),
  )
  await page.reload()
  await page.getByRole("button").filter({ hasText: "Fixture chat" }).first().click()
  const detail = page.getByRole("region", { name: "Chat details" })
  await expect(detail).toContainText("Not allowed")
  await expect(detail).toContainText("None · Explicit override")
  await expect(detail).toContainText("fixture/test · Shared default")
  await expect(detail).toContainText("Model authentication is not configured.")
  await expect(detail.getByRole("button", { name: "Configure authentication" })).toBeVisible()
  await detail.getByRole("checkbox", { name: "Chat enabled", exact: true }).check()
  await expect(detail).toContainText("Policy draft preview")
  await expect(detail).toContainText("Saved access: Not allowed")
  await expect(page.getByText("1 pending policy changes", { exact: true })).toBeVisible()
  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "Discard policy changes", exact: true }).click()
  await expect(
    detail.getByRole("checkbox", { name: "Chat enabled", exact: true }),
  ).not.toBeChecked()
  expect(writes).toEqual([])
})

test("paginates chats without reloading settings or dropping cross-section drafts", async ({
  page,
}) => {
  await setup(page)
  const first = Array.from({ length: 100 }, (_, i) => ({
    id: i + 1,
    name: `Chat ${i + 1}`,
    type: "private",
  }))
  await page.route("**/api/chats?*", (route) =>
    route.fulfill({
      json:
        new URL(route.request().url()).searchParams.get("offset") === "100"
          ? [{ id: 101, name: "Next page chat", type: "private" }]
          : first,
    }),
  )
  await page.reload()
  await page.getByRole("button", { name: "Access", exact: true }).click()
  await page.getByRole("button", { name: "Revoke access for ID 42", exact: true }).click()
  await page.getByRole("button", { name: "Chats", exact: true }).click()
  await page.getByRole("button", { name: "Next chats", exact: true }).click()
  await expect(page.getByRole("button").filter({ hasText: "Next page chat" })).toBeVisible()
  await expect(page.getByText("1 pending policy changes", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Access", exact: true }).click()
  await expect(page.getByText("Pending revocation", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Undo revocation for 42", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Apply policy changes", exact: true }),
  ).toBeDisabled()
})

test("policy discard leaves provider and MCP drafts unchanged", async ({ page }) => {
  await setup(page)
  await page.getByRole("button", { name: "Model Providers", exact: true }).click()
  await chooseModel(page)
  await page.getByRole("button", { name: "Tools / MCP", exact: true }).click()
  await page.getByLabel("MCP server name", { exact: true }).fill("local-draft")
  await page.getByRole("button", { name: "Access", exact: true }).click()
  await page.getByRole("button", { name: "Revoke access for ID 42", exact: true }).click()
  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "Discard policy changes", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Revoke access for ID 42", exact: true }),
  ).toBeVisible()
  await page.getByRole("button", { name: "Tools / MCP", exact: true }).click()
  await expect(page.getByLabel("MCP server name", { exact: true })).toHaveValue("local-draft")
  await page.getByRole("button", { name: "Model Providers", exact: true }).click()
  await expect(page.getByRole("button", { name: "Model", exact: true })).toContainText("Other")
})

test("handles chat loading, errors, retry, and empty results independently of settings", async ({
  page,
}) => {
  await setup(page)
  let finish!: () => void
  const wait = new Promise<void>((resolve) => {
    finish = resolve
  })
  await page.route("**/api/chats?*", async (route) => {
    await wait
    await route.fulfill({ status: 500, json: { error: "Chat list unavailable" } })
  })
  await page.reload()
  await expect(page.getByText("Loading chats…", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Access", exact: true })).toBeEnabled()
  finish()
  await expect(page.getByRole("alert")).toContainText("Chat list unavailable")
  await page.route("**/api/chats?*", (route) => route.fulfill({ json: [] }))
  await page.getByRole("button", { name: "Retry chats", exact: true }).click()
  await expect(page.getByText("No chats observed on this page.", { exact: false })).toBeVisible()
})

for (const missingProvider of [false, true]) {
  test(`distinguishes ${missingProvider ? "unknown authentication" : "disabled model provider"} from verified failure`, async ({
    page,
  }) => {
    await setup(page)
    await page.route("**/api/inventory", (route) =>
      route.fulfill({
        json: { ...inventory, providers: missingProvider ? [] : inventory.providers },
      }),
    )
    await page.route("**/api/settings", (route) =>
      route.fulfill({
        json: {
          revision: 1,
          applied: 1,
          status: "applied",
          policy: {
            ...policy,
            providers: missingProvider ? [] : [{ id: "fixture", enabled: false, models: [] }],
          },
        },
      }),
    )
    await page.reload()
    await page.getByRole("button").filter({ hasText: "Fixture chat" }).first().click()
    const detail = page.getByRole("region", { name: "Chat details" })
    await expect(detail).toContainText(
      missingProvider
        ? "Configuration status unknown; remote authentication not checked here."
        : "No allowed model",
    )
    await expect(
      detail.getByRole("button", {
        name: missingProvider ? "Review authentication configuration" : "Configure model",
        exact: true,
      }),
    ).toBeVisible()
    await expect(detail).not.toContainText("Authentication failed")
  })
}
