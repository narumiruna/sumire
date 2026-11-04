import { z } from "zod"

export const POLICY_MAX_NAMES = 512

export const githubUsernameSchema = z
  .string()
  .min(1)
  .max(39)
  .regex(/^[a-z\d]+(?:-[a-z\d]+)*(?![\s\S])/i)
  .transform((username) => username.toLowerCase())

const names = z
  .array(z.string().min(1).max(256))
  .max(POLICY_MAX_NAMES)
  .refine((v) => new Set(v).size === v.length)
export const thinkingSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
export const selectionSchema = z
  .object({
    tools: names.nullable(),
    skills: names.nullable().default(null),
    servers: names.nullable(),
    models: names.nullable(),
    model: z.string().min(1).max(256).nullable(),
    thinking: thinkingSchema.nullable(),
  })
  .strict()
export const providerSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    enabled: z.boolean(),
    baseUrl: z.url().max(2048).optional(),
    api: z
      .enum([
        "openai-completions",
        "openai-responses",
        "anthropic-messages",
        "google-generative-ai",
      ])
      .optional(),
    models: z
      .array(
        z
          .object({
            id: z.string().min(1).max(192),
            name: z.string().min(1).max(192),
            reasoning: z.boolean(),
            image: z.boolean(),
            contextWindow: z.number().int().positive().max(10_000_000),
            maxTokens: z.number().int().positive().max(1_000_000),
          })
          .strict()
          .refine((m) => m.maxTokens <= m.contextWindow),
      )
      .max(128)
      .refine((models) => new Set(models.map((m) => m.id)).size === models.length),
  })
  .strict()
  .refine(
    (p) => !p.baseUrl || Boolean(p.api && p.models.length),
    "Custom endpoints need an API and models",
  )
export const statusProviderIds = ["github", "openai", "claude", "cloudflare"] as const
export type StatusProviderId = (typeof statusProviderIds)[number]

const statusProvidersSchema = z
  .array(z.enum(statusProviderIds))
  .max(statusProviderIds.length)
  .refine((ids) => new Set(ids).size === ids.length)
const statusImpactSchema = z.enum(["none", "minor", "major", "critical"])
// Unlike $, the final assertion also rejects a trailing newline.
const statusComponentIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}(?![\s\S])/)
const statusComponentSelectionsSchema = z
  .custom<Record<string, unknown>>(
    (input) =>
      typeof input === "object" &&
      input !== null &&
      !Array.isArray(input) &&
      Object.keys(input).every((key) => statusProviderIds.some((provider) => provider === key)),
    "Expected component selections keyed only by supported providers",
  )
  .pipe(
    z.partialRecord(
      z.enum(statusProviderIds),
      z
        .array(statusComponentIdSchema)
        .max(128)
        .refine((ids) => new Set(ids).size === ids.length)
        .nullable(),
    ),
  )
const statusTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d(?![\s\S])/)
const statusQuietHoursSchema = z
  .object({
    timeZone: z
      .string()
      .min(1)
      .max(128)
      .refine((timeZone) => {
        // Intl also accepts numeric offsets, which are not IANA zone names.
        if (/^[+-]/.test(timeZone)) return false
        try {
          new Intl.DateTimeFormat("en", { timeZone })
          return true
        } catch {
          return false
        }
      }, "Expected an IANA time zone"),
    start: statusTimeSchema,
    end: statusTimeSchema,
  })
  .strict()
  .refine((hours) => hours.start !== hours.end, {
    message: "Quiet hours start and end must differ",
    path: ["end"],
  })
const statusBatchWindowSchema = z.union([
  z.literal(0),
  z.literal(60),
  z.literal(300),
  z.literal(900),
])
const statusChatOverrideSchema = z
  .object({
    providers: statusProvidersSchema.optional(),
    minimumImpact: statusImpactSchema.optional(),
    componentSelections: statusComponentSelectionsSchema.optional(),
    quietHours: statusQuietHoursSchema.nullable().optional(),
    batchWindowSeconds: statusBatchWindowSchema.optional(),
  })
  .strict()
const statusChatKeySchema = z
  .string()
  .regex(/^-?[1-9]\d*(?![\s\S])/)
  .refine((key) => Number.isSafeInteger(Number(key)) && String(Number(key)) === key)
const statusChatOverridesSchema = z
  .custom<Record<string, unknown>>((input) => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return false
    // Validate raw keys before Zod can omit special keys such as __proto__.
    const keys = Object.keys(input)
    return keys.length <= 1000 && keys.every((key) => statusChatKeySchema.safeParse(key).success)
  }, "Expected at most 1000 canonical destination override keys")
  .pipe(z.record(statusChatKeySchema, statusChatOverrideSchema))

export type StatusQuietHours = z.infer<typeof statusQuietHoursSchema>
export type StatusChatOverride = z.infer<typeof statusChatOverrideSchema>

export const statusNotificationsSchema = z
  .object({
    enabled: z.boolean(),
    providers: statusProvidersSchema,
    chatIds: z
      .array(
        z
          .number()
          .int()
          .safe()
          .refine((id) => id !== 0),
      )
      .max(1000)
      .refine((ids) => new Set(ids).size === ids.length),
    pollIntervalSeconds: z.number().int().min(60).max(3600),
    minimumImpact: statusImpactSchema,
    componentSelections: statusComponentSelectionsSchema.default(() => ({})),
    quietHours: statusQuietHoursSchema.nullable().default(null),
    batchWindowSeconds: statusBatchWindowSchema.default(0),
    chatOverrides: statusChatOverridesSchema.default(() => ({})),
    notifyUpdates: z.boolean(),
    notifyResolved: z.boolean(),
    includeMaintenance: z.boolean(),
  })
  .strict()
  .superRefine((settings, context) => {
    const selected = new Set(settings.chatIds.map(String))
    for (const chatId of Object.keys(settings.chatOverrides)) {
      if (!selected.has(chatId))
        context.addIssue({
          code: "custom",
          path: ["chatOverrides", chatId],
          message: "Status overrides require a selected destination",
        })
    }
    const selections = [
      settings.componentSelections,
      ...Object.values(settings.chatOverrides).map((override) => override.componentSelections),
    ]
    const references = selections.reduce(
      (total, selection) =>
        total +
        Object.values(selection ?? {}).reduce((count, ids) => count + (ids?.length ?? 0), 0),
      0,
    )
    if (references > 512)
      context.addIssue({
        code: "custom",
        path: ["componentSelections"],
        message: "Status settings allow at most 512 component references in total",
      })
  })
export type StatusNotifications = z.infer<typeof statusNotificationsSchema>

export interface StatusSubscription {
  chatId: number
  providers: StatusProviderId[]
  minimumImpact: StatusNotifications["minimumImpact"]
  componentSelections: Record<StatusProviderId, string[] | null>
  quietHours: StatusQuietHours | null
  batchWindowSeconds: StatusNotifications["batchWindowSeconds"]
  notifyUpdates: boolean
  notifyResolved: boolean
  includeMaintenance: boolean
}

export function initialStatusNotifications(): StatusNotifications {
  return {
    enabled: false,
    providers: [...statusProviderIds],
    chatIds: [],
    pollIntervalSeconds: 60,
    minimumImpact: "minor",
    componentSelections: {},
    quietHours: null,
    batchWindowSeconds: 0,
    chatOverrides: {},
    notifyUpdates: true,
    notifyResolved: true,
    includeMaintenance: false,
  }
}

/** Resolve notification filters only; this does not enable delivery or grant Pi access. */
export function resolveStatusSubscription(
  settings: StatusNotifications,
  chatId: number,
): StatusSubscription | undefined {
  if (!settings.chatIds.includes(chatId)) return undefined
  const override = settings.chatOverrides[String(chatId)]
  const componentSelections = Object.fromEntries(
    statusProviderIds.map((provider) => {
      const selected = override?.componentSelections?.[provider]
      const ids =
        selected === undefined ? (settings.componentSelections[provider] ?? null) : selected
      return [provider, ids === null ? null : [...ids]]
    }),
  ) as StatusSubscription["componentSelections"]
  const quietHours = override?.quietHours === undefined ? settings.quietHours : override.quietHours
  return {
    chatId,
    providers: [...(override?.providers ?? settings.providers)],
    minimumImpact: override?.minimumImpact ?? settings.minimumImpact,
    componentSelections,
    quietHours: quietHours === null ? null : { ...quietHours },
    batchWindowSeconds: override?.batchWindowSeconds ?? settings.batchWindowSeconds,
    notifyUpdates: settings.notifyUpdates,
    notifyResolved: settings.notifyResolved,
    includeMaintenance: settings.includeMaintenance,
  }
}

export const policySchema = z
  .object({
    tools: names,
    skills: names.default([]),
    servers: names,
    models: names,
    defaults: selectionSchema,
    githubNotifications: z
      .object({
        allowedUsernames: z
          .array(githubUsernameSchema)
          .max(1000)
          .refine((usernames) => new Set(usernames).size === usernames.length),
      })
      .strict()
      .default(() => ({ allowedUsernames: [] })),
    statusNotifications: statusNotificationsSchema.default(initialStatusNotifications),
    privateUsers: z.array(z.number().int().positive().safe()).max(1000),
    groups: z.array(z.number().int().negative().safe()).max(1000),
    chats: z
      .record(
        z.string().regex(/^-?[1-9]\d*$/),
        selectionSchema.extend({ enabled: z.boolean() }).strict(),
      )
      .refine(
        (v) =>
          Object.keys(v).length <= 1000 &&
          Object.keys(v).every(
            (key) => Number.isSafeInteger(Number(key)) && String(Number(key)) === key,
          ),
      ),
    providers: z
      .array(providerSchema)
      .max(64)
      .refine((v) => new Set(v.map((p) => p.id)).size === v.length),
  })
  .strict()
export type Policy = z.infer<typeof policySchema>
export type Selection = z.infer<typeof selectionSchema>
export type ProviderSettings = z.infer<typeof providerSchema>
export const inherited: Selection = {
  tools: null,
  skills: null,
  servers: null,
  models: null,
  model: null,
  thinking: null,
}

export function initialPolicy(): Policy {
  return {
    tools: [],
    skills: [],
    servers: [],
    models: [],
    defaults: { ...inherited, tools: [], skills: [], servers: [], models: [], thinking: "off" },
    githubNotifications: { allowedUsernames: [] },
    statusNotifications: initialStatusNotifications(),
    privateUsers: [],
    groups: [],
    chats: {},
    providers: [],
  }
}

export function effectivePolicy(policy: Policy, chatId: number) {
  const override = policy.chats[String(chatId)]
  const source = (key: keyof Selection) => (override?.[key] == null ? "default" : "chat")
  const list = (key: "tools" | "skills" | "servers" | "models") => {
    const chosen = override?.[key] ?? policy.defaults[key] ?? []
    return chosen.filter((name) => policy[key].includes(name))
  }
  const model = override?.model ?? policy.defaults.model
  const models = list("models").filter((ref) => {
    const provider = policy.providers.find((p) => p.id === ref.split("/")[0])
    return provider?.enabled !== false
  })
  return {
    enabled:
      override?.enabled !== false &&
      (chatId > 0 ? policy.privateUsers : policy.groups).includes(chatId),
    tools: list("tools"),
    skills: list("skills"),
    servers: list("servers"),
    models,
    model: model && models.includes(model) ? model : null,
    thinking: override?.thinking ?? policy.defaults.thinking ?? "off",
    sources: Object.fromEntries(
      Object.keys(inherited).map((key) => [key, source(key as keyof Selection)]),
    ),
  }
}

export function validateReferences(policy: Policy): void {
  for (const [scope, choice] of [
    ["Defaults", policy.defaults],
    ...Object.entries(policy.chats).map(([id, choice]) => [`Chats → ${id}`, choice] as const),
  ] as const) {
    for (const key of ["tools", "skills", "servers", "models"] as const) {
      const unavailable = choice[key]?.filter((value) => !policy[key].includes(value))
      if (unavailable?.length)
        throw new Error(
          `${scope}: ${key} selection exceeds global availability: ${unavailable.join(", ")}. Update the selection or the global availability list.`,
        )
    }
    if (choice.model && !(choice.models ?? policy.defaults.models ?? []).includes(choice.model))
      throw new Error(
        `${scope}: model "${choice.model}" is not in Allowed models${choice.models === null ? " inherited from Defaults" : ""}. Add it to Allowed models, or change the ${scope === "Defaults" ? "default model in Shared defaults" : "chat model override"}.`,
      )
  }
  for (const p of policy.providers) {
    if (!p.enabled && policy.models.some((ref) => ref.startsWith(`${p.id}/`)))
      throw new Error("Provider is still referenced; replace its models first")
  }
}
