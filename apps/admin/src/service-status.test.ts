import {
  initialPolicy,
  type Policy,
  statusNotificationsSchema,
  statusProviderIds,
} from "@narumitw/sumire-policy"
import { Theme } from "@radix-ui/themes"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { ServiceStatus } from "./service-status.js"
import {
  statusChatIdError,
  statusPollingIntervals,
  statusProviderNames,
} from "./status-notifications.js"

function render(policy = initialPolicy(), saved = policy, disabled = false) {
  const onChange = vi.fn()
  const onPending = vi.fn()
  const html = renderToStaticMarkup(
    createElement(
      Theme,
      null,
      createElement(ServiceStatus, {
        policy,
        saved,
        disabled,
        csrf: "fixture",
        application: { revision: 1, applied: 1, status: "applied" },
        onChange,
        onPending,
        onSessionExpired: vi.fn(),
      }),
    ),
  )
  expect(onChange).not.toHaveBeenCalled()
  expect(onPending).not.toHaveBeenCalled()
  return html
}

function checkbox(html: string, label: string) {
  const control = [...html.matchAll(/<button\b[^>]*>/g)].find((match) =>
    match[0].includes(`aria-label="${label}"`),
  )?.[0]
  expect(control).toBeDefined()
  return control ?? ""
}

describe("notification destination validation", () => {
  it.each([
    "",
    "0",
    "-0",
    "+42",
    "0042",
    "-00100",
    " 42",
    "42 ",
    "42\n",
    "42.0",
    "4.2",
    "1e3",
    "0x2a",
    "NaN",
    "Infinity",
    "42x",
    "--42",
    "9007199254740992",
    "-9007199254740992",
    "https://t.me/example",
    "@example",
    "４２",
  ])("rejects noncanonical or unsafe ID %j before staging", (value) => {
    expect(statusChatIdError(value, [])).toContain("canonical, non-zero Telegram chat ID")
  })

  it.each(["1", "-1", "42", "-1001234567890", "9007199254740991", "-9007199254740991"])(
    "accepts canonical ID %s accepted by policy",
    (value) => {
      expect(statusChatIdError(value, [])).toBe("")
      const settings = initialPolicy().statusNotifications
      expect(
        statusNotificationsSchema.safeParse({ ...settings, chatIds: [Number(value)] }).success,
      ).toBe(true)
    },
  )

  it("rejects duplicates and capacity overflow without changing the selection", () => {
    const ids = Array.from({ length: 1000 }, (_, index) => index + 1)
    expect(statusChatIdError("42", ids)).toContain("already selected")
    expect(statusChatIdError("-100", ids)).toContain("limit is 1,000")
    expect(statusChatIdError("-100", ids.slice(1))).toBe("")
    expect(ids).toHaveLength(1000)
  })

  it("keeps bounded polling choices and retains custom saved integers", () => {
    for (const seconds of [60, 61, 3599, 3600]) {
      const intervals = statusPollingIntervals(seconds)
      expect(intervals).toContain(seconds)
      expect(new Set(intervals).size).toBe(intervals.length)
      expect(intervals).toEqual([...intervals].sort((a, b) => a - b))
      for (const pollIntervalSeconds of intervals)
        expect(
          statusNotificationsSchema.safeParse({
            ...initialPolicy().statusNotifications,
            pollIntervalSeconds,
          }).success,
        ).toBe(true)
    }
  })
})

describe("service status editor", () => {
  it("uses policy service IDs and exposes independent delivery controls with maintenance off", () => {
    const html = render()
    expect(Object.keys(statusProviderNames)).toEqual([...statusProviderIds])
    for (const name of Object.values(statusProviderNames))
      expect(checkbox(html, name)).toContain('aria-checked="true"')
    expect(checkbox(html, "Enable service status notifications")).toContain('aria-checked="false"')
    expect(checkbox(html, "Notify incident updates")).toContain('aria-checked="true"')
    expect(checkbox(html, "Notify resolved incidents")).toContain('aria-checked="true"')
    expect(checkbox(html, "Include scheduled maintenance")).toContain('aria-checked="false"')
    expect(html).toContain('aria-label="Polling interval"')
    expect(html).toContain('aria-label="Minimum impact"')
    expect(html).toContain('id="status-notification-chat-id"')
    expect(html).toContain('aria-label="Stored notification destinations"')
    expect(html).toContain("Search stored chats")
    expect(html).toContain("Up to 100 matches per page.")
    expect(html).not.toContain("No notifications will be sent.")
  })

  it("explains no model calls, shared settings, recipient requirements, and no Pi access", () => {
    const html = render()
    for (const text of [
      "Sources use original status-page text.",
      "No model calls are made.",
      "does not grant Pi access",
      "or tool permissions.",
      "must send /start to the bot first.",
      "posting",
      "rights.",
      "Shared defaults apply",
      "unless a destination overrides that setting.",
      "including chats not",
      "yet observed.",
      "No URLs, plus signs, spaces, or leading zeros.",
    ])
      expect(html).toContain(text)
  })

  it.each([
    { providers: [], chatIds: [], missing: ["service", "destination"] },
    { providers: ["github"], chatIds: [], missing: ["destination"] },
    { providers: [], chatIds: [42], missing: ["service"] },
  ] as const)("warns about enabled no-send selections: %j", ({ providers, chatIds, missing }) => {
    const policy = initialPolicy()
    policy.statusNotifications = {
      ...policy.statusNotifications,
      enabled: true,
      providers: [...providers],
      chatIds: [...chatIds],
    }
    const html = render(policy)
    expect(html).toContain('role="alert"')
    expect(html).toContain("No notifications will be sent.")
    for (const name of ["service", "destination"])
      expect(html.includes(`Select at least one ${name}.`)).toBe(
        missing.some((value) => value === name),
      )
  })

  it("does not treat shared provider defaults as a gate for an explicit chat subscription", () => {
    const policy = initialPolicy()
    policy.statusNotifications.enabled = true
    policy.statusNotifications.chatIds = [42]
    policy.statusNotifications.providers = []
    policy.statusNotifications.chatOverrides = { "42": { providers: ["openai"] } }
    expect(render(policy)).not.toContain("No notifications will be sent.")
  })

  it("keeps saved and staged destination IDs visible without directory metadata", () => {
    const saved = initialPolicy()
    saved.statusNotifications.chatIds = [42]
    const policy: Policy = structuredClone(saved)
    policy.statusNotifications.enabled = true
    policy.statusNotifications.chatIds.push(-1001234567890)
    const html = render(policy, saved)
    expect(html).toContain("2 selected destinations")
    expect(html).toContain('aria-label="Remove destination 42"')
    expect(html).toContain('aria-label="Remove destination -1001234567890"')
    expect(html).toContain("Pending addition")
    expect(html).toContain("Saved")
    expect(html).not.toContain("No notifications will be sent.")
  })

  it("disables controls while another operation owns the policy", () => {
    const html = render(initialPolicy(), initialPolicy(), true)
    for (const name of [
      ...Object.values(statusProviderNames),
      "Enable service status notifications",
      "Notify incident updates",
      "Notify resolved incidents",
      "Include scheduled maintenance",
    ])
      expect(checkbox(html, name)).toContain('disabled=""')
    expect(html.match(/<input[^>]*id="status-notification-chat-id"[^>]*>/)?.[0]).toContain(
      'disabled=""',
    )
  })
})
