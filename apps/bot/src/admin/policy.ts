import { z } from "zod"

const names = z
  .array(z.string().min(1).max(256))
  .max(512)
  .refine((v) => new Set(v).size === v.length)
export const thinkingSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
export const selectionSchema = z
  .object({
    tools: names.nullable(),
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
export const policySchema = z
  .object({
    tools: names,
    servers: names,
    models: names,
    defaults: selectionSchema,
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
  servers: null,
  models: null,
  model: null,
  thinking: null,
}

export function initialPolicy(): Policy {
  return {
    tools: [],
    servers: [],
    models: [],
    defaults: { ...inherited, tools: [], servers: [], models: [], thinking: "off" },
    privateUsers: [],
    groups: [],
    chats: {},
    providers: [],
  }
}

export function effectivePolicy(policy: Policy, chatId: number) {
  const override = policy.chats[String(chatId)]
  const source = (key: keyof Selection) => (override?.[key] == null ? "default" : "chat")
  const list = (key: "tools" | "servers" | "models") => {
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
  for (const choice of [policy.defaults, ...Object.values(policy.chats)]) {
    for (const key of ["tools", "servers", "models"] as const)
      if (choice[key]?.some((value) => !policy[key].includes(value)))
        throw new Error("Selection exceeds global availability")
    if (choice.model && !(choice.models ?? policy.defaults.models ?? []).includes(choice.model))
      throw new Error("Default model must be allowed")
  }
  for (const p of policy.providers) {
    if (!p.enabled && policy.models.some((ref) => ref.startsWith(`${p.id}/`)))
      throw new Error("Provider is still referenced; replace its models first")
  }
}
