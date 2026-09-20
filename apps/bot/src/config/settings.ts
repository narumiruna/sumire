import path from "node:path"

import { z } from "zod"

const optionalString = z.preprocess((value) => {
  if (typeof value !== "string") return value
  const normalized = value.trim()
  return normalized || undefined
}, z.string().optional())

const csvIntegers = z
  .string()
  .optional()
  .transform((value, context) => {
    const values = new Set<number>()
    for (const item of (value ?? "").split(",")) {
      const normalized = item.trim()
      if (!normalized) continue
      const parsed = Number(normalized)
      if (!Number.isSafeInteger(parsed)) {
        context.addIssue({
          code: "custom",
          message: `Expected an integer, received ${JSON.stringify(normalized)}`,
        })
        return z.NEVER
      }
      values.add(parsed)
    }
    return values
  })

const environmentSchema = z.object({
  BOT_TOKEN: z.string().default(""),
  BOT_WHITELIST: csvIntegers,
  LOGFIRE_TOKEN: optionalString,
  MORSEL_URL: z.url().default("https://morsel.narumi.dev/"),
  MORSEL_API_KEY: optionalString,
  OPENAI_BASE_URL: z.url().default("https://api.openai.com/v1"),
  OPENAI_API_KEY: optionalString,
  OPENAI_MODEL: z.string().min(1).default("gpt-5.6-luna"),
})

export interface Settings {
  projectRoot: string
  botToken: string
  botWhitelist: ReadonlySet<number>
  botMaxConsecutiveRepliesToBots: number
  botGroupPassiveContextEnabled: boolean
  botSkillsDir: string
  botEnabledSkills: ReadonlySet<string>
  botSoulPath: string
  botSoulRequired: boolean
  botSoulMaxChars: number
  botProactiveEnabled: boolean
  botProactiveUrlTimeoutSeconds: number
  botKabigonTimeoutSeconds: number
  botProactiveMaxExtractedChars: number
  botProactiveAllowedSchemes: ReadonlySet<string>
  botSessionLogDir: string
  botAgentMaxAttempts: number
  botAgentRetryBaseDelaySeconds: number
  botAgentContextTokenBudget: number
  botAgentCompactionTriggerRatio: number
  botImageInputEnabled: boolean
  botImageMaxBytes: number
  logfireToken?: string
  morselUrl: string
  morselApiKey?: string
  morselMode: "disabled" | "rich_only" | "smart"
  morselLongReplyThreshold: number
  morselShareExpiresInSeconds: number
  morselTelegramInstantView: boolean
  morselTimeoutSeconds: number
  openaiBaseUrl: string
  openaiApiKey?: string
  openaiModel: string
}

export function loadSettings(
  environment: NodeJS.ProcessEnv = process.env,
  projectRoot = process.cwd(),
): Settings {
  const parsed = environmentSchema.parse(environment)
  const root = path.resolve(projectRoot)
  return {
    projectRoot: root,
    botToken: parsed.BOT_TOKEN,
    botWhitelist: parsed.BOT_WHITELIST,
    botMaxConsecutiveRepliesToBots: 1,
    botGroupPassiveContextEnabled: true,
    botSkillsDir: path.resolve(root, "skills"),
    botEnabledSkills: new Set<string>(),
    botSoulPath: path.resolve(root, "SOUL.md"),
    botSoulRequired: false,
    botSoulMaxChars: 8_000,
    botProactiveEnabled: true,
    botProactiveUrlTimeoutSeconds: 15,
    botKabigonTimeoutSeconds: 180,
    botProactiveMaxExtractedChars: 12_000,
    botProactiveAllowedSchemes: new Set(["http", "https"]),
    botSessionLogDir: path.resolve(root, ".telegramagent/sessions"),
    botAgentMaxAttempts: 3,
    botAgentRetryBaseDelaySeconds: 1,
    botAgentContextTokenBudget: 100_000,
    botAgentCompactionTriggerRatio: 0.8,
    botImageInputEnabled: true,
    botImageMaxBytes: 8_000_000,
    ...(parsed.LOGFIRE_TOKEN ? { logfireToken: parsed.LOGFIRE_TOKEN } : {}),
    morselUrl: parsed.MORSEL_URL,
    ...(parsed.MORSEL_API_KEY ? { morselApiKey: parsed.MORSEL_API_KEY } : {}),
    morselMode: "smart",
    morselLongReplyThreshold: 2_000,
    morselShareExpiresInSeconds: 2_592_000,
    morselTelegramInstantView: true,
    morselTimeoutSeconds: 12,
    openaiBaseUrl: parsed.OPENAI_BASE_URL.replace(/\/$/, ""),
    ...(parsed.OPENAI_API_KEY ? { openaiApiKey: parsed.OPENAI_API_KEY } : {}),
    openaiModel: parsed.OPENAI_MODEL,
  }
}
