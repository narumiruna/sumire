import { describe, expect, expectTypeOf, it } from "vitest"
import type { z } from "zod"
import {
  effectivePolicy,
  initialPolicy,
  initialStatusNotifications,
  resolveStatusSubscription,
  type StatusChatOverride,
  type StatusNotifications,
  type StatusProviderId,
  type StatusQuietHours,
  type StatusSubscription,
  statusNotificationsSchema,
  statusProviderIds,
} from "../src/index.js"

const legacy = {
  enabled: true,
  providers: ["github"],
  chatIds: [42, -100],
  pollIntervalSeconds: 60,
  minimumImpact: "minor",
  notifyUpdates: true,
  notifyResolved: true,
  includeMaintenance: false,
} satisfies z.input<typeof statusNotificationsSchema>

const quietHours: StatusQuietHours = {
  timeZone: "Asia/Taipei",
  start: "22:00",
  end: "08:00",
}

describe("status subscription defaults and resolution", () => {
  it("normalizes legacy settings without changing effective recipients or delivery filters", () => {
    const settings = statusNotificationsSchema.parse(legacy)
    expect(settings).toEqual({
      ...legacy,
      componentSelections: {},
      quietHours: null,
      batchWindowSeconds: 0,
      chatOverrides: {},
    })
    for (const chatId of legacy.chatIds)
      expect(resolveStatusSubscription(settings, chatId)).toEqual({
        chatId,
        providers: ["github"],
        minimumImpact: "minor",
        componentSelections: { github: null, openai: null, claude: null, cloudflare: null },
        quietHours: null,
        batchWindowSeconds: 0,
        notifyUpdates: true,
        notifyResolved: true,
        includeMaintenance: false,
      })
    expect(resolveStatusSubscription(settings, 99)).toBeUndefined()
  })

  it("creates independent defaults for initial and parsed settings", () => {
    const initial = initialStatusNotifications()
    const parsed = statusNotificationsSchema.parse(legacy)
    for (const settings of [initial, parsed]) {
      settings.componentSelections.github = ["api"]
      settings.chatOverrides["42"] = { providers: [] }
    }
    for (const settings of [
      initialStatusNotifications(),
      statusNotificationsSchema.parse(legacy),
    ]) {
      expect(settings.componentSelections).toEqual({})
      expect(settings.chatOverrides).toEqual({})
      expect(settings.quietHours).toBeNull()
      expect(settings.batchWindowSeconds).toBe(0)
    }
  })

  it("inherits each field but preserves explicit empty providers, components, and no quiet hours", () => {
    const settings = statusNotificationsSchema.parse({
      ...legacy,
      chatIds: [42, -100, 99],
      providers: [],
      componentSelections: { github: ["default-api"], openai: ["default-model"] },
      quietHours,
      batchWindowSeconds: 300,
      notifyUpdates: false,
      notifyResolved: false,
      includeMaintenance: true,
      chatOverrides: {
        "42": {
          providers: ["github", "cloudflare"],
          minimumImpact: "critical",
          componentSelections: { github: null, cloudflare: [] },
          quietHours: null,
          batchWindowSeconds: 0,
        },
        "-100": {},
        "99": { providers: [], componentSelections: { openai: [] } },
      },
    })
    expect(resolveStatusSubscription(settings, 42)).toEqual({
      chatId: 42,
      providers: ["github", "cloudflare"],
      minimumImpact: "critical",
      componentSelections: {
        github: null,
        openai: ["default-model"],
        claude: null,
        cloudflare: [],
      },
      quietHours: null,
      batchWindowSeconds: 0,
      notifyUpdates: false,
      notifyResolved: false,
      includeMaintenance: true,
    })
    expect(resolveStatusSubscription(settings, -100)).toMatchObject({
      providers: [],
      minimumImpact: "minor",
      componentSelections: {
        github: ["default-api"],
        openai: ["default-model"],
        claude: null,
        cloudflare: null,
      },
      quietHours,
      batchWindowSeconds: 300,
    })
    expect(resolveStatusSubscription(settings, 99)).toMatchObject({
      providers: [],
      componentSelections: { github: ["default-api"], openai: [] },
    })
  })

  it("resolves selected disabled-mode subscriptions without granting Pi access", () => {
    const policy = initialPolicy()
    policy.statusNotifications.chatIds = [42]
    policy.statusNotifications.providers = []
    policy.statusNotifications.chatOverrides["42"] = { providers: ["openai"] }
    expect(policy.statusNotifications.enabled).toBe(false)
    expect(resolveStatusSubscription(policy.statusNotifications, 42)?.providers).toEqual(["openai"])
    expect(resolveStatusSubscription(policy.statusNotifications, -100)).toBeUndefined()
    expect(effectivePolicy(policy, 42)).toMatchObject({ enabled: false, tools: [], models: [] })
  })

  it("does not expose mutable policy arrays or quiet hours through resolved subscriptions", () => {
    const settings = statusNotificationsSchema.parse({
      ...legacy,
      componentSelections: { github: ["api"] },
      quietHours,
    })
    const resolved = resolveStatusSubscription(settings, 42)
    expect(resolved).toBeDefined()
    resolved?.providers.pop()
    resolved?.componentSelections.github?.push("another")
    if (resolved?.quietHours) resolved.quietHours.start = "23:00"
    expect(settings.providers).toEqual(["github"])
    expect(settings.componentSelections.github).toEqual(["api"])
    expect(settings.quietHours?.start).toBe("22:00")
  })

  it("exports the exact subscription and override field types", () => {
    expectTypeOf<StatusProviderId>().toEqualTypeOf<(typeof statusProviderIds)[number]>()
    expectTypeOf<StatusNotifications["componentSelections"]>().toEqualTypeOf<
      Partial<Record<StatusProviderId, string[] | null>>
    >()
    expectTypeOf<StatusNotifications["batchWindowSeconds"]>().toEqualTypeOf<0 | 60 | 300 | 900>()
    expectTypeOf<StatusNotifications["chatOverrides"]>().toEqualTypeOf<
      Record<string, StatusChatOverride>
    >()
    expectTypeOf<keyof StatusChatOverride>().toEqualTypeOf<
      "providers" | "minimumImpact" | "componentSelections" | "quietHours" | "batchWindowSeconds"
    >()
    expectTypeOf<StatusSubscription["componentSelections"]>().toEqualTypeOf<
      Record<StatusProviderId, string[] | null>
    >()
    expectTypeOf<ReturnType<typeof resolveStatusSubscription>>().toEqualTypeOf<
      StatusSubscription | undefined
    >()
  })
})

describe("status subscription validation", () => {
  it.each([
    null,
    [],
    { other: [] },
    Object.fromEntries([["__proto__", []]]),
    { github: "api" },
    { github: [null] },
    { github: ["api", "api"] },
    { github: Array.from({ length: 129 }, (_, index) => `id_${index}`) },
    ...[
      "",
      "../id",
      "with space",
      "id/",
      "id?",
      "id\n",
      "id\r\n",
      "id\u2028",
      "id\u0000",
      "界",
      "a".repeat(129),
    ].map((id) => ({ github: [id] })),
  ])("rejects invalid shared and per-chat component selections: %j", (componentSelections) => {
    expect(statusNotificationsSchema.safeParse({ ...legacy, componentSelections }).success).toBe(
      false,
    )
    expect(
      statusNotificationsSchema.safeParse({
        ...legacy,
        chatOverrides: { "42": { componentSelections } },
      }).success,
    ).toBe(false)
  })

  it("accepts public IDs, all components, none, and exactly 512 stored references", () => {
    const componentSelections = Object.fromEntries(
      statusProviderIds.map((provider) => [
        provider,
        Array.from({ length: 128 }, (_, index) => `${provider}_${index}`),
      ]),
    )
    const settings = statusNotificationsSchema.parse({ ...legacy, componentSelections })
    expect(settings.componentSelections).toEqual(componentSelections)
    expect(
      statusNotificationsSchema.safeParse({
        ...settings,
        chatOverrides: { "42": { componentSelections: { github: ["one_more"] } } },
      }).success,
    ).toBe(false)
    expect(
      statusNotificationsSchema.parse({
        ...legacy,
        componentSelections: {
          github: ["AZaz09_-", "a".repeat(128)],
          openai: ["01JMXBRMFE6N2NNT7DG6XZQ6PW"],
          claude: null,
          cloudflare: [],
        },
      }).componentSelections,
    ).toMatchObject({ claude: null, cloudflare: [] })
  })

  it("counts stored component references across all overrides, not only shared defaults", () => {
    const ids = Array.from({ length: 128 }, (_, index) => `id_${index}`)
    const settings = {
      ...legacy,
      chatIds: [42, -100, 99],
      componentSelections: { github: ids },
      chatOverrides: {
        "42": { componentSelections: { github: ids, openai: ids } },
        "-100": { componentSelections: { cloudflare: ids } },
      },
    }
    expect(statusNotificationsSchema.safeParse(settings).success).toBe(true)
    expect(
      statusNotificationsSchema.safeParse({
        ...settings,
        chatOverrides: {
          ...settings.chatOverrides,
          "99": { componentSelections: { claude: ["extra"] } },
        },
      }).success,
    ).toBe(false)
  })

  it.each(["Asia/Taipei", "America/New_York", "Australia/Lord_Howe", "Etc/UTC", "UTC"])(
    "accepts IANA zone %s with daytime or overnight windows",
    (timeZone) => {
      for (const [start, end] of [
        ["00:00", "23:59"],
        ["22:00", "08:00"],
      ])
        expect(
          statusNotificationsSchema.safeParse({
            ...legacy,
            quietHours: { timeZone, start, end },
            chatOverrides: { "42": { quietHours: { timeZone, start, end } } },
          }).success,
        ).toBe(true)
    },
  )

  it.each([undefined, "", "Not/A_Zone", "+01:00", "-08:00", "Asia/Taipei\n", " Asia/Taipei"])(
    "rejects invalid IANA time zone %j",
    (timeZone) => {
      expect(
        statusNotificationsSchema.safeParse({
          ...legacy,
          quietHours: { ...quietHours, timeZone },
        }).success,
      ).toBe(false)
    },
  )

  it.each([
    "22:00",
    {},
    { ...quietHours, start: "08:00" },
    { ...quietHours, start: "8:00" },
    { ...quietHours, start: "24:00" },
    { ...quietHours, end: "08:60" },
    { ...quietHours, end: "08:00:00" },
    { ...quietHours, end: "08:00\n" },
    { ...quietHours, weekdays: [1] },
  ])("rejects malformed present quiet windows (case %#)", (hours) => {
    expect(statusNotificationsSchema.safeParse({ ...legacy, quietHours: hours }).success).toBe(
      false,
    )
    expect(
      statusNotificationsSchema.safeParse({
        ...legacy,
        chatOverrides: { "42": { quietHours: hours } },
      }).success,
    ).toBe(false)
  })

  it.each([0, 60, 300, 900])("accepts grouping window %s", (batchWindowSeconds) => {
    expect(
      statusNotificationsSchema.safeParse({
        ...legacy,
        batchWindowSeconds,
        chatOverrides: { "42": { batchWindowSeconds } },
      }).success,
    ).toBe(true)
  })

  it.each([null, -1, 1, 59, 61, 60.5, 3600, "60"])(
    "rejects unsupported grouping window %j",
    (batchWindowSeconds) => {
      expect(statusNotificationsSchema.safeParse({ ...legacy, batchWindowSeconds }).success).toBe(
        false,
      )
      expect(
        statusNotificationsSchema.safeParse({
          ...legacy,
          chatOverrides: { "42": { batchWindowSeconds } },
        }).success,
      ).toBe(false)
    },
  )

  it.each([
    "0",
    "-0",
    "042",
    "-0100",
    "+42",
    "42.0",
    "4.2e1",
    "42\n",
    "42\r\n",
    " 42",
    "9007199254740992",
    "__proto__",
    "constructor",
    "99",
  ])("rejects noncanonical or unselected override key %j", (key) => {
    expect(
      statusNotificationsSchema.safeParse({
        ...legacy,
        chatOverrides: Object.fromEntries([[key, {}]]),
      }).success,
    ).toBe(false)
  })

  it("accepts exactly 1000 destinations and overrides, and rejects 1001", () => {
    const chatIds = Array.from({ length: 1000 }, (_, index) => index + 1)
    const chatOverrides = Object.fromEntries(chatIds.map((id) => [String(id), {}]))
    expect(statusNotificationsSchema.safeParse({ ...legacy, chatIds, chatOverrides }).success).toBe(
      true,
    )
    expect(
      statusNotificationsSchema.safeParse({
        ...legacy,
        chatIds: [...chatIds, 1001],
        chatOverrides: { ...chatOverrides, "1001": {} },
      }).success,
    ).toBe(false)
    expect(
      statusNotificationsSchema.parse({
        ...legacy,
        chatIds: [Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER],
        chatOverrides: {
          [String(Number.MAX_SAFE_INTEGER)]: {},
          [String(Number.MIN_SAFE_INTEGER)]: {},
        },
      }).chatIds,
    ).toHaveLength(2)
  })

  it.each([
    null,
    [],
    "42",
    Object.fromEntries([
      ["42", {}],
      ["__proto__", {}],
    ]),
  ])("rejects malformed override records: %j", (chatOverrides) => {
    expect(statusNotificationsSchema.safeParse({ ...legacy, chatOverrides }).success).toBe(false)
  })

  it.each([
    null,
    [],
    { providers: ["other"] },
    { providers: ["github", "github"] },
    { minimumImpact: "maintenance" },
    { enabled: true },
    { chatIds: [99] },
    { pollIntervalSeconds: 60 },
    { notifyUpdates: false },
    { notifyResolved: false },
    { includeMaintenance: true },
  ])("rejects malformed overrides and unrelated per-chat controls: %j", (override) => {
    expect(
      statusNotificationsSchema.safeParse({ ...legacy, chatOverrides: { "42": override } }).success,
    ).toBe(false)
  })
})
