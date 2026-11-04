import type { ServiceStatusDiagnostic } from "@narumitw/sumire-contracts"
import {
  initialPolicy,
  resolveStatusSubscription,
  type StatusQuietHours,
  statusNotificationsSchema,
} from "@narumitw/sumire-policy"
import { Theme } from "@radix-ui/themes"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { parseSnapshot, settingsRequestError } from "./api.js"
import { policyChangeCount, policyChangeEntries } from "./policy-changes.js"
import { recoverPolicy } from "./policy-recovery.js"
import { matchingStatusComponents } from "./service-status-components.js"
import { statusDiagnosticText, statusTestBlockReason } from "./service-status-delivery.js"
import { StatusTiming } from "./service-status-timing.js"
import {
  removeStatusDestination,
  statusQuietHoursError,
  statusSelectionError,
  withStatusOverride,
} from "./status-notifications.js"

const hours: StatusQuietHours = { timeZone: "Asia/Taipei", start: "22:00", end: "08:00" }

describe("notification-only chat editing", () => {
  it("distinguishes inheritance, explicit all/none, and override-only providers", () => {
    const policy = initialPolicy()
    policy.statusNotifications.chatIds = [42, -100]
    policy.statusNotifications.providers = ["github"]
    policy.statusNotifications.componentSelections = { github: ["region"], openai: ["api"] }
    policy.statusNotifications.quietHours = hours
    policy.statusNotifications.batchWindowSeconds = 300
    let settings = withStatusOverride(policy.statusNotifications, 42, "providers", ["openai"])
    settings = withStatusOverride(settings, 42, "componentSelections", { github: [], openai: null })
    settings = withStatusOverride(settings, 42, "quietHours", null)
    settings = withStatusOverride(settings, 42, "batchWindowSeconds", 0)
    expect(resolveStatusSubscription(settings, 42)).toMatchObject({
      providers: ["openai"],
      componentSelections: { github: [], openai: null },
      quietHours: null,
      batchWindowSeconds: 0,
    })
    expect(resolveStatusSubscription(settings, -100)).toMatchObject({
      providers: ["github"],
      componentSelections: { github: ["region"], openai: ["api"] },
      quietHours: hours,
      batchWindowSeconds: 300,
    })
    settings = withStatusOverride(settings, 42, "providers", [])
    expect(resolveStatusSubscription(settings, 42)?.providers).toEqual([])
    for (const key of [
      "providers",
      "componentSelections",
      "quietHours",
      "batchWindowSeconds",
    ] as const)
      settings = withStatusOverride(settings, 42, key, undefined)
    expect(settings.chatOverrides).toEqual({})
    expect(resolveStatusSubscription(settings, 42)?.providers).toEqual(["github"])
    expect(policy.privateUsers).toEqual([])
    expect(policy.chats).toEqual({})
  })

  it("cannot create a destination through an override and removes overrides with destinations", () => {
    const settings = initialPolicy().statusNotifications
    expect(withStatusOverride(settings, 42, "providers", ["openai"])).toBe(settings)
    settings.chatIds = [42, -100]
    settings.chatOverrides = {
      "42": { quietHours: null, componentSelections: { github: [] } },
      "-100": { minimumImpact: "critical" },
    }
    const next = removeStatusDestination(settings, 42)
    expect(next.chatIds).toEqual([-100])
    expect(next.chatOverrides).toEqual({ "-100": { minimumImpact: "critical" } })
    expect(settings.chatOverrides["42"]).toBeDefined()
    expect(statusNotificationsSchema.safeParse(next).success).toBe(true)
  })

  it("keeps legacy saved policy compatible with all new defaults", () => {
    const policy = initialPolicy()
    const {
      componentSelections: _components,
      quietHours: _hours,
      batchWindowSeconds: _batch,
      chatOverrides: _overrides,
      ...legacy
    } = policy.statusNotifications
    const parsed = parseSnapshot({
      revision: 1,
      applied: 1,
      status: "applied",
      epoch: 1,
      policy: { ...policy, statusNotifications: legacy },
    })
    expect(parsed.policy.statusNotifications).toEqual(policy.statusNotifications)
  })

  it("reports nested reference bounds without truncating or broadening selections", () => {
    const settings = initialPolicy().statusNotifications
    const ids = Array.from({ length: 128 }, (_, index) => `id_${index}`)
    settings.componentSelections = { github: ids, openai: ids, claude: ids, cloudflare: ids }
    expect(statusSelectionError(settings)).toBe("")
    settings.chatIds = [42]
    settings.chatOverrides = { "42": { componentSelections: { github: ["unavailable"] } } }
    expect(statusSelectionError(settings)).toContain("512 IDs in total")
    expect(settings.chatOverrides["42"]?.componentSelections?.github).toEqual(["unavailable"])
    settings.chatOverrides = {}
    settings.componentSelections.github = [...ids, "overflow"]
    expect(statusSelectionError(settings)).toContain("128 IDs")
  })
})

describe("catalog search", () => {
  const catalog = [
    { id: "g1", name: "Published region", status: "operational", isGroup: true },
    { id: "c1", name: "API", status: "degraded_performance", groupId: "g1" },
    { id: "c2", name: "Other", status: "operational" },
  ]
  it("searches IDs, names, and published parent names without deriving geography", () => {
    expect(matchingStatusComponents(catalog, "PUBLISHED REGION").map((item) => item.id)).toEqual([
      "g1",
      "c1",
    ])
    expect(matchingStatusComponents(catalog, " c1 ").map((item) => item.id)).toEqual(["c1"])
    expect(matchingStatusComponents(catalog, "Taiwan")).toEqual([])
    expect(catalog[1]?.groupId).toBe("g1")
  })
})

describe("quiet input guards", () => {
  it.each([
    { ...hours, start: "2:" },
    { ...hours, end: "24:00" },
    { ...hours, start: "08:00" },
    { ...hours, timeZone: "" },
    { ...hours, timeZone: "Local/Unknown" },
    { ...hours, timeZone: "+08:00" },
  ])("requires complete explicit daily windows: %j", (draft) => {
    expect(statusQuietHoursError(draft)).not.toBe("")
    expect(
      statusNotificationsSchema.safeParse({
        ...initialPolicy().statusNotifications,
        quietHours: draft,
      }).success,
    ).toBe(false)
  })
  it("accepts overnight windows in explicit IANA zones", () => {
    expect(statusQuietHoursError(hours)).toBe("")
    expect(statusQuietHoursError({ ...hours, timeZone: "America/New_York" })).toBe("")
  })
  it("renders partial drafts without staging, saving, or repairing them", () => {
    const onQuietChange = vi.fn()
    const onDraft = vi.fn()
    const html = renderToStaticMarkup(
      createElement(
        Theme,
        null,
        createElement(StatusTiming, {
          prefix: "fixture",
          quietHours: null,
          batchWindowSeconds: 0,
          draft: { ...hours, start: "2:", timeZone: "Asia/" },
          disabled: false,
          onQuietChange,
          onDraft,
          onBatchChange: vi.fn(),
        }),
      ),
    )
    expect(html).toContain('value="2:"')
    expect(html).toContain('value="Asia/"')
    expect(html).toContain("Stage quiet window")
    expect(html).toContain("Discard quiet hours input")
    expect(onQuietChange).not.toHaveBeenCalled()
    expect(onDraft).not.toHaveBeenCalled()
  })
})

describe("saved-only manual test guards", () => {
  const application = { revision: 2, applied: 2, status: "applied" }
  it("does not depend on automatic enablement and rejects draft-only, missing, and unapplied targets", () => {
    expect(statusTestBlockReason(application, [42], 42)).toBe("")
    expect(statusTestBlockReason(application, [42], -100)).toContain("only in the draft")
    expect(statusTestBlockReason(application, [42], undefined)).toContain("Select a saved")
    expect(statusTestBlockReason({ ...application, applied: 1 }, [42], 42)).toContain(
      "must be applied",
    )
    expect(statusTestBlockReason({ ...application, status: "failed" }, [42], 42)).toContain(
      "must be applied",
    )
  })
  it("uses fixed friendly diagnostic text for every contract code", () => {
    const codes: ServiceStatusDiagnostic[] = [
      "source_unavailable",
      "delivery_failed",
      "forbidden",
      "chat_unavailable",
      "timeout",
      "queue_full",
      "cancelled",
      "rate_limited",
    ]
    expect(Object.keys(statusDiagnosticText)).toEqual(codes)
    for (const code of codes) expect(statusDiagnosticText[code].length).toBeGreaterThan(20)
  })
})

describe("status review and atomic recovery", () => {
  it("reviews each changed override scope and links to that destination, not Pi chat permissions", () => {
    const saved = initialPolicy()
    saved.statusNotifications.chatIds = [42]
    const draft = structuredClone(saved)
    draft.statusNotifications.componentSelections.github = ["g1", "unavailable"]
    draft.statusNotifications.quietHours = hours
    draft.statusNotifications.batchWindowSeconds = 60
    draft.statusNotifications.chatOverrides["42"] = {
      providers: [],
      minimumImpact: "critical",
      componentSelections: { github: [], openai: null },
      quietHours: null,
      batchWindowSeconds: 900,
    }
    const entries = policyChangeEntries(saved, draft)
    expect(entries).toHaveLength(9)
    expect(policyChangeCount(saved, draft)).toBe(9)
    expect(
      entries.find((entry) => entry.label.includes("2 selected component/group IDs"))?.targets[0]
        ?.selector,
    ).toBe("#status-default-components")
    expect(
      entries
        .filter((entry) => entry.label.includes("chat 42:"))
        .every((entry) => entry.targets[0]?.selector === "#status-chat-42"),
    ).toBe(true)
    expect(
      entries.some((entry) => entry.label.includes("no services (explicit empty override)")),
    ).toBe(true)
    expect(
      entries.some((entry) => entry.label.includes("quiet hours inherit shared quiet hours → off")),
    ).toBe(true)
    const latest = structuredClone(saved)
    latest.statusNotifications.chatOverrides["42"] = {
      providers: ["openai"],
      quietHours: { ...hours, start: "21:00" },
    }
    expect(recoverPolicy(saved, draft, latest).unresolved).toBe(1)
    expect(
      recoverPolicy(saved, draft, latest, { statusNotifications: "draft" }).policy
        .statusNotifications,
    ).toEqual(draft.statusNotifications)
    expect(
      recoverPolicy(saved, draft, latest, { statusNotifications: "saved" }).policy
        .statusNotifications,
    ).toEqual(latest.statusNotifications)
  })
  it("ignores component order and equivalent shared all selections but preserves explicit inheritance", () => {
    const saved = initialPolicy()
    saved.statusNotifications.componentSelections = { github: ["a", "b"] }
    saved.statusNotifications.chatIds = [42]
    const draft = structuredClone(saved)
    draft.statusNotifications.componentSelections = { github: ["b", "a"], openai: null }
    expect(policyChangeCount(saved, draft)).toBe(0)
    draft.statusNotifications.chatOverrides["42"] = { componentSelections: { openai: null } }
    expect(policyChangeCount(saved, draft)).toBe(1)
  })
})

describe("complete settings request size", () => {
  it("measures UTF-8 and the envelope without truncating the policy", () => {
    const policy = initialPolicy()
    policy.tools = ["漢".repeat(90_000)]
    expect(JSON.stringify(policy).length).toBeLessThan(262_144)
    expect(settingsRequestError(1, policy)).toContain("262,144 bytes")
    expect(policy.tools[0]?.length).toBe(90_000)
  })
  it("permits exactly the request bound and blocks the next byte before review", () => {
    const policy = initialPolicy()
    policy.tools = [""]
    const envelopeSize = new TextEncoder().encode(
      JSON.stringify({ revision: 1, policy }),
    ).byteLength
    policy.tools = ["x".repeat(262_144 - envelopeSize)]
    expect(settingsRequestError(1, policy)).toBe("")
    policy.tools[0] += "x"
    expect(settingsRequestError(1, policy)).toContain("262,145 bytes")
  })
})
