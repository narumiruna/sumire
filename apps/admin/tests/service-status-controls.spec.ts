import type {
  ServiceStatusCatalog,
  ServiceStatusDeliveryRecord,
  ServiceStatusDeliveryResponse,
  ServiceStatusTestResult,
} from "@narumitw/sumire-contracts"
import { resolveStatusSubscription } from "@narumitw/sumire-policy"
import { expect, type Locator, type Page, test } from "@playwright/test"
import type { Policy } from "../src/api.js"
import { navigate, openDisclosure } from "./admin-fixture.js"
import { policyRecoveryFixture } from "./policy-recovery-fixture.js"

const now = 1_800_000_000_000
async function controlsFixture(page: Page, setup: (policy: Policy) => void = () => {}) {
  const fixture = await policyRecoveryFixture(page)
  fixture.advance((policy) => {
    policy.statusNotifications.chatIds = [42, -100]
    policy.statusNotifications.providers = ["github"]
    setup(policy)
  })
  const calls: {
    method: string
    path: string
    params: URLSearchParams
    body?: unknown
    csrf?: string
  }[] = []
  const state = {
    catalogFailure: false,
    testStatus: 200,
    success: true,
    code: null as ServiceStatusTestResult["code"],
  }
  await page.route("**/api/service-status/**", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    calls.push({
      method: request.method(),
      path: url.pathname,
      params: url.searchParams,
      body: request.method() === "POST" ? request.postDataJSON() : undefined,
      csrf: request.headers()["x-csrf-token"],
    })
    if (fixture.state.expired)
      return route.fulfill({ status: 401, json: { error: "Session expired" } })
    if (url.pathname === "/api/service-status/test") {
      expect(request.method()).toBe("POST")
      expect(request.headers()["x-csrf-token"]).toBe("fixture")
      if (state.testStatus !== 200)
        return route.fulfill({
          status: state.testStatus,
          json: { error: "Fixture rejection must not be interpreted as a diagnostic" },
        })
      const input = request.postDataJSON()
      const result: ServiceStatusTestResult = {
        chatId: input.chatId,
        success: state.success,
        code: state.code,
        attemptedAt: now,
      }
      return route.fulfill({ json: result })
    }
    expect(request.method()).toBe("GET")
    if (url.pathname === "/api/service-status/components") {
      if (state.catalogFailure)
        return route.fulfill({ status: 503, json: { error: "Fixture unavailable" } })
      const catalog: ServiceStatusCatalog = {
        provider: url.searchParams.get("provider") as ServiceStatusCatalog["provider"],
        fetchedAt: now - 1000,
        stale: true,
        error: "source_unavailable",
        components: [
          { id: "group_region", name: "Published region", status: "operational", isGroup: true },
          { id: "api", name: "API", status: "degraded_performance", groupId: "group_region" },
          { id: "workflow", name: "Workflow", status: "operational", groupId: "group_region" },
          { id: "other", name: "Other component", status: "operational" },
        ],
      }
      return route.fulfill({ json: catalog })
    }
    if (url.pathname === "/api/service-status/deliveries") {
      const offset = Number(url.searchParams.get("offset"))
      const item: ServiceStatusDeliveryRecord = {
        chatId: 42,
        provider: "github",
        lastAttemptAt: now,
        lastSuccessAt: now - 120_000,
        lastFailureAt: now - 60_000,
        lastError: "forbidden",
        pendingCount: 3,
        nextDueAt: now + 60_000,
      }
      const response: ServiceStatusDeliveryResponse = {
        items:
          offset === 0 ? [item] : [{ ...item, chatId: -100, provider: "test", pendingCount: 0 }],
        sources: [
          {
            provider: "github",
            lastAttemptAt: now,
            lastSuccessAt: now - 120_000,
            lastFailureAt: now,
            lastError: "source_unavailable",
          },
        ],
        offset,
        limit: 100,
        total: 101,
        serverTime: now,
        nextPollAt: now + 60_000,
      }
      return route.fulfill({ json: response })
    }
    throw new Error(`Unexpected mocked endpoint ${url.pathname}`)
  })
  await page.reload()
  await navigate(page, "Service status")
  await expect(
    page.getByRole("button", { name: "Refresh delivery results", exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole("region", { name: "Destination delivery results", exact: true }),
  ).toContainText("Pending notices")
  return {
    ...fixture,
    calls,
    statusState: state,
    tests: () => calls.filter((call) => call.method === "POST"),
  }
}

async function choose(page: Page, scope: Locator, name: string, value: string) {
  await scope.getByRole("combobox", { name, exact: true }).click()
  await page.getByRole("option", { name: value, exact: true }).click()
}
async function save(page: Page) {
  await page.getByRole("button", { name: "Review and save changes", exact: true }).click()
  await page
    .getByRole("alertdialog", { name: "Save settings changes?", exact: true })
    .getByRole("button", { name: "Save changes", exact: true })
    .click()
  await expect(page.locator('#save-status[data-compact="true"]')).toBeVisible()
}
const shared = (page: Page) => page.locator("#status-default-components")
const overrides = (page: Page, id = 42) =>
  page.getByRole("region", { name: `Notification overrides for ${id}`, exact: true })

async function confirmTest(page: Page) {
  await page.getByRole("button", { name: "Send test notification", exact: true }).click()
  const dialog = page.getByRole("alertdialog", { name: "Send a service status test?", exact: true })
  await expect(dialog).toContainText("No browser draft will be saved")
  await dialog.getByRole("button", { name: "Confirm test notification", exact: true }).click()
}

test("shared defaults and per-chat subscriptions inherit or override independently, save, and reload", async ({
  page,
}) => {
  const fixture = await controlsFixture(page)
  const chat = overrides(page)
  await expect(
    chat.getByRole("checkbox", { name: "Use shared services", exact: true }),
  ).toBeChecked()
  await chat.getByRole("checkbox", { name: "Use shared services", exact: true }).uncheck()
  await chat.getByRole("checkbox", { name: "GitHub for this chat", exact: true }).uncheck()
  await chat.getByRole("checkbox", { name: "OpenAI for this chat", exact: true }).check()
  await choose(page, chat, "Chat minimum impact", "Critical")
  const components = chat.locator("#status-chat-components")
  await choose(page, components, "Component coverage", "No components")
  await choose(page, chat, "Daily quiet window", "Off")
  await choose(page, chat, "Group ordinary updates", "60 seconds")
  await save(page)
  const settings = fixture.snapshot().policy.statusNotifications
  expect(settings.chatOverrides["42"]).toEqual({
    providers: ["openai"],
    minimumImpact: "critical",
    componentSelections: { github: [] },
    quietHours: null,
    batchWindowSeconds: 60,
  })
  expect(settings.providers).toEqual(["github"])
  expect(resolveStatusSubscription(settings, -100)?.providers).toEqual(["github"])
  expect(resolveStatusSubscription(settings, 42)?.providers).toEqual(["openai"])
  expect(fixture.snapshot().policy.privateUsers).toEqual([42])
  await page.reload()
  await expect(
    chat.getByRole("checkbox", { name: "OpenAI for this chat", exact: true }),
  ).toBeChecked()
  await expect(
    chat.getByRole("combobox", { name: "Chat minimum impact", exact: true }),
  ).toContainText("Critical")
  await choose(page, components, "Component coverage", "Inherit shared selection")
  await choose(page, chat, "Daily quiet window", "Inherit shared quiet hours")
  await choose(page, chat, "Group ordinary updates", "Inherit shared grouping")
  await choose(page, chat, "Chat minimum impact", "Inherit shared impact (minor)")
  await chat.getByRole("checkbox", { name: "Use shared services", exact: true }).check()
  await save(page)
  expect(fixture.snapshot().policy.statusNotifications.chatOverrides).toEqual({})
  expect(fixture.tests()).toEqual([])
})

test("catalog search uses published groups and IDs, retains unavailable IDs through stale and failed reads", async ({
  page,
}) => {
  const fixture = await controlsFixture(page, (policy) => {
    policy.statusNotifications.componentSelections = { github: ["missing_saved_id"] }
  })
  const components = shared(page)
  await expect(components).toContainText("Unavailable ID retained")
  await expect(components).toContainText("Catalog is stale")
  await expect(components).toContainText("Incidents without a known component association")
  const search = components.getByRole("textbox", {
    name: "Search components and published groups",
    exact: true,
  })
  const count = fixture.calls.filter((call) => call.path.endsWith("/components")).length
  await search.fill("Published region")
  await expect(components.getByRole("checkbox", { name: "API · api", exact: true })).toBeVisible()
  await expect(
    components.getByRole("checkbox", { name: "Other component · other", exact: true }),
  ).toHaveCount(0)
  await components
    .getByRole("checkbox", { name: "Published region · group_region", exact: true })
    .check()
  await search.fill("workflow")
  await expect(
    components.getByRole("checkbox", { name: "Workflow · workflow", exact: true }),
  ).toBeVisible()
  await search.fill("no matches")
  await expect(
    components.getByRole("list", { name: "Selected component IDs", exact: true }),
  ).toContainText("missing_saved_id")
  expect(fixture.calls.filter((call) => call.path.endsWith("/components"))).toHaveLength(count)
  fixture.statusState.catalogFailure = true
  await components.getByRole("button", { name: "Refresh component catalog", exact: true }).click()
  await expect(components.getByRole("alert")).toContainText("Your selections have not changed")
  await save(page)
  expect(fixture.snapshot().policy.statusNotifications.componentSelections.github).toEqual([
    "missing_saved_id",
    "group_region",
  ])
  await page.reload()
  await expect(
    components.getByRole("list", { name: "Selected component IDs", exact: true }),
  ).toContainText("group_region")
})

test("partial quiet hours block review, survive navigation and chat switching, and require valid explicit staging", async ({
  page,
}) => {
  const fixture = await controlsFixture(page)
  const timing = page.locator("#status-default-timing")
  await choose(page, timing, "Daily quiet window", "Daily quiet window")
  await timing.getByRole("textbox", { name: "Quiet start (HH:mm)", exact: true }).fill("2:")
  await timing.getByRole("textbox", { name: "IANA time zone", exact: true }).fill("Asia/")
  await navigate(page, "Defaults")
  await expect(
    page.getByRole("button", { name: "Review and save changes", exact: true }),
  ).toBeDisabled()
  await page
    .getByRole("button", {
      name: "Continue editing: Service status — quiet hours input",
      exact: true,
    })
    .click()
  await page
    .getByRole("button", { name: "Continue quiet input: Shared defaults", exact: true })
    .click()
  await expect(timing.getByRole("textbox", { name: "IANA time zone", exact: true })).toBeFocused()
  await expect(
    timing.getByRole("textbox", { name: "Quiet start (HH:mm)", exact: true }),
  ).toHaveValue("2:")
  await timing.getByRole("button", { name: "Stage quiet window", exact: true }).click()
  await expect(timing.getByRole("alert")).toContainText("complete start and end times")
  await timing.getByRole("textbox", { name: "Quiet start (HH:mm)", exact: true }).fill("08:00")
  await timing.getByRole("textbox", { name: "IANA time zone", exact: true }).fill("Asia/Taipei")
  await timing.getByRole("button", { name: "Stage quiet window", exact: true }).click()
  await expect(timing.getByRole("alert")).toContainText("different start and end times")
  await timing.getByRole("textbox", { name: "Quiet start (HH:mm)", exact: true }).fill("21:30")
  await timing.getByRole("button", { name: "Stage quiet window", exact: true }).click()
  const chat = overrides(page)
  await choose(page, chat, "Daily quiet window", "Daily quiet window")
  await chat.getByRole("textbox", { name: "IANA time zone", exact: true }).fill("America/")
  await choose(page, page.locator("#status-chat-overrides"), "Subscription destination", "-100")
  await page.getByRole("button", { name: "Continue quiet input: Chat 42", exact: true }).click()
  await expect(chat.getByRole("textbox", { name: "IANA time zone", exact: true })).toHaveValue(
    "America/",
  )
  await chat.getByRole("button", { name: "Discard quiet hours input", exact: true }).click()
  await choose(page, chat, "Daily quiet window", "Inherit shared quiet hours")
  await save(page)
  expect(fixture.snapshot().policy.statusNotifications.quietHours).toEqual({
    timeZone: "Asia/Taipei",
    start: "21:30",
    end: "08:00",
  })
  expect(fixture.snapshot().policy.statusNotifications.chatOverrides).toEqual({})
})

test("discarding settings leaves quiet input visible and clearable without saving it", async ({
  page,
}) => {
  const fixture = await controlsFixture(page)
  const timing = page.locator("#status-default-timing")
  await choose(page, timing, "Daily quiet window", "Daily quiet window")
  await timing.getByRole("textbox", { name: "IANA time zone", exact: true }).fill("Asia/")
  page.once("dialog", (dialog) => void dialog.accept())
  await page.getByRole("button", { name: "Discard settings changes", exact: true }).click()
  await expect(timing.getByRole("textbox", { name: "IANA time zone", exact: true })).toHaveValue(
    "Asia/",
  )
  await timing.getByRole("button", { name: "Discard quiet hours input", exact: true }).click()
  await expect(page.locator('#save-status[data-compact="true"]')).toBeVisible()
  expect(fixture.writes).toHaveLength(0)
})

test("manual test requires confirmation, uses saved applied revision while disabled, and never autosaves a draft", async ({
  page,
}) => {
  const fixture = await controlsFixture(page)
  const revision = fixture.snapshot().revision
  await choose(page, page.locator("#status-notification-filters"), "Minimum impact", "Major")
  await page.getByRole("button", { name: "Send test notification", exact: true }).click()
  const dialog = page.getByRole("alertdialog", { name: "Send a service status test?", exact: true })
  await expect(dialog).toContainText("bypasses automatic enablement, quiet hours, and grouping")
  expect(fixture.tests()).toHaveLength(0)
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
  expect(fixture.tests()).toHaveLength(0)
  await confirmTest(page)
  await expect(
    page.getByText("Telegram accepted the test message.", { exact: false }),
  ).toBeVisible()
  expect(fixture.tests()).toHaveLength(1)
  expect(fixture.tests()[0]).toMatchObject({
    path: "/api/service-status/test",
    method: "POST",
    csrf: "fixture",
    body: { chatId: 42, revision, confirm: true },
  })
  expect(fixture.writes).toHaveLength(0)
  expect(fixture.snapshot().policy.statusNotifications).toMatchObject({
    enabled: false,
    minimumImpact: "minor",
  })
  await expect(page.getByRole("combobox", { name: "Minimum impact", exact: true })).toContainText(
    "Major",
  )
  await expect(
    page.getByRole("button", { name: "Review and save changes", exact: true }),
  ).toBeEnabled()
})

test("draft-only destinations cannot be tested, and unapplied saved settings disable testing", async ({
  page,
}) => {
  const fixture = await controlsFixture(page)
  await openDisclosure(page, "Add an exact Telegram chat ID")
  await page
    .getByRole("textbox", { name: "Telegram notification chat ID", exact: true })
    .fill("-123456")
  await page.getByRole("button", { name: "Add destination", exact: true }).click()
  await choose(page, page.locator(".status-test-panel"), "Test destination", "-123456 · Draft only")
  await expect(
    page.getByRole("button", { name: "Send test notification", exact: true }),
  ).toBeDisabled()
  await expect(page.locator(".status-test-panel")).toContainText("only in the draft")
  expect(fixture.tests()).toHaveLength(0)
  expect(fixture.writes).toHaveLength(0)
  fixture.statusState.success = false
  fixture.statusState.code = "forbidden"
  await choose(page, page.locator(".status-test-panel"), "Test destination", "42 · Saved")
  await confirmTest(page)
  await expect(page.locator(".status-test-panel")).toContainText(
    "Telegram denied delivery. Check bot access and posting rights.",
  )
  fixture.state.lag = 1
  await page.reload()
  await expect(
    page.getByRole("button", { name: "Send test notification", exact: true }),
  ).toBeDisabled()
  await expect(page.locator(".status-test-panel")).toContainText("must be applied before testing")
  expect(fixture.tests()).toHaveLength(1)
})

test("409 test conflict retains drafts, blocks further sends, and does not autosave or retry on refresh", async ({
  page,
}) => {
  const fixture = await controlsFixture(page)
  await choose(page, page.locator("#status-notification-filters"), "Minimum impact", "Critical")
  fixture.statusState.testStatus = 409
  await confirmTest(page)
  await expect(page.locator(".status-test-panel").getByRole("alert")).toContainText(
    "The test was not retried and your draft was not saved",
  )
  await expect(
    page.getByRole("button", { name: "Send test notification", exact: true }),
  ).toBeDisabled()
  await page.getByRole("button", { name: "Refresh delivery results", exact: true }).click()
  await navigate(page, "Defaults")
  await navigate(page, "Service status")
  await expect(page.getByRole("combobox", { name: "Minimum impact", exact: true })).toContainText(
    "Critical",
  )
  expect(fixture.tests()).toHaveLength(1)
  expect(fixture.writes).toHaveLength(0)
})

test("401 from a confirmed manual test expires the session and never retries the mutation", async ({
  page,
}) => {
  const fixture = await controlsFixture(page)
  fixture.statusState.testStatus = 401
  await confirmTest(page)
  await expect(
    page.getByRole("button", { name: "Sign in with passkey", exact: true }),
  ).toBeVisible()
  expect(fixture.tests()).toHaveLength(1)
  expect(fixture.writes).toHaveLength(0)
})

test("delivery results are paginated read-only records with separate source and send failures", async ({
  page,
}) => {
  const fixture = await controlsFixture(page)
  const health = page.getByRole("region", { name: "Source fetch health", exact: true })
  await expect(health).toContainText("The status source is unavailable")
  const deliveries = page.getByRole("region", { name: "Destination delivery results", exact: true })
  for (const label of [
    "Last attempt",
    "Last success",
    "Last failure",
    "Pending notices",
    "Next due",
  ])
    await expect(deliveries).toContainText(label)
  await expect(deliveries).toContainText("Telegram denied delivery")
  await expect(deliveries).toContainText("3")
  await page.getByRole("button", { name: "Next delivery results", exact: true }).click()
  await expect(deliveries).toContainText("-100")
  await expect(page.getByText("101–101 of 101", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Refresh delivery results", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Refresh delivery results", exact: true }),
  ).toBeEnabled()
  expect(
    fixture.calls.some(
      (call) => call.path.endsWith("/deliveries") && call.params.get("offset") === "100",
    ),
  ).toBe(true)
  expect(fixture.tests()).toHaveLength(0)
  expect(fixture.writes).toHaveLength(0)
})

test("401 on a health refresh clears partial drafts and expires the session without sending", async ({
  page,
}) => {
  const fixture = await controlsFixture(page)
  const timing = page.locator("#status-default-timing")
  await choose(page, timing, "Daily quiet window", "Daily quiet window")
  await timing.getByRole("textbox", { name: "IANA time zone", exact: true }).fill("Asia/")
  fixture.state.expired = true
  await page.getByRole("button", { name: "Refresh delivery results", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Sign in with passkey", exact: true }),
  ).toBeVisible()
  expect(fixture.tests()).toHaveLength(0)
  expect(fixture.writes).toHaveLength(0)
})

test("removing a destination removes its entire override and quiet input, never Pi grants", async ({
  page,
}) => {
  const fixture = await controlsFixture(page, (policy) => {
    policy.statusNotifications.chatOverrides["42"] = {
      providers: ["openai"],
      quietHours: { timeZone: "Asia/Taipei", start: "22:00", end: "08:00" },
      componentSelections: { openai: ["api"] },
    }
  })
  await overrides(page).getByRole("textbox", { name: "IANA time zone", exact: true }).fill("Asia/")
  await page.getByRole("button", { name: "Remove destination 42", exact: true }).click()
  await expect(
    page.getByRole("button", {
      name: "Continue editing: Service status — quiet hours input",
      exact: true,
    }),
  ).toHaveCount(0)
  await save(page)
  expect(fixture.snapshot().policy.statusNotifications.chatIds).toEqual([-100])
  expect(fixture.snapshot().policy.statusNotifications.chatOverrides).toEqual({})
  expect(fixture.snapshot().policy.privateUsers).toEqual([42])
  expect(fixture.snapshot().policy.groups).toEqual([-100, -101])
})

test("conflicting status scopes recover atomically without combining components, overrides, or recipients", async ({
  page,
}) => {
  const fixture = await controlsFixture(page)
  await choose(page, shared(page), "Component coverage", "Selected components or groups")
  await shared(page)
    .getByRole("checkbox", { name: "Published region · group_region", exact: true })
    .check()
  await choose(page, overrides(page), "Daily quiet window", "Off")
  fixture.advance((policy) => {
    policy.statusNotifications.chatIds = [-100]
    policy.statusNotifications.componentSelections = { github: ["other"] }
    policy.statusNotifications.chatOverrides = {
      "-100": { providers: [], batchWindowSeconds: 900 },
    }
  })
  await page.getByRole("button", { name: "Review and save changes", exact: true }).click()
  const review = page.getByRole("alertdialog", { name: "Save settings changes?", exact: true })
  await expect(review).toContainText("chat 42: quiet hours inherit shared quiet hours → off")
  await review.getByRole("button", { name: "Save changes", exact: true }).click()
  await page.getByRole("button", { name: "Load latest and review draft", exact: true }).click()
  const recovery = page.getByRole("dialog", {
    name: "Review recovered settings draft",
    exact: true,
  })
  await expect(
    recovery.getByRole("button", { name: "Use recovered draft", exact: true }),
  ).toBeDisabled()
  await recovery
    .getByRole("radiogroup", { name: "Service status notifications", exact: true })
    .getByRole("radio", { name: "Use draft value", exact: true })
    .click()
  await recovery.getByRole("button", { name: "Use recovered draft", exact: true }).click()
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Save changes", exact: true })
    .click()
  await expect(page.locator('#save-status[data-compact="true"]')).toBeVisible()
  expect(fixture.snapshot().policy.statusNotifications).toMatchObject({
    chatIds: [42, -100],
    componentSelections: { github: ["group_region"] },
    chatOverrides: { "42": { quietHours: null } },
  })
  expect(fixture.snapshot().policy.statusNotifications.chatOverrides["-100"]).toBeUndefined()
  expect(fixture.tests()).toHaveLength(0)
})

test("320px component, quiet, health, and confirmation controls support keyboard without overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 })
  const fixture = await controlsFixture(page)
  await choose(page, shared(page), "Component coverage", "Selected components or groups")
  const group = shared(page).getByRole("checkbox", {
    name: "Published region · group_region",
    exact: true,
  })
  await group.focus()
  await page.keyboard.press("Space")
  await expect(group).toBeChecked()
  await choose(
    page,
    page.locator("#status-default-timing"),
    "Daily quiet window",
    "Daily quiet window",
  )
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByRole("button", { name: "Send test notification", exact: true }).click()
  const dialog = page.getByRole("alertdialog", { name: "Send a service status test?", exact: true })
  await expect(dialog).toBeVisible()
  expect(
    await dialog.evaluate((element) => element.getBoundingClientRect().width <= innerWidth),
  ).toBe(true)
  await page.keyboard.press("Escape")
  await expect(dialog).not.toBeVisible()
  await expect(
    page.getByRole("button", { name: "Send test notification", exact: true }),
  ).toBeFocused()
  expect(fixture.tests()).toHaveLength(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
