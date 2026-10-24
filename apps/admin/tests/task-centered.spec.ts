import type { Inventory, Snapshot } from "@narumitw/sumire-contracts"
import { inherited, initialPolicy } from "@narumitw/sumire-policy"
import { expect, type Page, test } from "@playwright/test"
import { contrast } from "./contrast.js"

function data(count = 17) {
  const chats = Array.from({ length: count }, (_, index) => ({
    id: index + 42,
    name: `Fixture chat ${index + 1}`,
    type: "private",
  }))
  const policy = initialPolicy()
  policy.privateUsers = chats.map((chat) => chat.id)
  policy.models = ["fixture/test"]
  policy.defaults = { ...policy.defaults, model: "fixture/test", models: ["fixture/test"] }
  const snapshot: Snapshot = { revision: 1, applied: 1, status: "applied", policy, epoch: 1 }
  const inventory: Inventory = {
    tools: [],
    mcp: [],
    providers: [
      {
        id: "fixture",
        name: "Fixture",
        configured: true,
        apiKey: true,
        oauth: false,
        models: [{ id: "test", name: "Test", thinking: ["off"], reasoning: false, image: false }],
      },
    ],
  }
  return { chats, snapshot, inventory }
}
type FixtureData = ReturnType<typeof data>
async function fixture(page: Page, state = data(), url = "/") {
  const methods: string[] = []
  await page.route("**/api/**", async (route) => {
    const request = route.request()
    const path = new URL(request.url())
    methods.push(request.method())
    if (request.method() !== "GET") {
      expect(path.pathname).toBe("/api/settings")
      expect(request.method()).toBe("PUT")
      state.snapshot.policy = request.postDataJSON().policy
      state.snapshot.revision++
      state.snapshot.applied = state.snapshot.revision
    }
    if (path.pathname === "/api/chats") {
      const id = path.searchParams.get("id")
      const query = path.searchParams.get("q")?.toLowerCase() ?? ""
      const offset = Number(path.searchParams.get("offset") ?? 0)
      return route.fulfill({
        json: id
          ? state.chats.filter((chat) => String(chat.id) === id)
          : state.chats
              .filter(
                (chat) => chat.name.toLowerCase().includes(query) || String(chat.id) === query,
              )
              .slice(offset, offset + 100),
      })
    }
    const responses: Record<string, unknown> = {
      "/api/session": { csrf: "fixture", actor: "42" },
      "/api/settings": state.snapshot,
      "/api/inventory": state.inventory,
      "/api/audit": [],
      "/api/imports": [],
    }
    await route.fulfill({ json: responses[path.pathname] ?? {} })
  })
  await page.goto(url)
  await expect(page.getByRole("heading", { name: "Chats", exact: true })).toBeVisible()
  await expect(page.locator("#save-status")).not.toContainText("Saving or checking")
  return { ...state, methods }
}
const status = (page: Page) => page.getByRole("region", { name: "Chat setup status" })

const scenarios: {
  name: string
  label: string
  reason: string
  action?: string
  prepare(state: FixtureData): void
}[] = [
  {
    name: "unapproved",
    label: "Access not approved",
    reason: "Access approval is missing.",
    action: "Review access approval",
    prepare: (state) => {
      state.snapshot.policy.privateUsers = []
    },
  },
  {
    name: "disabled",
    label: "Disabled",
    reason: "The chat is disabled.",
    action: "Review chat enabled switch",
    prepare: (state) => {
      state.snapshot.policy.chats["42"] = { ...inherited, enabled: false }
    },
  },
  {
    name: "missing model",
    label: "Setup required",
    reason: "No effective model configured.",
    action: "Configure model",
    prepare: (state) => {
      state.snapshot.policy.defaults.model = null
    },
  },
  {
    name: "missing authentication",
    label: "Setup required",
    reason: "Model authentication is not configured.",
    action: "Configure authentication",
    prepare: (state) => {
      state.inventory.providers.forEach((provider) => {
        provider.configured = false
      })
    },
  },
  {
    name: "unknown provider",
    label: "Status unknown",
    reason: "Provider configuration is not in the loaded inventory.",
    action: "Review authentication configuration",
    prepare: (state) => {
      state.inventory.providers = []
    },
  },
  {
    name: "application failed",
    label: "Application failed",
    reason: "Saved settings could not be applied.",
    action: "Review application status",
    prepare: (state) => {
      state.snapshot.status = "failed"
    },
  },
  {
    name: "application pending",
    label: "Application pending",
    reason: "Saved settings are waiting to apply.",
    action: "Review application status",
    prepare: (state) => {
      state.snapshot.applied = 0
    },
  },
  {
    name: "locally configured",
    label: "Configured locally",
    reason: "Model response not checked.",
    prepare: () => {},
  },
]
for (const scenario of scenarios) {
  test(`rows and details share saved ${scenario.name} state and a read-only repair destination`, async ({
    page,
  }) => {
    const state = data()
    scenario.prepare(state)
    const { methods } = await fixture(page, state)
    const row = page.locator(".chat-list button").first()
    await expect(row.locator(".directory-status-label")).toContainText(scenario.label)
    await expect(row.locator(".directory-status-label")).toHaveAttribute("title", scenario.reason)
    await expect(row.locator("button, a")).toHaveCount(0)
    await row.click()
    if (scenario.name === "locally configured") {
      await expect(status(page).getByRole("heading")).toHaveCount(0)
      await expect(status(page).locator(".chat-ready-summary")).toContainText(scenario.label)
      await expect(status(page).locator(".setup-details")).not.toHaveAttribute("open", "")
      await status(page).getByText("Readiness details", { exact: true }).click()
      await expect(status(page)).toContainText("Not checked — no remote model request")
    } else await expect(status(page).getByRole("heading")).toHaveText(scenario.label)
    await expect(status(page).getByText(scenario.reason, { exact: true })).toBeVisible()
    if (scenario.action) {
      await status(page).getByRole("button", { name: scenario.action, exact: true }).click()
      if (scenario.name === "unapproved")
        await expect(
          page.getByRole("heading", { name: "Access for this chat", exact: true }),
        ).toBeFocused()
      else if (scenario.name === "disabled")
        await expect(
          page.getByRole("checkbox", { name: "Chat enabled", exact: true }),
        ).toBeFocused()
      else if (scenario.name === "missing model")
        await expect(
          page.getByRole("combobox", { name: "Chat model override", exact: true }),
        ).toBeFocused()
      else if (scenario.name.startsWith("application"))
        await expect(page.locator("#save-status")).toBeFocused()
      else
        await expect(
          page.locator(
            scenario.name === "unknown provider" ? "#provider-choice" : "#provider-authentication",
          ),
        ).toBeFocused()
      await expect(page).toHaveURL(/chat=42/)
    }
    expect(methods.every((method) => method === "GET")).toBe(true)
  })
}

test("keeps saved approval separate from draft repair through review and cancellation", async ({
  page,
}) => {
  const state = data()
  state.snapshot.policy.privateUsers = []
  const { methods } = await fixture(page, state)
  await page.locator(".chat-list button").first().click()
  await status(page).getByRole("button", { name: "Review access approval", exact: true }).click()
  await page.getByRole("button", { name: "Grant access", exact: true }).click()
  await expect(status(page).getByRole("heading")).toHaveText("Access not approved")
  await expect(page.locator(".chat-draft-status")).toContainText("Configured locally")
  await expect(page.locator(".chat-list button").first()).toContainText("Access not approved")
  await page.getByRole("button", { name: "Review and save changes", exact: true }).click()
  await expect(page.getByRole("alertdialog")).toContainText("Private-message access: approve 42")
  await expect(page.getByRole("alertdialog")).toContainText("Active work will be cancelled.")
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(status(page).getByRole("heading")).toHaveText("Access not approved")
  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "Discard settings changes", exact: true }).click()
  await expect(page.locator(".chat-draft-status")).toHaveCount(0)
  expect(methods.every((method) => method === "GET")).toBe(true)
})

test("labels draft-aware access filters separately from saved access", async ({ page }) => {
  const state = data()
  state.snapshot.policy.privateUsers = []
  await fixture(page, state)
  await page.locator(".chat-list button").first().click()
  await status(page).getByRole("button", { name: "Review access approval", exact: true }).click()
  await page.getByRole("button", { name: "Grant access", exact: true }).click()
  await page.locator(".directory-options summary").click()
  await expect(page.locator(".directory-help")).toContainText(
    "The access filter uses the policy draft.",
  )
  await page.getByLabel("Access status", { exact: true }).click()
  await page.getByRole("option", { name: "Approved and enabled", exact: true }).click()
  const row = page.locator(".chat-list button")
  await expect(row).toHaveCount(1)
  await expect(row.locator(".directory-status-label")).toContainText("Access not approved")
  await expect(row.locator(".directory-draft")).toHaveText("Draft access: Approved · Enabled")
  await expect(status(page).getByRole("heading")).toHaveText("Access not approved")
})

for (const width of [1440, 390]) {
  test(`repair navigation preserves unrelated policy draft and search at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    const state = data()
    state.snapshot.policy.privateUsers = [42]
    state.inventory.providers.forEach((provider) => {
      provider.configured = false
    })
    const { methods } = await fixture(page, state)
    const search = page.getByLabel("Search stored chats", { exact: true })
    await search.fill("Fixture chat")
    await page.locator(".directory-options summary").click()
    await page.getByLabel("Chat type", { exact: true }).click()
    await page.getByRole("option", { name: "Private", exact: true }).click()
    await page.locator(".chat-list button").nth(1).click()
    await status(page).getByRole("button", { name: "Review access approval", exact: true }).click()
    await page.getByRole("button", { name: "Grant access", exact: true }).click()
    const back = page.getByRole("button", { name: "Back to chat directory", exact: true })
    if (width <= 850) await back.click()
    await page.locator(".chat-list button").first().click()
    await status(page)
      .getByRole("button", { name: "Configure authentication", exact: true })
      .click()
    await expect(page.locator("#provider-authentication")).toBeFocused()
    await expect(page.locator("#save-status")).toContainText("1 unsaved change")
    const chats = page
      .getByRole("navigation", { name: "Administration sections" })
      .getByRole("link", { name: "Chats", exact: true })
    if (!(await chats.isVisible())) await page.getByRole("button", { name: /^Sections ·/ }).click()
    await chats.click()
    await expect(page.getByRole("tab", { name: "Access", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    )
    if (width <= 850) await back.click()
    await expect(search).toHaveValue("Fixture chat")
    await expect(page.getByLabel("Chat type", { exact: true })).toContainText("Private")
    await expect(page.locator("#save-status")).toContainText("1 unsaved change")
    expect(methods.every((method) => method === "GET")).toBe(true)
  })
}

for (const count of [0, 17, 99, 100, 101]) {
  test(`pagination uses successful response bounds for ${count} records`, async ({ page }) => {
    const { methods } = await fixture(page, data(count))
    const previous = page.getByRole("button", { name: "Previous chats", exact: true })
    const next = page.getByRole("button", { name: "Next chats", exact: true })
    if (count < 100) {
      await expect(previous).toHaveCount(0)
      await expect(next).toHaveCount(0)
    } else {
      await expect(previous).toBeDisabled()
      await next.click()
      await expect(page.getByText("Page 2", { exact: true })).toBeVisible()
      await expect(previous).toBeEnabled()
      await expect(next).toBeDisabled()
      await expect(page.locator(".chat-list button")).toHaveCount(count - 100)
      await previous.click()
      await expect(page.locator(".chat-list button")).toHaveCount(100)
    }
    await expect(page.getByRole("button", { name: "Refresh chats", exact: true })).toBeVisible()
    expect(methods.every((method) => method === "GET")).toBe(true)
  })
}

test("does not hide pagination on loading or failure and keeps a later-page route back", async ({
  page,
}) => {
  await fixture(page, data(101))
  await page.getByRole("button", { name: "Next chats", exact: true }).click()
  await expect(page.getByText("Page 2", { exact: true })).toBeVisible()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route("**/api/chats?offset=100", async (route) => {
    await gate
    await route.fulfill({ status: 500, json: { error: "Fixture metadata error" } })
  })
  try {
    await page.getByRole("button", { name: "Refresh chats", exact: true }).click()
    await expect(page.getByRole("button", { name: "Previous chats", exact: true })).toBeDisabled()
    await expect(page.getByText("Loading chats…", { exact: true })).toBeVisible()
  } finally {
    release()
  }
  await expect(
    page.getByText("Could not read chat metadata. Retry chats.", { exact: true }),
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "Previous chats", exact: true })).toBeEnabled()
  await page.getByRole("button", { name: "Previous chats", exact: true }).click()
  await expect(page.locator(".chat-list button")).toHaveCount(100)
})

for (const [width, height, zoom] of [
  [1440, 900, 1],
  [850, 900, 1],
  [390, 844, 1],
  [320, 844, 1],
  [640, 1688, 2],
] as const) {
  test(`task workspace density, reflow, focus, and contrast at ${width}px ${zoom}x`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height })
    const baselineState = data()
    baselineState.snapshot.policy.privateUsers = [42]
    baselineState.inventory.providers.forEach((provider) => {
      provider.configured = false
    })
    await fixture(page, baselineState)
    if (zoom === 2)
      await page.evaluate(() => {
        document.documentElement.style.zoom = "2"
      })
    const bar = page.locator("#save-status")
    await expect(bar).toHaveAttribute("data-compact", "true")
    await expect(bar.getByRole("button")).toHaveCount(0)
    const geometry = await page.evaluate(() => {
      const bounds = (selector: string) => {
        const element = document.querySelector(selector)
        if (!element) throw new Error(`Missing geometry target: ${selector}`)
        return element.getBoundingClientRect()
      }
      const list = bounds(".directory-list-region")
      return {
        fullRows: [...document.querySelectorAll(".chat-list button")].filter((el) => {
          const r = el.getBoundingClientRect()
          return r.top >= list.top && r.bottom <= Math.min(list.bottom, innerHeight)
        }).length,
        saveHeight: bounds("#save-status").height,
        directoryTop: bounds(".chat-directory").top,
        headerHeight: bounds(".directory-header").height,
        footerHeight: bounds(".directory-footer").height,
        listHeight: list.height,
        rowHeight: bounds(".chat-list button").height,
      }
    })
    await testInfo.attach("geometry", {
      body: JSON.stringify(geometry),
      contentType: "application/json",
    })
    console.log("GEOMETRY", width, zoom, geometry)
    if (width === 1440) expect(geometry.fullRows).toBeGreaterThanOrEqual(6)
    expect(geometry.saveHeight / zoom).toBeLessThan(93)
    const disclosure = page.locator(".directory-options summary")
    await disclosure.focus()
    await disclosure.press("Enter")
    await expect(page.getByLabel("Chat type", { exact: true })).toBeVisible()
    await expect(page.getByText(/Type and access filters cover this page only/)).toBeVisible()
    await disclosure.press("Enter")
    const row = page.locator(".chat-list button").first()
    await row.focus()
    expect(await row.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe("none")
    expect((await contrast(row.locator("strong"))).text).toBeGreaterThanOrEqual(4.5)
    expect((await contrast(row.locator(".directory-status-label"))).text).toBeGreaterThanOrEqual(
      4.5,
    )
    await row.click()
    await expect(page.locator('.chat-list [aria-current="true"]')).toHaveCount(1)
    await expect(page.getByRole("heading", { name: "Fixture chat 1", exact: true })).toBeVisible()
    await page.getByRole("button", { name: "Copy chat ID", exact: true }).focus()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const back = page.getByRole("button", { name: "Back to chat directory", exact: true })
    if (width <= 850) await back.click()
    await disclosure.click()
    expect(
      (await contrast(page.getByLabel("Chat type", { exact: true }))).border,
    ).toBeGreaterThanOrEqual(3)
  })
}

test("account menu returns keyboard focus and copy feedback reports success and failure", async ({
  page,
}) => {
  await fixture(page)
  const account = page.getByRole("button", { name: "Account", exact: true })
  await account.focus()
  await account.press("Enter")
  await expect(page.getByRole("menuitem", { name: "Sign out", exact: true })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(account).toBeFocused()
  await page.locator(".chat-list button").first().click()
  const copy = page.getByRole("button", { name: "Copy chat ID", exact: true })
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => {} },
    }),
  )
  await copy.click()
  await expect(page.getByText("Chat ID copied.", { exact: true })).toBeVisible()
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("Fixture denied")
        },
      },
    }),
  )
  await copy.click()
  await expect(
    page.getByText("Could not copy. Select the ID to copy it manually.", { exact: true }),
  ).toBeVisible()
})
