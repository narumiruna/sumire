import { generateKeyPairSync } from "node:crypto"
import { effectivePolicy, inherited } from "@narumitw/sumire-policy"
import { expect, type Page, type Route, test } from "@playwright/test"
import {
  closeConnectionEditor,
  openChatConfiguration,
  openConnectionEditor,
  openDirectoryFilters,
  openDisclosure,
  openGlobalLimits,
  sectionLabel,
} from "./admin-fixture.js"

function chatResponse(route: Route, chats: { id: number; name: string; type: string }[]) {
  const url = new URL(route.request().url())
  const id = url.searchParams.get("id")
  if (id !== null) return route.fulfill({ json: chats.filter((chat) => String(chat.id) === id) })
  const query = (url.searchParams.get("q") ?? "").trim().toLowerCase()
  const offset = Number(url.searchParams.get("offset") ?? 0)
  return route.fulfill({
    json: chats
      .filter((chat) => chat.name.toLowerCase().includes(query) || String(chat.id) === query)
      .slice(offset, offset + 100),
  })
}

const policy = {
  skills: [],
  tools: ["read_url_content"],
  servers: [],
  models: ["fixture/test"],
  defaults: {
    skills: [],
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
  builtInTools: ["read_url_content", "bash"],
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
async function navigate(page: Page, name: string) {
  await expect(
    page.getByRole("complementary", { name: "Administration navigation", exact: true }),
  ).toBeVisible()
  const link = page.getByRole("link", {
    name: sectionLabel(name),
    exact: true,
  })
  const menu = page.getByRole("button", { name: /Sections ·/ })
  if (!(await link.isVisible()) && (await menu.isVisible())) await menu.click()
  await link.click()
  if (name === "Tool permissions") await openGlobalLimits(page)
  if (name === "Model Providers") {
    await openDisclosure(page, "Saved model settings")
    if (await page.locator(".provider-authentication").count())
      await openDisclosure(page, "Authentication")
  }
  if (name === "MCP connections") await openConnectionEditor(page)
  if (name === "Defaults") {
    if ((await page.locator("#default-models-options").locator("..").getAttribute("open")) === null)
      await page.locator("#default-models-options").click()
    await openDisclosure(page, "Advanced actions")
  }
  if (name === "Audit") await openDisclosure(page, "Filters")
  if (name === "Tool permissions") {
    await openDisclosure(page, "Approve an exact tool name")
    await openDisclosure(page, "Permission rules and inheritance")
    await page.getByRole("button", { name: "Expand all", exact: true }).click()
  }
}
async function openMcpJson(page: Page) {
  if (!(await page.getByLabel("Server configuration JSON").isVisible()))
    await page.getByText("Advanced server configuration JSON", { exact: true }).click()
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
    else if (url.pathname === "/api/chats") {
      await chatResponse(route, [{ id: 42, name: "Fixture chat", type: "private" }])
      return
    } else if (url.pathname === "/api/audit") data = []
    else if (url.pathname === "/api/providers/fixture/credential") {
      expect(route.request().postDataJSON().revision).toBe(revision)
      expect(route.request().headers()["x-csrf-token"]).toBe("browser-fixture")
      revision++
    }
    await route.fulfill({ json: data })
  })
  await page.goto("/")
}
for (const width of [1440, 390]) {
  test(`keeps setup and scoped policy actions clear at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    await setup(page)
    await page.route("**/api/inventory", (route) =>
      route.fulfill({
        json: {
          ...inventory,
          providers: [{ ...inventory.providers[0], configured: false }],
        },
      }),
    )
    await page.route("**/api/chats?*", (route) =>
      chatResponse(route, [
        { id: 42, name: "Fixture chat", type: "private" },
        { id: -1001234567890, name: "", type: "supergroup" },
      ]),
    )
    await page.reload()
    await expect(page.getByRole("region", { name: "Pending changes", exact: true })).toHaveCount(0)
    await expect(
      page.getByRole("button", { name: "Review and save changes", exact: true }),
    ).toHaveCount(0)
    const row = page.getByRole("list", { name: "Chats on this page" }).getByRole("button").last()
    const metadata = row.locator(".directory-chat-meta")
    await expect(metadata.getByText("supergroup", { exact: true })).toBeVisible()
    const id = metadata.locator("code")
    await expect(id).toHaveText("-1001234567890")
    expect(
      await id.evaluate((element) => {
        const range = document.createRange()
        range.selectNodeContents(element)
        return range.getClientRects().length
      }),
    ).toBe(1)
    const idBox = await id.boundingBox()
    const rowBox = await row.boundingBox()
    if (!idBox || !rowBox) throw new Error("Missing chat ID geometry")
    expect(idBox.x).toBeGreaterThanOrEqual(rowBox.x)
    expect(idBox.x + idBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width)
    expect(idBox.y).toBeGreaterThanOrEqual(rowBox.y)
    expect(idBox.y + idBox.height).toBeLessThanOrEqual(rowBox.y + rowBox.height)
    if (width > 850)
      expect((await page.locator(".chat-directory").boundingBox())?.width).toBeGreaterThanOrEqual(
        290,
      )
    await page.getByRole("button").filter({ hasText: "Fixture chat" }).first().click()
    const status = page.getByRole("region", { name: "Chat setup status" })
    await expect(status).toContainText("Setup required")
    await page.locator(".setup-details > summary").click()
    await expect(page.locator(".setup-details")).toContainText("This chat is approved by policy.")
    await expect(page.locator(".setup-details")).toContainText("Runtime availability is unchecked")
    await expect(status.getByRole("button", { name: "Configure authentication" })).toBeVisible()
    await expect(
      status.getByText("Model authentication is not configured.", { exact: true }),
    ).toHaveCount(1)
    const statusBox = await status.boundingBox()
    const tabsBox = await page.getByRole("tablist").boundingBox()
    if (!statusBox || !tabsBox) throw new Error("Missing status or tabs geometry")
    expect(statusBox.y + statusBox.height).toBeLessThanOrEqual(tabsBox.y)
    await page.screenshot({ path: testInfo.outputPath(`setup-${width}.png`), fullPage: true })
    await page.getByRole("button", { name: "Manage access", exact: true }).click()
    await page
      .getByRole("tabpanel", { name: "Access", exact: true })
      .getByRole("button", { name: "Revoke access", exact: true })
      .click()
    const bar = page.getByRole("region", { name: "Pending changes", exact: true })
    await expect(bar).toContainText("1 unsaved change")
    await bar.scrollIntoViewIfNeeded()
    expect(await bar.evaluate((el) => getComputedStyle(el).position)).toBe("fixed")
    const barBox = await bar.boundingBox()
    expect(barBox?.y).toBeGreaterThanOrEqual(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`pending-${width}.png`), fullPage: true })
  })
}

test("keeps the selected tab coherent when switching chats and supports tab keys", async ({
  page,
}) => {
  await setup(page)
  await page.route("**/api/chats?*", (route) =>
    chatResponse(route, [
      { id: 42, name: "Fixture chat", type: "private" },
      { id: -100, name: "Other chat", type: "supergroup" },
    ]),
  )
  await page.reload()
  const writes: string[] = []
  page.on("request", (request) => {
    if (request.method() !== "GET") writes.push(request.url())
  })
  await page.getByRole("button").filter({ hasText: "Fixture chat" }).first().click()
  await page.getByRole("tab", { name: "Access", exact: true }).click()
  await page.getByRole("button").filter({ hasText: "Other chat" }).first().click()
  await expect(page.getByRole("tab", { name: "Access", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  )
  await expect(page.getByRole("tabpanel")).toHaveCount(1)
  await expect(page.getByRole("tabpanel")).toContainText("Group and channel access")
  await page.getByRole("tab", { name: "Access", exact: true }).focus()
  await page.keyboard.press("End")
  await expect(page.getByRole("tab", { name: "History", exact: true })).toBeFocused()
  await expect(page.getByRole("tabpanel", { name: "History", exact: true })).toBeVisible()
  await page.keyboard.press("Home")
  await expect(page.getByRole("tabpanel", { name: "Overview", exact: true })).toBeVisible()
  expect(writes).toEqual([])
})

test("provider workflow separates local authentication from model saving", async ({ page }) => {
  await setup(page)
  await page.route("**/api/inventory", (route) =>
    route.fulfill({
      json: {
        ...inventory,
        providers: [{ ...inventory.providers[0], configured: false }],
      },
    }),
  )
  await page.reload()
  const writes: string[] = []
  page.on("request", (request) => {
    if (request.method() !== "GET") writes.push(request.url())
  })
  await navigate(page, "Model Providers")
  await expect(
    page
      .getByRole("region", { name: "Provider", exact: true })
      .getByText("Authentication required", { exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Configure authentication", exact: true }),
  ).toBeVisible()
  await openDisclosure(page, "Credential checks")
  await expect(page.getByText("Model availability is unverified.", { exact: false })).toBeVisible()
  await chooseModel(page)
  await expect(
    page.getByRole("button", { name: "Save model availability", exact: true }),
  ).toBeEnabled()
  await page.getByRole("button", { name: "Edit shared default", exact: true }).click()
  await expect(
    page.getByRole("combobox", { name: "Shared default model", exact: true }),
  ).toBeVisible()
  await expect(page.locator("#save-status")).toContainText("Provider: Unsaved selection")
  await expect(page.getByRole("region", { name: "Pending changes", exact: true })).toContainText(
    "Unsubmitted editor draft",
  )
  expect(writes).toEqual([])
})

test("chat tab clicks and contextual links select exactly one matching panel", async ({ page }) => {
  await setup(page)
  await page.getByRole("button").filter({ hasText: "Fixture chat" }).first().click()
  for (const name of ["Model & Tools", "Access", "History", "Overview"]) {
    await page.getByRole("tab", { name, exact: true }).click()
    await expect(page.getByRole("tab", { name, exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    )
    await expect(page.getByRole("tabpanel")).toHaveCount(1)
    await expect(page.getByRole("tabpanel", { name, exact: true })).toBeVisible()
  }
  await page.getByRole("button", { name: "Manage access", exact: true }).click()
  await expect(page.getByRole("tab", { name: "Access", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  )
  await expect(page.getByRole("tabpanel", { name: "Access", exact: true })).toBeVisible()
  await page.getByRole("tab", { name: "Overview", exact: true }).click()
  await page.getByRole("button", { name: "Change model", exact: true }).click()
  await expect(page.getByRole("tabpanel", { name: "Model & Tools", exact: true })).toBeVisible()
})

test("shows the model conflict beside its allowed list", async ({ page }) => {
  await setup(page)
  await navigate(page, "Defaults")
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
  const inherited = {
    tools: null,
    skills: null,
    servers: null,
    models: null,
    model: null,
    thinking: null,
  }
  const original = {
    ...structuredClone(policy),
    groups: [-100],
    chats: {
      "42": { ...inherited, tools: [], model: "fixture/test", enabled: true },
      "-100": { ...inherited, models: [], thinking: "high", enabled: false },
      "999": { ...inherited, servers: [], skills: [], enabled: true },
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
  await navigate(page, "Defaults")
  const bulk = page.getByRole("button", {
    name: "Reset all chats to inherit defaults",
    exact: true,
  })
  await bulk.click()
  await expect(page.getByRole("alertdialog")).toContainText(
    "3 chats have explicit overrides in the policy draft.",
  )
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Review and save changes", exact: true }),
  ).toHaveCount(0)
  await bulk.click()
  await page.getByRole("button", { name: "Stage reset of all chat overrides", exact: true }).click()
  expect(writes).toBe(0)
  await expect(bulk).toBeDisabled()
  await page.getByRole("button", { name: "Review and save changes", exact: true }).click()
  await page.getByRole("button", { name: "Save changes", exact: true }).click()
  await expect(page.getByText("Settings saved and applied.", { exact: true })).toBeVisible()
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
  await page.getByRole("button", { name: /^Provider: / }).click()
  await page.getByRole("combobox", { name: "Search provider" }).fill("fixt")
  await page.getByRole("combobox", { name: "Search provider" }).press("Enter")
}
async function chooseModel(page: Page, query = "Other") {
  await page.getByRole("button", { name: /^Model: / }).click()
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
    await navigate(page, "Access")
    await page.getByRole("button", { name: "Revoke access for ID 42" }).click()
    await navigate(page, "Model Providers")
    await page.getByText("Custom endpoint", { exact: true }).click()
    if (existing)
      await page.getByRole("button", { name: "Edit configuration custom", exact: true }).click()
    await page.getByLabel("Provider ID", { exact: true }).fill("abandoned")
    await page.getByLabel("Model ID (required for custom endpoint)").fill("abandoned-model")
    await page.getByRole("button", { name: "Add / update model", exact: true }).click()
    await expect(
      page.getByRole("button", { name: "Review and save changes", exact: true }),
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
      page.getByRole("button", { name: "Review and save changes", exact: true }),
    ).toBeEnabled()
    await expect(page.getByText(/\d+ unsaved changes?/).first()).toBeVisible()
    await navigate(page, "Access")
    await expect(page.getByRole("button", { name: "Revoke access for ID 42" })).toHaveCount(0)
    expect(mutations).toEqual([])
    page.once("dialog", (dialog) => dialog.accept())
    await page.getByRole("button", { name: "Discard settings changes", exact: true }).click()
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
    await navigate(page, "MCP connections")
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
    await closeConnectionEditor(page)
    await closeConnectionEditor(page)
    await page.getByRole("button", { name: "Edit fields for existing", exact: true }).click()
    await expect(name).toHaveValue("existing-v2")
    await expect(json).toHaveValue(draft)
    page.once("dialog", (dialog) => dialog.accept())
    await closeConnectionEditor(page)
    await closeConnectionEditor(page)
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
    await navigate(page, "MCP connections")
    await closeConnectionEditor(page)
    await closeConnectionEditor(page)
    await page.getByRole("button", { name: "Edit fields for existing", exact: true }).click()
    await expect(page.getByLabel("Server configuration JSON")).toHaveValue("{}")
    await page.getByText("Secret preservation and transport rules", { exact: true }).click()
    await expect(page.getByText("Omitted keys are removed.", { exact: false })).toBeVisible()
    await openMcpJson(page)
    const scope = transport === "stdio" ? "env" : "headers"
    await page
      .getByLabel("Server configuration JSON")
      .fill(JSON.stringify({ [scope]: { TOKEN_A: null } }))
    const saving = page.waitForRequest(
      (r) => r.url().endsWith("/api/mcp/existing") && r.method() === "PUT",
    )
    await page.getByRole("button", { name: "Save connection" }).click()
    expect((await saving).postDataJSON().config).toEqual({ [scope]: { TOKEN_A: null } })
  })
}

test("unauthorized visitor sees only passkey sign-in", async ({ page }) => {
  await setup(page, false)
  await expect(page.getByRole("button", { name: "Sign in with passkey" })).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Review and save changes", exact: true }),
  ).toHaveCount(0)
})
test("registers and signs in with a browser passkey without Telegram Web Login", async ({
  page,
  context,
}) => {
  await setup(page, false)
  const localUrl = new URL(page.url())
  localUrl.hostname = "localhost"
  const origin = localUrl.origin
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
    expect(route.request().headers().origin).toBe(origin)
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
  await page.goto(`${origin}/#setup=${"s".repeat(43)}`)
  await expect(page.getByRole("button", { name: "Register passkey" })).toBeVisible()
  await expect(page).toHaveURL(`${origin}/`)
  await page.getByRole("button", { name: "Register passkey" }).click()
  await expect(page.getByRole("button", { name: "Account", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Account", exact: true }).click()
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click()
  await page.getByRole("button", { name: "Sign in with passkey" }).click()
  await expect(page.getByRole("button", { name: "Account", exact: true })).toBeVisible()
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
  await navigate(page, "MCP connections")
  await closeConnectionEditor(page)
  await page.getByRole("button", { name: "Actions for obsolete", exact: true }).click()
  await page.getByRole("menuitem", { name: "Delete obsolete", exact: true }).click()
  await expect(page.getByRole("alertdialog")).toContainText("inline credentials")
  await expect(page.getByRole("alertdialog")).toContainText(
    "Referenced runtime values remain in Secrets & variables",
  )
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  expect(attempts).toBe(0)
  await closeConnectionEditor(page)
  await page.getByRole("button", { name: "Actions for obsolete", exact: true }).click()
  await page.getByRole("menuitem", { name: "Delete obsolete", exact: true }).click()
  await page.getByRole("button", { name: "Delete server and apply", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("Settings changed; reload")
  await expect(
    page.getByRole("button", { name: "Actions for obsolete", exact: true }),
  ).toBeVisible()
  await closeConnectionEditor(page)
  await page.getByRole("button", { name: "Actions for obsolete", exact: true }).click()
  await page.getByRole("menuitem", { name: "Delete obsolete", exact: true }).click()
  await page.getByRole("button", { name: "Delete server and apply", exact: true }).click()
  await expect(page.getByRole("button", { name: "Actions for obsolete", exact: true })).toHaveCount(
    0,
  )
  expect(attempts).toBe(2)
})

test("edits private access and saves with a confirmation", async ({ page }) => {
  await setup(page)
  await navigate(page, "Access")
  await page.getByLabel("Telegram ID to approve").fill("43")
  await page.getByRole("button", { name: "Review approval" }).click()
  await expect(page.getByRole("alertdialog")).toBeVisible()
  await page.getByRole("button", { name: "Save changes" }).click()
  await expect(page.getByText("Settings saved and applied.", { exact: true })).toBeVisible()
})
test("shows inherited chat settings and supported thinking levels", async ({ page }) => {
  await setup(page)
  await page.getByRole("list", { name: "Chats on this page" }).getByRole("button").first().click()
  await openChatConfiguration(page)
  await expect(page.getByRole("checkbox", { name: "Inherit default" }).first()).toBeChecked()
  await page.getByRole("combobox", { name: "Thinking level", exact: true }).click()
  await expect(page.getByRole("option", { name: "low", exact: true })).toBeVisible()
  await expect(page.getByRole("option", { name: "high", exact: true })).toHaveCount(0)
  await page.getByRole("option", { name: "low", exact: true }).click()
  await expect(page.getByText(/\d+ unsaved changes?/).first()).toBeVisible()
})
for (const state of ["inherited", "empty", "globally unavailable", "disabled provider"] as const) {
  test(`keeps raw model selections and shared effective values when ${state}`, async ({ page }) => {
    await setup(page)
    const selectedPolicy = {
      ...policy,
      models: state === "globally unavailable" ? [] : policy.models,
      defaults: { ...policy.defaults, thinking: "low" as const },
      providers: [{ id: "fixture", enabled: state !== "disabled provider", models: [] }],
      chats: {
        "42": {
          ...inherited,
          enabled: true,
          model: "fixture/test",
          models: state === "inherited" ? null : state === "empty" ? [] : ["fixture/test"],
        },
      },
    }
    await page.route("**/api/settings", (route) =>
      route.fulfill({
        json: { revision: 1, applied: 1, status: "applied", policy: selectedPolicy },
      }),
    )
    await page.reload()
    await page.getByRole("list", { name: "Chats on this page" }).getByRole("button").first().click()
    await openChatConfiguration(page)
    const effective = effectivePolicy(selectedPolicy, 42)
    const models = page.getByRole("group", { name: "Allowed models", exact: true })
    await expect(
      models.getByText(state === "inherited" ? "From shared defaults" : "This chat override", {
        exact: true,
      }),
    ).toBeVisible()
    await expect(
      models.getByText(`Effective: ${effective.models.join(", ") || "None"}`, { exact: true }),
    ).toBeVisible()
    await expect(page.locator("#model-selection-source")).toContainText("This chat override")
    await expect(page.locator("#model-selection-source")).toContainText(
      `Effective model: ${effective.model ?? "No allowed model"}.`,
    )
    await expect(page.locator("#thinking-selection-source")).toContainText("From shared defaults")
    await expect(page.locator("#thinking-selection-source")).toContainText(
      `Effective thinking: ${effective.thinking}.`,
    )
    await expect(
      page.getByRole("combobox", { name: "Chat model override", exact: true }),
    ).toContainText("fixture/test")
    if (state !== "empty" && state !== "inherited")
      await expect(models.getByRole("checkbox", { name: /fixture\/test/ })).toBeChecked()
    await expect(
      page.getByRole("button", { name: "Review and save changes", exact: true }),
    ).toHaveCount(0)
  })
}

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
  await navigate(page, "Model Providers")
  await expect(page.getByRole("button", { name: /^Provider: / })).toHaveText(/Fixture/)
  await expect(page.getByRole("button", { name: /^Model: / })).toHaveText(/Test/)
  await expect(page.getByRole("combobox", { name: "Thinking level" })).toHaveCount(0)
  await expect(
    page.locator(".provider-current-summary").getByText("low", { exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "Add an available model", exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: /Save default model|Save model availability/ }),
  ).toBeDisabled()
  expect(mutations).toBe(0)
})

test("updates untouched provider fields when saved settings are reloaded", async ({ page }) => {
  await setup(page)
  let current = structuredClone(policy)
  await page.route("**/api/settings", (route) =>
    route.fulfill({ json: { revision: 2, applied: 2, status: "applied", policy: current } }),
  )
  await page.reload()
  await navigate(page, "Model Providers")
  await expect(page.getByRole("button", { name: /^Model: / })).toHaveText(/Test/)
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
  await expect(page.getByRole("button", { name: /^Model: / })).toHaveText(/Other model/)
  await expect(
    page.getByRole("heading", { name: "Add an available model", exact: true }),
  ).toBeVisible()
})

test("keeps a local preview on refresh and restores saved values on request", async ({ page }) => {
  await setup(page)
  await navigate(page, "Model Providers")
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
  await expect(page.getByRole("button", { name: /^Model: / })).toHaveText(/Other model/)
  await page.getByRole("button", { name: "Use saved selection", exact: true }).click()
  await expect(page.getByRole("button", { name: /^Model: / })).toHaveText(/Test/)
  await expect(page.getByRole("combobox", { name: "Thinking level" })).toHaveCount(0)
  await expect(
    page.locator(".provider-current-summary").getByText("low", { exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "Add an available model", exact: true }),
  ).toBeVisible()
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
  await navigate(page, "Model Providers")
  await expect(page.getByRole("button", { name: /^Provider: / })).toHaveText(/Fixture/)
  await expect(page.getByRole("button", { name: /^Model: / })).toHaveText(/Other model/)
  await expect(
    page.getByRole("heading", { name: "Add an available model", exact: true }),
  ).toBeVisible()
  await expect(page.getByText("Existing chat model:", { exact: false })).toContainText(
    "fixture/other",
  )
  await page.getByText("Chat-specific models (1)", { exact: true }).click()
  await expect(page.locator(".provider-advanced").getByRole("listitem")).toContainText(
    "Chat 42: fixture/other",
  )
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
  await navigate(page, "Model Providers")
  await expect(page.getByRole("button", { name: /^Provider: / })).toHaveText(/Fixture/)
  await expect(page.getByRole("button", { name: /^Model: / })).toHaveText(/Choose model/)
  await page.getByText("Chat-specific models (2)", { exact: true }).click()
  await expect(page.locator(".provider-advanced").getByRole("listitem")).toHaveCount(2)
  await expect(
    page.getByRole("button", { name: /Save default model|Save model availability/ }),
  ).toHaveCount(0)
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
  await navigate(page, "Model Providers")
  await expect(page.getByRole("button", { name: /^Provider: / })).toHaveText(/missing/)
  await expect(page.getByText("The selected provider missing", { exact: false })).toBeVisible()
  await expect(
    page.getByRole("button", { name: /Save default model|Save model availability/ }),
  ).toHaveCount(0)
})

test("searches built-in catalogs and adds only the selected model", async ({ page }) => {
  await setup(page)
  await navigate(page, "Model Providers")
  await chooseProvider(page)
  await expect(page.getByLabel("Provider ID", { exact: true })).not.toBeVisible()
  await chooseModel(page)
  await expect(page.getByText("No reasoning", { exact: true })).toBeVisible()
  await expect(page.getByRole("combobox", { name: "Thinking level" })).toHaveCount(0)
  await page.getByRole("button", { name: /Save default model|Save model availability/ }).click()
  const saving = page.waitForRequest(
    (r) => r.url().endsWith("/api/settings") && r.method() === "PUT",
  )
  await page.getByRole("button", { name: "Save changes", exact: true }).click()
  expect((await saving).postDataJSON()).toEqual({
    revision: 1,
    policy: { ...policy, models: ["fixture/test", "fixture/other"] },
  })
  await expect(page.getByText("Settings saved and applied.", { exact: true })).toBeVisible()
})

test("sets default thinking only after explicit selection and confirmation", async ({ page }) => {
  await setup(page)
  await navigate(page, "Defaults")
  await page.getByRole("combobox", { name: "Shared default thinking", exact: true }).click()
  await expect(page.getByRole("option", { name: "high", exact: true })).toHaveCount(0)
  await page.getByRole("option", { name: "low", exact: true }).click()
  await page.getByRole("button", { name: "Review and save changes", exact: true }).click()
  await expect(page.getByRole("alertdialog")).toContainText("Thinking level")
  const saving = page.waitForRequest(
    (r) => r.url().endsWith("/api/settings") && r.method() === "PUT",
  )
  await page.getByRole("button", { name: "Save changes", exact: true }).click()
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
  await navigate(page, "Model Providers")
  await chooseProvider(page)
  await chooseModel(page)
  await page.getByRole("button", { name: "Configure authentication" }).click()
  await expect(page.getByRole("button", { name: "Sign in with account" })).toHaveCount(0)
  await page.getByLabel("API key", { exact: true }).fill("fixture-secret")
  const saving = page.waitForRequest((r) => r.url().endsWith("/api/providers/fixture/credential"))
  await page.getByRole("button", { name: "Save API key", exact: true }).click()
  expect((await saving).postDataJSON()).toEqual({ key: "fixture-secret", revision: 1 })
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page.getByRole("button", { name: /^Model: / })).toHaveText(/Other model/)
  await expect(page.getByText("Saved revision applied.", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Configure authentication" }).click()
  await expect(page.getByLabel("API key", { exact: true })).toHaveValue("")
})

test("blocks credential and model saves while other policy edits are unsaved", async ({ page }) => {
  await setup(page)
  await navigate(page, "Tool permissions")
  await page.getByRole("checkbox", { name: "Globally allow tool bash", exact: true }).check()
  await navigate(page, "Model Providers")
  await chooseProvider(page)
  await chooseModel(page)
  await expect(page.getByRole("button", { name: "Configure authentication" })).toBeDisabled()
  await expect(
    page.getByRole("button", { name: /Save default model|Save model availability/ }),
  ).toBeDisabled()
  await navigate(page, "Tool permissions")
  await expect(
    page.getByRole("checkbox", { name: "Globally allow tool bash", exact: true }),
  ).toBeChecked()
})

test("retains the selected model after a revision conflict", async ({ page }) => {
  await setup(page)
  await page.route("**/api/settings", (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({ status: 409, json: { error: "Settings changed; reload before saving" } })
      : route.fallback(),
  )
  await navigate(page, "Model Providers")
  await chooseProvider(page)
  await chooseModel(page)
  await page.getByRole("button", { name: /Save default model|Save model availability/ }).click()
  await page.getByRole("button", { name: "Save changes", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("Settings changed")
  await expect(page.getByRole("button", { name: /^Model: / })).toHaveText(/Other model/)
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
  await navigate(page, "Model Providers")
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
  await expect(page.getByText("Settings saved and applied.", { exact: true })).toBeVisible()
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
  await navigate(page, "Model Providers")
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
  await navigate(page, "Model Providers")
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
  await navigate(page, "Model Providers")
  await chooseProvider(page)
  await chooseModel(page)
  await page.getByRole("button", { name: "Configure authentication" }).click()
  await page.getByLabel("API key", { exact: true }).fill("fixture-secret")
  await page.getByRole("button", { name: "Save API key", exact: true }).click()
  await expect(
    page.getByText("The selected model is no longer in the catalog.", { exact: false }),
  ).toBeVisible()
  await expect(page.getByRole("button", { name: /^Model: / })).toHaveText(/other/)
  await expect(
    page.getByRole("button", { name: /Save default model|Save model availability/ }),
  ).toHaveCount(0)
})

test("keeps removed approved models available to undo an unsaved edit", async ({ page }) => {
  await setup(page)
  await navigate(page, "Model Providers")
  await expect(
    page.getByRole("region", { name: "Manage model availability", exact: true }),
  ).toBeVisible()
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
  const saved = { ...policy, defaults: { ...policy.defaults, thinking: "low" } }
  await page.route("**/api/settings", (route) =>
    route.fulfill({ json: { revision: 1, applied: 1, status: "applied", policy: saved } }),
  )
  await page.route("**/api/inventory", (route) =>
    route.fulfill({
      json: {
        ...inventory,
        providers: [
          {
            ...inventory.providers[0],
            oauth: false,
            models: inventory.providers[0]?.models.map((model) => ({
              ...model,
              thinking: changed ? ["off"] : model.thinking,
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
  await navigate(page, "Model Providers")
  await page.getByRole("button", { name: "Configure authentication", exact: true }).click()
  await page.getByLabel("API key", { exact: true }).fill("fixture-secret")
  await page.getByRole("button", { name: "Save API key", exact: true }).click()
  await navigate(page, "Defaults")
  const thinking = page.getByRole("combobox", { name: "Shared default thinking", exact: true })
  await expect(thinking).toContainText("low")
  await expect(
    page.getByRole("alert").filter({ hasText: "Choose a supported thinking level" }),
  ).toBeVisible()
  await expect(page.locator("#save-status")).not.toContainText("unsaved change")
  await thinking.click()
  await page.getByRole("option", { name: "off", exact: true }).click()
  await expect(
    page.getByText("Choose a supported thinking level before saving.", { exact: true }),
  ).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "Review and save changes", exact: true }),
  ).toBeEnabled()
})

test("provider search works with the keyboard on narrow screens", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await setup(page)
  await navigate(page, "Model Providers")
  await chooseProvider(page)
  await page.getByRole("button", { name: /^Model: / }).click()
  const search = page.getByRole("combobox", { name: "Search model" })
  await search.fill("no-such-model")
  await expect(page.getByText("No matches.")).toBeVisible()
  await search.fill("")
  await search.press("ArrowDown")
  await search.press("Enter")
  await expect(page.getByRole("button", { name: /^Model: / })).toHaveText(/Other model/)
  await expect(page.getByRole("button", { name: /^Model: / })).toBeFocused()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
})

test("secret input is masked and credential removal needs confirmation", async ({ page }) => {
  await setup(page)
  await navigate(page, "Model Providers")
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
  await navigate(page, "Model Providers")
  await page.getByText("Custom endpoint", { exact: true }).click()
  await page.getByLabel("Provider ID", { exact: true }).fill("custom")
  await page.getByLabel("API base URL", { exact: true }).fill("https://models.example.test/v1")
  await page.getByLabel("Model ID (required for custom endpoint)").fill("one")
  await page.getByRole("button", { name: "Add / update model" }).click()
  await page.getByLabel("Model ID (required for custom endpoint)").fill("two")
  await page.getByRole("button", { name: "Set provider configuration" }).click()
  await page.getByRole("button", { name: "Review and save changes", exact: true }).click()
  const saving = page.waitForRequest(
    (r) => r.url().endsWith("/api/settings") && r.method() === "PUT",
  )
  await page.getByRole("button", { name: "Save changes" }).click()
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
  await navigate(page, "Tool permissions")
  await page.getByRole("checkbox", { name: "Globally allow tool bash", exact: true }).check()
  await page.getByRole("button", { name: "Review and save changes", exact: true }).click()
  await page.getByRole("button", { name: "Save changes" }).click()
  await expect(page.getByRole("alert")).toContainText("Settings changed")
  await expect(page.getByText(/\d+ unsaved changes?/).first()).toBeVisible()
  await expect(
    page.getByRole("checkbox", { name: "Globally allow tool bash", exact: true }),
  ).toBeChecked()
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
  await navigate(page, "Model Providers")
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
  await navigate(page, "MCP connections")
  await page.getByLabel("MCP server name").fill("fixture")
  await page.getByText("Advanced server configuration JSON", { exact: true }).click()
  await page.getByLabel("Server configuration JSON").fill('{"command":"fixture-server"}')
  await page.getByText("Secrets (optional)", { exact: true }).click()
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
  await page.getByRole("button", { name: "Save connection" }).click()
  expect((await saving).postDataJSON().config.env.TOKEN).toBe("fixture-secret")
})

test("supports narrow layouts and keyboard dialog cancellation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await setup(page)
  await navigate(page, "Tool permissions")
  await page.getByRole("checkbox", { name: "Globally allow tool bash", exact: true }).check()
  await page.getByRole("button", { name: "Review and save changes", exact: true }).click()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("alertdialog")).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "Review and save changes", exact: true }),
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
  await navigate(page, "Access")
  await page.getByLabel("Telegram ID to approve").fill("43")
  await page.getByRole("button", { name: "Review approval" }).click()
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  await navigate(page, "MCP connections")
  await page.getByLabel("MCP server name").fill("draft-server")
  await navigate(page, "Model Providers")
  await expect(page.getByRole("button", { name: "Configure authentication" })).toBeDisabled()
  await page.getByRole("button", { name: "Review and save changes", exact: true }).click()
  await expect(page.getByRole("alertdialog")).toContainText(
    "Connection drafts, provider model additions, and authentication have separate save actions",
  )
  const saving = page.waitForRequest(
    (r) => r.url().endsWith("/api/settings") && r.method() === "PUT",
  )
  await page.getByRole("button", { name: "Save changes", exact: true }).click()
  expect((await saving).postDataJSON().policy.privateUsers).toEqual([42, 43])
  await expect(page.getByText("MCP: Unsaved configuration", { exact: true })).toBeVisible()
  await navigate(page, "MCP connections")
  await expect(page.getByLabel("MCP server name")).toHaveValue("draft-server")
  expect(mutations).toEqual(["/api/settings"])
})

test("distinguishes inherited, empty, and customized chat authorization", async ({ page }) => {
  await setup(page)
  await page.getByRole("list", { name: "Chats on this page" }).getByRole("button").first().click()
  await openChatConfiguration(page)
  const tools = page.getByRole("group", { name: "Authorized tools", exact: true }).first()
  await expect(tools.getByText("From shared defaults", { exact: true })).toBeVisible()
  await expect(tools.getByText("Effective: read_url_content", { exact: true })).toBeVisible()
  await tools.getByRole("checkbox", { name: "Inherit default", exact: true }).uncheck()
  await expect(tools).toContainText("No options allowed. This does not inherit shared defaults.")
  await expect(tools.getByText("This chat override", { exact: true })).toBeVisible()
  await expect(tools.getByText("Effective: None", { exact: true })).toBeVisible()
  const save = async () => {
    await page.getByRole("button", { name: "Review and save changes", exact: true }).click()
    const pending = page.waitForRequest(
      (r) => r.url().endsWith("/api/settings") && r.method() === "PUT",
    )
    await page.getByRole("button", { name: "Save changes", exact: true }).click()
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
  await navigate(page, "Access")
  await page.getByLabel("Telegram ID to approve").fill("0")
  await page.getByRole("button", { name: "Review approval" }).click()
  await expect(page.getByRole("alert")).toContainText("non-zero whole-number")
  await page.getByLabel("Telegram ID to approve").fill("")
  await page.getByRole("button", { name: "Revoke access for ID 42", exact: true }).click()
  await page.getByRole("button", { name: "Review and save changes", exact: true }).click()
  const saving = page.waitForRequest(
    (r) => r.url().endsWith("/api/settings") && r.method() === "PUT",
  )
  await page.getByRole("button", { name: "Save changes", exact: true }).click()
  expect((await saving).postDataJSON().policy.privateUsers).toEqual([])
})

test("retains unfinished editors across sections and guards reload and sign-out", async ({
  page,
}) => {
  await setup(page)
  await navigate(page, "Access")
  await page.getByLabel("Telegram ID to approve").fill("43")
  await expect(page.getByRole("button", { name: "Reload", exact: true })).toBeDisabled()
  await navigate(page, "Defaults")
  await navigate(page, "Access")
  await expect(page.getByLabel("Telegram ID to approve")).toHaveValue("43")
  const unloadPrevented = await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  })
  expect(unloadPrevented).toBe(true)
  page.once("dialog", (dialog) => dialog.dismiss())
  await page.getByRole("button", { name: "Account", exact: true }).click()
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click()
  await expect(page.getByRole("button", { name: "Account", exact: true })).toBeVisible()
})

test("uses Shared defaults as the only shared default model editor", async ({ page }) => {
  await setup(page)
  await navigate(page, "Defaults")
  await expect(page.getByRole("group", { name: "Allowed models", exact: true })).toBeVisible()
  await expect(page.getByRole("combobox", { name: "Chat model override" })).toHaveCount(0)
  await expect(
    page.getByRole("combobox", { name: "Shared default model", exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Edit default model in Model providers" }),
  ).toHaveCount(0)
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
  await navigate(page, "Audit")
  await expect(page.getByText("Review required at import")).toBeVisible()
  await expect(page.getByText(/3 model settings imported/)).toContainText("1 chat failed")
  await expect(
    page.getByRole("list", { name: "Configuration activity" }).getByRole("listitem").first(),
  ).toContainText("Settings application")
  await expect(
    page.getByRole("list", { name: "Configuration activity" }).getByRole("listitem").first(),
  ).toContainText("Actor42")
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
  await navigate(page, "MCP connections")
  await expect(page.getByText("Connection test:", { exact: false })).toContainText("not tested")
  await closeConnectionEditor(page)
  await page.getByRole("button", { name: "Edit fields for existing", exact: true }).click()
  await expect(page.getByLabel("Server configuration JSON")).toHaveValue("{}")
  await page.getByText("Secrets (optional)", { exact: true }).click()
  await page.getByLabel("Secret field name").fill("TOKEN")
  await page.getByLabel("New secret value").fill("replacement-fixture")
  await expect(page.getByRole("button", { name: "Save connection" })).toBeDisabled()
  await page.getByRole("button", { name: "Set pending secret replacement" }).click()
  const saving = page.waitForRequest(
    (r) => r.url().endsWith("/api/mcp/existing") && r.method() === "PUT",
  )
  await page.getByRole("button", { name: "Save connection" }).click()
  const config = (await saving).postDataJSON().config
  expect(config).toEqual({ env: { OLD_TOKEN: null, TOKEN: "replacement-fixture" } })
  expect(config).not.toHaveProperty("headers")
  await expect(page.getByLabel("Server configuration JSON")).not.toHaveValue(/replacement-fixture/)
  await expect(page.getByText("MCP: Unsaved configuration", { exact: true })).toHaveCount(0)
})

test("never saves plaintext secrets from the advanced JSON editor", async ({ page }) => {
  await setup(page)
  let saves = 0
  page.on("request", (r) => {
    if (r.url().endsWith("/api/mcp/new") && r.method() === "PUT") saves++
  })
  await navigate(page, "MCP connections")
  await page.getByLabel("MCP server name").fill("new")
  await page.getByText("Advanced server configuration JSON", { exact: true }).click()
  await page.getByLabel("Server configuration JSON").fill('{"env":{"TOKEN":"unsafe-fixture"}}')
  await expect(page.getByRole("button", { name: "Save connection" })).toBeDisabled()
  await expect(page.getByRole("alert")).toContainText(
    "Use the masked field for secret replacements",
  )
  expect(saves).toBe(0)
  await expect(page.getByText("MCP: Unsaved configuration", { exact: true })).toBeVisible()
})

test("clears the shared model only through an explicit scoped confirmation", async ({ page }) => {
  await setup(page)
  await navigate(page, "Defaults")
  await page.getByRole("button", { name: "Clear shared default model", exact: true }).click()
  await expect(page.getByRole("alertdialog")).toContainText(
    "Allowed models, authentication, and chat overrides stay unchanged",
  )
  const saving = page.waitForRequest(
    (r) => r.url().endsWith("/api/settings") && r.method() === "PUT",
  )
  await page.getByRole("button", { name: "Clear default in draft", exact: true }).click()
  await page.getByRole("button", { name: "Review and save changes", exact: true }).click()
  await page.getByRole("button", { name: "Save changes", exact: true }).click()
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
  await navigate(page, "Access")
  await page.getByRole("button", { name: "Revoke access for ID 42" }).click()
  await page.getByRole("button", { name: "Review and save changes", exact: true }).click()
  await page.getByRole("button", { name: "Save changes", exact: true }).click()
  await expect(page.getByLabel("Telegram ID to approve")).toBeDisabled()
  await expect(page.getByText("Operation in progress…", { exact: true })).toBeVisible()
  finish()
  await expect(page.getByLabel("Telegram ID to approve")).toBeEnabled()
  await expect(page.getByText("Settings saved and applied.", { exact: true })).toBeVisible()
})

test("clears unstaged secrets when an unnamed MCP draft is discarded", async ({ page }) => {
  await setup(page)
  await navigate(page, "MCP connections")
  await page.getByText("Secrets (optional)", { exact: true }).click()
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
    await navigate(page, "Model Providers")
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
    await page.getByRole("button", { name: "Account", exact: true }).click()
    const signingOut = page.getByRole("menuitem", { name: "Sign out", exact: true }).click()
    const warning = await dialog
    expect(warning.message()).toBe("Discard pending changes and leave?")
    await warning.dismiss()
    await signingOut
    await page.getByRole("button", { name: "Set provider configuration", exact: true }).click()
    await page.getByRole("button", { name: "Review and save changes", exact: true }).click()
    const saving = page.waitForRequest(
      (r) => r.url().endsWith("/api/settings") && r.method() === "PUT",
    )
    await page.getByRole("button", { name: "Save changes", exact: true }).click()
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
    await navigate(page, "MCP connections")
    await closeConnectionEditor(page)
    await page
      .getByRole("button", { name: `Edit fields for ${scenario.draft}`, exact: true })
      .click()
    await openMcpJson(page)
    await page.getByLabel("Server configuration JSON").fill('{"enabled":false}')
    await page.getByText("Secrets (optional)", { exact: true }).click()
    await page.getByLabel("Secret field name").fill("TOKEN")
    await page.getByLabel("New secret value").fill("pending-fixture")
    await page.getByRole("button", { name: "Set pending secret replacement", exact: true }).click()
    await closeConnectionEditor(page)
    await page.getByRole("button", { name: "Actions for obsolete", exact: true }).click()
    await page.getByRole("menuitem", { name: "Delete obsolete", exact: true }).click()
    await page.getByRole("button", { name: "Delete server and apply", exact: true }).click()
    if (scenario.fails) await expect(page.getByRole("alert")).toContainText("Deletion failed")
    else
      await expect(
        page.getByRole("button", { name: "Actions for obsolete", exact: true }),
      ).toHaveCount(0)
    if (scenario.draft === "obsolete" && !scenario.fails) {
      await expect(page.getByText("MCP: Unsaved configuration", { exact: true })).toHaveCount(0)
      await expect(page.getByLabel("MCP server name")).toHaveValue("")
      await expect(page.getByLabel("Server configuration JSON")).toHaveValue("{}")
      await expect(page.getByText("Pending secret fields:", { exact: false })).toHaveCount(0)
      await expect(page.getByRole("button", { name: "Reload", exact: true })).toBeEnabled()
    } else {
      await expect(page.getByText("MCP: Unsaved configuration", { exact: true })).toBeVisible()
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
    await navigate(page, "MCP connections")
    await closeConnectionEditor(page)
    await closeConnectionEditor(page)
    await page.getByRole("button", { name: "Edit fields for existing", exact: true }).click()
    await openMcpJson(page)
    await page.getByLabel("Server configuration JSON").fill('{"enabled":false}')
    await page.getByText("Secrets (optional)", { exact: true }).click()
    await page.getByLabel("Secret field name").fill("TOKEN")
    await page.getByLabel("New secret value").fill("uncertain-fixture")
    await page.getByRole("button", { name: "Set pending secret replacement", exact: true }).click()
    if (method === "PUT")
      await page.getByRole("button", { name: "Save connection", exact: true }).click()
    else {
      await closeConnectionEditor(page)
      await page.getByRole("button", { name: "Actions for existing", exact: true }).click()
      await page.getByRole("menuitem", { name: "Delete existing", exact: true }).click()
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
      await expect(page.getByText("MCP: Unsaved configuration", { exact: true })).toBeVisible()
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

for (const destination of ["Access", "Chats"]) {
  test(`closes provider search on navigation to ${destination} and focuses the visible heading`, async ({
    page,
  }) => {
    await setup(page)
    await navigate(page, "Model Providers")
    await page.getByRole("button", { name: /^Provider: / }).click()
    await expect(page.getByRole("dialog", { name: "Choose provider" })).toBeVisible()
    const navigation = page.getByRole("link", { name: sectionLabel(destination), exact: true })
    await navigation.click()
    await expect(page.getByRole("dialog", { name: "Choose provider" })).toHaveCount(0)
    const heading = page.getByRole("heading", { name: sectionLabel(destination), exact: true })
    await expect(heading).toBeFocused()
    await expect(heading).toBeInViewport({ ratio: 1 })
    await navigate(page, "Model Providers")
    await expect(page.getByRole("dialog", { name: "Choose provider" })).toHaveCount(0)
  })
}

test("dismisses retained provider selectors with Escape and outside click", async ({ page }) => {
  await setup(page)
  await navigate(page, "Model Providers")
  const trigger = page.getByRole("button", { name: /^Provider: / })
  await trigger.click()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog", { name: "Choose provider" })).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await trigger.click()
  await page.getByRole("heading", { name: "Sumire", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Choose provider" })).toHaveCount(0)
})

test("closes provider search on navigation without clearing its model draft", async ({ page }) => {
  await setup(page)
  await navigate(page, "Model Providers")
  await chooseModel(page)
  await page.getByRole("button", { name: "Provider: Fixture", exact: true }).click()
  await navigate(page, "Chats")
  await expect(page.getByRole("dialog", { name: "Choose provider", exact: true })).toHaveCount(0)
  await navigate(page, "Model Providers")
  await expect(page.getByRole("button", { name: /^Model: / })).toContainText("Other")
})

test("shows truthful chat search scope, unknown names, and no-results states on a narrow viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await setup(page)
  await page.route("**/api/chats?*", (route) =>
    chatResponse(route, [
      { id: 42, name: "42", type: "private" },
      { id: -100, name: "", type: "supergroup" },
    ]),
  )
  await page.reload()
  await expect(page.getByRole("heading", { name: "Chat directory", exact: true })).toBeVisible()
  await openDirectoryFilters(page)
  await expect(
    page.getByText("Search covers stored chats. Type and access filters cover this page only.", {
      exact: false,
    }),
  ).toBeVisible()
  const search = page.getByLabel("Search stored chats", { exact: true })
  await search.fill("missing")
  await expect(page.getByText("No stored chats match this search.", { exact: true })).toBeVisible()
  await search.fill("-100")
  const row = page.getByRole("button").filter({ hasText: "Unnamed supergroup" })
  await row.focus()
  await page.keyboard.press("Enter")
  const detail = page.getByRole("region", { name: "Chat details" })
  await expect(detail.getByRole("heading", { name: "Unnamed supergroup" })).toBeVisible()
  await expect(detail).toContainText("Access approval is missing.")
  await detail.getByText("Readiness details", { exact: true }).click()
  await expect(detail.locator(".readiness")).toContainText("Configured locally")
  await expect(detail.locator(".readiness")).toContainText("Not checked — no remote model request")
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
  await detail.getByRole("button", { name: "Review access approval" }).click()
  await expect(page.getByRole("tab", { name: "Access", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  )
  await expect(
    detail.getByRole("heading", { name: "Access for this chat", exact: true }),
  ).toBeFocused()
  await detail.getByRole("button", { name: "Open Chat access", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Access for chat -100" })).toBeVisible()
  await expect(page.getByLabel("Search group and channel access")).toHaveValue("-100")
})

test("separates saved chat status from draft effects without remote checks or implicit writes", async ({
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
  await expect(detail.getByRole("region", { name: "Chat setup status" })).toContainText("Disabled")
  await detail.getByText("Readiness details", { exact: true }).click()
  await expect(detail).toContainText("None · This chat override")
  await expect(detail).toContainText("fixture/test · From shared defaults")
  await expect(detail).toContainText("Model authentication is not configured.")
  await expect(detail.getByRole("button", { name: "Configure authentication" })).toBeVisible()
  await openChatConfiguration(page)
  await detail.getByRole("checkbox", { name: "Chat enabled", exact: true }).check()
  await expect(detail).toContainText("Draft preview — not saved")
  await expect(
    detail.getByRole("region", { name: "Chat setup status" }).getByRole("heading"),
  ).toHaveText("Disabled")
  await expect(detail).toContainText("Draft preview — not saved: Setup required.")
  await expect(page.getByText("1 unsaved change", { exact: true })).toBeVisible()
  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "Discard settings changes", exact: true }).click()
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
    chatResponse(route, [...first, { id: 101, name: "Next page chat", type: "private" }]),
  )
  await page.reload()
  await navigate(page, "Access")
  await page.getByRole("button", { name: "Revoke access for ID 42", exact: true }).click()
  await navigate(page, "Chats")
  await page.getByRole("button", { name: "Next chats", exact: true }).click()
  await expect(page.getByRole("button").filter({ hasText: "Next page chat" })).toBeVisible()
  await expect(page.getByText("1 unsaved change", { exact: true })).toBeVisible()
  await navigate(page, "Access")
  await expect(page.getByText("Pending revocation", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Undo revocation for 42", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Review and save changes", exact: true }),
  ).toHaveCount(0)
})

test("policy discard leaves provider and MCP drafts unchanged", async ({ page }) => {
  await setup(page)
  await navigate(page, "Model Providers")
  await chooseModel(page)
  await navigate(page, "MCP connections")
  await page.getByLabel("MCP server name", { exact: true }).fill("local-draft")
  await navigate(page, "Access")
  await page.getByRole("button", { name: "Revoke access for ID 42", exact: true }).click()
  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "Discard settings changes", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Revoke access for ID 42", exact: true }),
  ).toBeVisible()
  await navigate(page, "MCP connections")
  await expect(page.getByLabel("MCP server name", { exact: true })).toHaveValue("local-draft")
  await navigate(page, "Model Providers")
  await expect(page.getByRole("button", { name: /^Model: / })).toContainText("Other")
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
  await expect(page.getByRole("link", { name: "Chat access", exact: true })).toBeEnabled()
  finish()
  await expect(page.getByRole("alert")).toContainText("Could not read chat metadata. Retry chats.")
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
        ? "Provider configuration is not in the loaded inventory."
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

test("filters the loaded directory by type and effective policy access without the obsolete selector", async ({
  page,
}, testInfo) => {
  await setup(page)
  await page.route("**/api/chats?*", (route) =>
    chatResponse(route, [
      { id: 42, name: "Fixture chat", type: "private" },
      { id: -100, name: "Team", type: "supergroup" },
      { id: -200, name: "News", type: "channel" },
      { id: -300, name: "", type: "" },
    ]),
  )
  await page.route("**/api/settings", (route) =>
    route.fulfill({
      json: {
        revision: 1,
        applied: 1,
        status: "applied",
        policy: {
          ...policy,
          groups: [-100, -200],
          chats: {
            "-100": {
              tools: null,
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
  await page.reload()
  const directory = page.getByRole("list", { name: "Chats on this page" })
  await expect(directory.getByRole("button")).toHaveCount(4)
  await expect(page.getByRole("button", { name: "Known chat", exact: true })).toHaveCount(0)
  await openDirectoryFilters(page)
  await page.getByRole("combobox", { name: "Chat type", exact: true }).click()
  await page.getByRole("option", { name: "Group / supergroup", exact: true }).click()
  await expect(directory.getByRole("button")).toHaveCount(1)
  await expect(directory).toContainText("Team")
  await expect(directory).toContainText("Disabled")
  await directory.getByRole("button").click()
  await page.locator(".setup-details > summary").click()
  await expect(page.locator(".setup-details")).toContainText("Approved")
  await page.getByRole("combobox", { name: "Access status", exact: true }).click()
  await page.getByRole("option", { name: "Approved and enabled", exact: true }).click()
  await expect(
    page.getByText("No chats match the filters on this page.", { exact: true }),
  ).toBeVisible()
  await page.getByRole("button", { name: "Clear search and filters" }).click()
  await page.getByRole("combobox", { name: "Chat type", exact: true }).click()
  await page.getByRole("option", { name: "Channel", exact: true }).click()
  await directory.getByRole("button").click()
  await expect(page.getByRole("region", { name: "Chat details" })).toContainText("News")
  await page.getByRole("combobox", { name: "Chat type", exact: true }).click()
  await page.getByRole("option", { name: "All types", exact: true }).click()
  await page.screenshot({ path: testInfo.outputPath("desktop.png"), fullPage: true })
})

test("keeps directory context and policy drafts through sidebar navigation and browser back", async ({
  page,
}) => {
  await setup(page)
  const search = page.getByLabel("Search stored chats", { exact: true })
  await search.fill("Fixture")
  await page.getByRole("list", { name: "Chats on this page" }).getByRole("button").click()
  await page.getByRole("tab", { name: "Access", exact: true }).click()
  await page
    .getByRole("tabpanel", { name: "Access", exact: true })
    .getByRole("button", { name: "Revoke access", exact: true })
    .click()
  await navigate(page, "Defaults")
  await expect(page.getByRole("link", { name: "Shared defaults", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  )
  await expect(page).toHaveURL(/section=Defaults.*chat=42|chat=42.*section=Defaults/)
  await page.goBack()
  await expect(page.getByRole("link", { name: "Chats", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  )
  await expect(search).toHaveValue("Fixture")
  await expect(page.getByText("Pending access revocation", { exact: true })).toBeVisible()
  await expect(
    page.getByRole("list", { name: "Chats on this page" }).getByRole("button"),
  ).toHaveAttribute("aria-current", "true")
  await page.goForward()
  await expect(page.getByRole("link", { name: "Shared defaults", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  )
  await expect(page.getByText("1 unsaved change", { exact: true })).toBeVisible()
})

test("opens compatible chat deep links without granting access or inventing metadata", async ({
  page,
}) => {
  await setup(page)
  const writes: string[] = []
  page.on("request", (request) => {
    if (request.method() !== "GET") writes.push(request.url())
  })
  await page.goto("/?section=Chats&chat=-100")
  await expect(page.getByRole("heading", { name: "Chat name unknown", exact: true })).toBeVisible()
  const detail = page.getByRole("region", { name: "Chat details" })
  await expect(detail).toContainText("Type not known")
  await expect(detail).toContainText("Access approval is missing.")
  await expect(
    page.getByRole("button", { name: "Review and save changes", exact: true }),
  ).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole("heading", { name: "Chat name unknown", exact: true })).toBeVisible()
  expect(writes).toEqual([])
})

test("stages contextual grant and revoke actions without enabling a disabled chat", async ({
  page,
}) => {
  await setup(page)
  await page.route("**/api/settings", (route) =>
    route.fulfill({
      json: {
        revision: 1,
        applied: 1,
        status: "applied",
        policy: {
          ...policy,
          chats: {
            "-100": {
              tools: null,
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
  await page.goto("/?section=Chats&chat=-100")
  await page.getByRole("tab", { name: "Access", exact: true }).click()
  const panel = page.getByRole("tabpanel", { name: "Access", exact: true })
  let writes = 0
  page.on("request", (request) => {
    if (request.method() === "PUT") writes++
  })
  await panel.getByRole("button", { name: "Grant access", exact: true }).click()
  await expect(panel).toContainText("Pending access grant")
  await expect(panel).toContainText("Blocked by policy · Chat disabled independently of approval")
  await expect(panel).toContainText("Group and channel access")
  expect(writes).toBe(0)
  await panel.getByRole("button", { name: "Undo pending grant", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Review and save changes", exact: true }),
  ).toHaveCount(0)
  await panel.getByRole("button", { name: "Grant access", exact: true }).click()
  await panel.getByRole("button", { name: "Revoke access", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Review and save changes", exact: true }),
  ).toHaveCount(0)
})

test("undoes a contextual revocation without reporting an access-list reorder as pending", async ({
  page,
}) => {
  await setup(page)
  await page.route("**/api/settings", (route) =>
    route.fulfill({
      json: {
        revision: 1,
        applied: 1,
        status: "applied",
        policy: { ...policy, privateUsers: [42, 43] },
      },
    }),
  )
  await page.goto("/?section=Chats&chat=42")
  await page.getByRole("tab", { name: "Access", exact: true }).click()
  const panel = page.getByRole("tabpanel", { name: "Access", exact: true })
  await panel.getByRole("button", { name: "Revoke access", exact: true }).click()
  await expect(panel).toContainText("Saved approvalApproved")
  await expect(panel).toContainText("Pending access revocation")
  await panel.getByRole("button", { name: "Undo pending revocation", exact: true }).click()
  await expect(panel).toContainText("No pending approval change for this chat.")
  await expect(
    page.getByRole("button", { name: "Review and save changes", exact: true }),
  ).toHaveCount(0)
})

test("applies chat policy changes without saving model-provider or MCP drafts", async ({
  page,
}) => {
  await setup(page)
  await navigate(page, "Model Providers")
  await chooseModel(page)
  await navigate(page, "MCP connections")
  await page.getByLabel("MCP server name", { exact: true }).fill("connection-draft")
  await navigate(page, "Chats")
  await page.getByRole("list", { name: "Chats on this page" }).getByRole("button").click()
  await page.getByRole("tab", { name: "Access", exact: true }).click()
  await page
    .getByRole("tabpanel", { name: "Access", exact: true })
    .getByRole("button", { name: "Revoke access", exact: true })
    .click()
  await page.getByRole("button", { name: "Review and save changes", exact: true }).click()
  const request = page.waitForRequest(
    (request) => request.url().endsWith("/api/settings") && request.method() === "PUT",
  )
  await page.getByRole("button", { name: "Save changes", exact: true }).click()
  const saved = (await request).postDataJSON().policy
  expect(saved.privateUsers).toEqual([])
  expect(saved.defaults.model).toBe("fixture/test")
  await expect(page.getByText("Saved revision applied.", { exact: true })).toBeVisible()
  await expect(page.getByText("MCP: Unsaved configuration", { exact: true })).toBeVisible()
  await expect(
    page.getByText("Provider: Unsaved selection or authentication", { exact: true }),
  ).toBeVisible()
  await navigate(page, "Model Providers")
  await expect(page.getByRole("button", { name: /^Model: / })).toContainText("Other")
  await navigate(page, "MCP connections")
  await expect(page.getByLabel("MCP server name", { exact: true })).toHaveValue("connection-draft")
})

test("explains selected tools that global policy excludes without granting their permission", async ({
  page,
}) => {
  await setup(page)
  await page.route("**/api/settings", (route) =>
    route.fulfill({
      json: {
        revision: 1,
        applied: 1,
        status: "applied",
        policy: { ...policy, tools: [] },
      },
    }),
  )
  await page.goto("/?section=Chats&chat=42")
  await expect(
    page.getByText("Selected tools excluded by global policy:", { exact: false }),
  ).toContainText("read_url_content")
  await page.getByRole("button", { name: "Review tool permissions", exact: true }).click()
  await expect(page.getByRole("tab", { name: "Model & Tools", exact: true })).toBeFocused()
  await page.getByText("Inspect individual tool permissions", { exact: true }).click()
  await expect(
    page.getByRole("listitem").filter({ hasText: "read_url_content · In loaded inventory" }),
  ).toContainText("Excluded by global policy · Selected · Tool permission denied")
  await expect(
    page.getByRole("button", { name: "Review and save changes", exact: true }),
  ).toHaveCount(0)
})

test("shows only structured chat-targeted audit records and discloses history scope", async ({
  page,
}) => {
  await setup(page)
  const entries = [
    {
      id: 1,
      time: 1,
      actor: "42",
      operation: "chat.access.approve",
      revision: 1,
      outcome: "saved",
      target: "chat:42",
    },
    {
      id: 2,
      time: 1,
      actor: "42",
      operation: "settings.update",
      revision: 1,
      outcome: "saved",
      target: "settings",
    },
    {
      id: 3,
      time: 1,
      actor: "42",
      operation: "chat.access.approve",
      revision: 1,
      outcome: "saved",
      target: "chat:142",
    },
  ]
  await page.route("**/api/audit?*", (route) => route.fulfill({ json: entries }))
  await page.goto("/?section=Chats&chat=42")
  await page.getByRole("tab", { name: "History", exact: true }).click()
  const panel = page.getByRole("tabpanel", { name: "History", exact: true })
  await expect(panel.getByRole("listitem")).toHaveCount(1)
  await expect(panel).toContainText("chat:42")
  await expect(panel).not.toContainText("chat:142")
  await expect(panel).toContainText("This is not a complete chat history.")
  await panel.getByRole("button", { name: "Open Audit", exact: true }).click()
  await expect(
    page.getByRole("region", { name: "Audit history", exact: true }).getByRole("listitem"),
  ).toHaveCount(3)
})

test("uses keyboard detail tabs and responsive navigation without losing the directory search", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await setup(page)
  const search = page.getByLabel("Search stored chats", { exact: true })
  await search.fill("Fixture")
  const row = page.getByRole("list", { name: "Chats on this page" }).getByRole("button")
  await row.focus()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("heading", { name: "Fixture chat", exact: true })).toBeFocused()
  await page.getByRole("tab", { name: "Overview", exact: true }).focus()
  await page.keyboard.press("ArrowRight")
  await expect(page.getByRole("tab", { name: "Access", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  )
  await page
    .getByRole("tabpanel", { name: "Access", exact: true })
    .getByRole("button", { name: "Revoke access", exact: true })
    .click()
  await expect(page.getByText("1 unsaved change", { exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("mobile.png"), fullPage: true })
  await page.getByRole("button", { name: "Back to chat directory", exact: true }).click()
  await expect(row).toBeFocused()
  await expect(search).toHaveValue("Fixture")
  await navigate(page, "Defaults")
  await navigate(page, "Chats")
  await expect(search).toHaveValue("Fixture")
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
})

test("closes a chat model dropdown when browser navigation hides its owning section", async ({
  page,
}) => {
  await setup(page)
  await page.getByRole("list", { name: "Chats on this page" }).getByRole("button").click()
  await openChatConfiguration(page)
  await navigate(page, "Defaults")
  await page.goBack()
  await page.getByRole("combobox", { name: "Chat model override", exact: true }).click()
  await expect(page.getByRole("listbox")).toBeVisible()
  await page.goForward()
  await expect(page.getByRole("link", { name: "Shared defaults", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  )
  await expect(page.getByRole("listbox")).toHaveCount(0)
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest("[hidden]")))).toBe(
    false,
  )
  await page.goBack()
  await expect(page.getByRole("listbox")).toHaveCount(0)
  await expect(
    page.getByRole("combobox", { name: "Chat model override", exact: true }),
  ).toBeVisible()
})

test("global access undo leaves no pending changes when only ID order differs", async ({
  page,
}) => {
  await setup(page)
  await page.route("**/api/settings", (route) =>
    route.fulfill({
      json: {
        revision: 1,
        applied: 1,
        status: "applied",
        policy: { ...policy, privateUsers: [42, 43] },
      },
    }),
  )
  await page.reload()
  await navigate(page, "Access")
  let writes = 0
  page.on("request", (request) => {
    if (request.method() !== "GET") writes++
  })
  await page.getByRole("button", { name: "Revoke access for ID 42", exact: true }).click()
  await expect(page.getByText("1 unsaved change", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Undo revocation for 42", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Review and save changes", exact: true }),
  ).toHaveCount(0)
  await expect(page.getByText(/\d+ unsaved changes?/)).toHaveCount(0)
  expect(
    await page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true })
      window.dispatchEvent(event)
      return event.defaultPrevented
    }),
  ).toBe(false)
  expect(writes).toBe(0)
})

test("Reload refreshes current chat names and new chats while retaining provider and MCP drafts", async ({
  page,
}) => {
  await setup(page)
  await expect(
    page.getByRole("list", { name: "Chats on this page" }).getByRole("button"),
  ).toHaveCount(1)
  let reads = 0
  await page.route("**/api/chats?*", (route) => {
    if (!new URL(route.request().url()).searchParams.has("id")) reads++
    return chatResponse(
      route,
      reads === 1
        ? [{ id: 42, name: "Original name", type: "private" }]
        : [
            { id: 42, name: "Updated name", type: "private" },
            { id: 43, name: "New chat", type: "private" },
          ],
    )
  })
  await page.reload()
  await page.getByRole("list", { name: "Chats on this page" }).getByRole("button").click()
  await expect(page.getByRole("heading", { name: "Original name", exact: true })).toBeVisible()
  await navigate(page, "Model Providers")
  await chooseModel(page)
  await navigate(page, "MCP connections")
  await page.getByLabel("MCP server name", { exact: true }).fill("retained-draft")
  await page.getByText("Advanced server configuration JSON", { exact: true }).click()
  await page.getByLabel("Server configuration JSON").fill('{"enabled":false}')
  await page.getByRole("button", { name: "Reload", exact: true }).click()
  await navigate(page, "Chats")
  await expect(page.getByRole("heading", { name: "Updated name", exact: true })).toBeVisible()
  await expect(page.getByRole("list", { name: "Chats on this page" })).toContainText("New chat")
  await expect(page.getByRole("button", { name: "Next chats", exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Previous chats", exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Refresh chats", exact: true })).toBeVisible()
  expect(reads).toBe(2)
  await navigate(page, "Model Providers")
  await expect(page.getByRole("button", { name: /^Model: / })).toContainText("Other")
  await navigate(page, "MCP connections")
  await expect(page.getByLabel("MCP server name", { exact: true })).toHaveValue("retained-draft")
  await expect(page.getByLabel("Server configuration JSON")).toHaveValue('{"enabled":false}')
})

test("Reload does not let an older chat response replace fresh metadata", async ({ page }) => {
  await setup(page)
  await expect(
    page.getByRole("list", { name: "Chats on this page" }).getByRole("button"),
  ).toHaveCount(1)
  let finish!: () => void
  const oldRequest = new Promise<void>((resolve) => {
    finish = resolve
  })
  let reads = 0
  let oldFulfilled!: () => void
  const oldHandlerDone = new Promise<void>((resolve) => {
    oldFulfilled = resolve
  })
  await page.route("**/api/chats?*", async (route) => {
    const current = ++reads
    if (current === 1) await oldRequest
    try {
      await route.fulfill({
        json: [{ id: 42, name: current === 1 ? "Old name" : "Fresh name", type: "private" }],
      })
    } finally {
      if (current === 1) oldFulfilled()
    }
  })
  await page.reload()
  await expect(page.getByText("Loading chats…", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Reload", exact: true })).toBeEnabled()
  const aborted = page.waitForEvent("requestfailed", (request) =>
    request.url().includes("/api/chats?"),
  )
  await page.getByRole("button", { name: "Reload", exact: true }).click()
  await expect(page.getByRole("list", { name: "Chats on this page" })).toContainText("Fresh name")
  await aborted
  finish()
  await oldHandlerDone
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
  await expect(page.getByRole("list", { name: "Chats on this page" })).toContainText("Fresh name")
})

for (const trigger of ["initial load", "pagination", "retry"]) {
  test(`chat-list ${trigger} handles session expiry and clears sensitive drafts`, async ({
    page,
  }) => {
    await setup(page)
    let expired = trigger === "initial load"
    await page.route("**/api/chats?*", (route) => {
      if (expired) return route.fulfill({ status: 401, json: { error: "Sign in" } })
      if (trigger === "retry")
        return route.fulfill({ status: 500, json: { error: "Chat fetch failed" } })
      return route.fulfill({
        json: Array.from({ length: 100 }, (_, index) => ({
          id: index + 1,
          name: `Chat ${index + 1}`,
          type: "private",
        })),
      })
    })
    await page.reload()
    if (trigger !== "initial load") {
      if (trigger === "retry")
        await expect(page.getByRole("button", { name: "Retry chats", exact: true })).toBeVisible()
      else await expect(page.getByRole("button", { name: "Next chats", exact: true })).toBeEnabled()
      await navigate(page, "Model Providers")
      await chooseModel(page)
      await navigate(page, "MCP connections")
      await page.getByLabel("MCP server name", { exact: true }).fill("expired-draft")
      await page.getByText("Secrets (optional)", { exact: true }).click()
      await page.getByLabel("Secret field name", { exact: true }).fill("TOKEN")
      await page.getByLabel("New secret value", { exact: true }).fill("masked-fixture-value")
      await page
        .getByRole("button", { name: "Set pending secret replacement", exact: true })
        .click()
      await expect(page.getByText("MCP: Unsaved configuration", { exact: true })).toBeVisible()
      await navigate(page, "Chats")
      expired = true
      await page
        .getByRole("button", {
          name: trigger === "retry" ? "Retry chats" : "Next chats",
          exact: true,
        })
        .click()
    }
    await expect(
      page.getByRole("button", { name: "Sign in with passkey", exact: true }),
    ).toBeVisible()
    await expect(page.getByRole("button", { name: "Account", exact: true })).toHaveCount(0)
    await expect(page.getByRole("alert")).toContainText(
      "Administrator session expired. Sign in again.",
    )
    expect(
      await page.evaluate(() => {
        const event = new Event("beforeunload", { cancelable: true })
        window.dispatchEvent(event)
        return event.defaultPrevented
      }),
    ).toBe(false)
  })
}

test("sign-out clears names from chat pages loaded in the previous session", async ({
  page,
  context,
}) => {
  await setup(page)
  await expect(
    page.getByRole("list", { name: "Chats on this page" }).getByRole("button"),
  ).toHaveCount(1)
  let signIns = 0
  await page.route("**/api/settings", (route) =>
    route.fulfill({
      json: {
        revision: 1,
        applied: 1,
        status: "applied",
        policy: { ...policy, privateUsers: [42, 201] },
      },
    }),
  )
  await page.route("**/api/chats?*", (route) =>
    chatResponse(route, [
      ...Array.from({ length: 100 }, (_, index) => ({
        id: index + 1,
        name: `Session ${signIns} user ${index + 1}`,
        type: "private",
      })),
      {
        id: 201,
        name: signIns ? "Updated off-page name" : "Previous session name",
        type: "private",
      },
    ]),
  )
  const client = await context.newCDPSession(page)
  await client.send("WebAuthn.enable")
  const { authenticatorId } = await client.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({
    type: "pkcs8",
    format: "der",
  })
  await client.send("WebAuthn.addCredential", {
    authenticatorId,
    credential: {
      credentialId: Buffer.from("cache-cleanup-credential").toString("base64"),
      isResidentCredential: true,
      rpId: "localhost",
      privateKey: key.toString("base64"),
      userHandle: Buffer.from("42").toString("base64"),
      signCount: 0,
    },
  })
  await page.route("**/auth/passkey/**", async (route) => {
    if (route.request().url().endsWith("options")) {
      await route.fulfill({
        json: {
          challenge: Buffer.from("cache-cleanup-challenge").toString("base64url"),
          rpId: "localhost",
          userVerification: "required",
        },
      })
    } else {
      expect(route.request().postDataJSON().response.response.signature).toBeTruthy()
      signIns++
      await route.fulfill({ json: { csrf: "browser-fixture", actor: "42" } })
    }
  })
  const localUrl = new URL(page.url())
  localUrl.hostname = "localhost"
  await page.goto(localUrl.href)
  await page.getByRole("button", { name: "Next chats", exact: true }).click()
  await expect(page.getByRole("list", { name: "Chats on this page" })).toContainText(
    "Previous session name",
  )
  await page.getByRole("button", { name: "Previous chats", exact: true }).click()
  await navigate(page, "Access")
  await expect(
    page.getByRole("group", { name: "Private-message access", exact: true }),
  ).toContainText("Previous session name")
  await navigate(page, "Chats")
  await page.getByRole("button", { name: "Account", exact: true }).click()
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click()
  await page.getByRole("button", { name: "Sign in with passkey", exact: true }).click()
  await expect(page.getByRole("list", { name: "Chats on this page" })).toContainText(
    "Session 1 user 42",
  )
  await navigate(page, "Access")
  const users = page.getByRole("group", { name: "Private-message access", exact: true })
  const offPage = users.getByRole("row").filter({ hasText: "201" })
  await expect(offPage).toContainText("Unnamed private")
  await expect(offPage.locator("code")).toHaveText("201")
  await expect(users).not.toContainText("Previous session name")
  await navigate(page, "Chats")
  await page.getByRole("button", { name: "Next chats", exact: true }).click()
  await expect(page.getByRole("list", { name: "Chats on this page" })).toContainText(
    "Updated off-page name",
  )
  await navigate(page, "Access")
  await expect(offPage).toContainText("Updated off-page name")
  expect(signIns).toBe(1)
})

test("policy-only discard preserves unfinished access input", async ({ page }) => {
  await setup(page)
  await navigate(page, "Access")
  await page.getByLabel("Telegram ID to approve", { exact: true }).fill("43")
  await page.getByRole("button", { name: "Revoke access for ID 42", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Review and save changes", exact: true }),
  ).toBeDisabled()
  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "Discard settings changes", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Revoke access for ID 42", exact: true }),
  ).toBeVisible()
  await expect(page.getByLabel("Telegram ID to approve", { exact: true })).toHaveValue("43")
  await expect(page.locator("#save-status")).toContainText("Chat access — Telegram ID to approve")
  await navigate(page, "Defaults")
  await navigate(page, "Access")
  await expect(page.getByLabel("Telegram ID to approve", { exact: true })).toHaveValue("43")
})
