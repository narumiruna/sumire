import path from "node:path"

import { z } from "zod"

const optionalString = z.preprocess((value) => {
  if (typeof value !== "string") return value
  const normalized = value.trim()
  return normalized || undefined
}, z.string().optional())

const envBoolean = (defaultValue: boolean) =>
  z
    .enum(["true", "false"])
    .default(String(defaultValue) as "true" | "false")
    .transform((value) => value === "true")

const envInteger = (defaultValue: number, minimum: number, maximum = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(minimum).max(maximum).default(defaultValue)

const envNumber = (defaultValue: number, minimum: number, maximum = Number.MAX_VALUE) =>
  z.coerce.number().min(minimum).max(maximum).default(defaultValue)

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

const allowedSchemes = z
  .string()
  .default("http,https")
  .transform((value, context) => {
    const schemes = new Set(
      value
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
    )
    if (schemes.size === 0 || [...schemes].some((scheme) => !["http", "https"].includes(scheme))) {
      context.addIssue({ code: "custom", message: "Only http and https URL schemes are allowed" })
      return z.NEVER
    }
    return schemes
  })

const environmentSchema = z.object({
  BOT_TOKEN: z.string().default(""),
  BOT_WHITELIST: csvIntegers,
  BOT_DOCUMENT_INPUT_ENABLED: envBoolean(true),
  BOT_DOCUMENT_MAX_BYTES: envInteger(20_000_000, 1, 100_000_000),
  BOT_DOCUMENT_MAX_MARKDOWN_CHARS: envInteger(50_000, 1, 1_000_000),
  BOT_DOCUMENT_CONVERSION_TIMEOUT_SECONDS: envNumber(30, 0.1, 600),
  BOT_DOCUMENT_MAX_CONCURRENT_CONVERSIONS: envInteger(2, 1, 16),
  BOT_REPLY_TREE_ENABLED: envBoolean(true),
  BOT_REPLY_TREE_MAX_RECORDS_PER_CHAT: envInteger(1_000, 1, 100_000),
  BOT_REPLY_TREE_MAX_INDEX_BYTES: envInteger(1_000_000, 1_024, 100_000_000),
  BOT_URL_TIMEOUT_SECONDS: envNumber(15, 0.1, 600),
  BOT_URL_CONTENT_TIMEOUT_SECONDS: envNumber(180, 0.1, 3_600),
  BOT_URL_MAX_EXTRACTED_CHARS: envInteger(12_000, 1, 1_000_000),
  BOT_URL_ALLOWED_SCHEMES: allowedSchemes,
  BOT_IMAGE_INPUT_ENABLED: envBoolean(true),
  BOT_IMAGE_MAX_BYTES: envInteger(8_000_000, 1, 100_000_000),
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
  botDocumentInputEnabled: boolean
  botDocumentMaxBytes: number
  botDocumentMaxMarkdownChars: number
  botDocumentConversionTimeoutSeconds: number
  botDocumentMaxConcurrentConversions: number
  botReplyTreeEnabled: boolean
  botReplyTreeMaxRecordsPerChat: number
  botReplyTreeMaxIndexBytes: number
  botUrlTimeoutSeconds: number
  botUrlContentTimeoutSeconds: number
  botUrlMaxExtractedChars: number
  botUrlAllowedSchemes: ReadonlySet<string>
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
    botDocumentInputEnabled: parsed.BOT_DOCUMENT_INPUT_ENABLED,
    botDocumentMaxBytes: parsed.BOT_DOCUMENT_MAX_BYTES,
    botDocumentMaxMarkdownChars: parsed.BOT_DOCUMENT_MAX_MARKDOWN_CHARS,
    botDocumentConversionTimeoutSeconds: parsed.BOT_DOCUMENT_CONVERSION_TIMEOUT_SECONDS,
    botDocumentMaxConcurrentConversions: parsed.BOT_DOCUMENT_MAX_CONCURRENT_CONVERSIONS,
    botReplyTreeEnabled: parsed.BOT_REPLY_TREE_ENABLED,
    botReplyTreeMaxRecordsPerChat: parsed.BOT_REPLY_TREE_MAX_RECORDS_PER_CHAT,
    botReplyTreeMaxIndexBytes: parsed.BOT_REPLY_TREE_MAX_INDEX_BYTES,
    botUrlTimeoutSeconds: parsed.BOT_URL_TIMEOUT_SECONDS,
    botUrlContentTimeoutSeconds: parsed.BOT_URL_CONTENT_TIMEOUT_SECONDS,
    botUrlMaxExtractedChars: parsed.BOT_URL_MAX_EXTRACTED_CHARS,
    botUrlAllowedSchemes: parsed.BOT_URL_ALLOWED_SCHEMES,
    botSessionLogDir: path.resolve(root, ".telegramagent/sessions"),
    botAgentMaxAttempts: 3,
    botAgentRetryBaseDelaySeconds: 1,
    botAgentContextTokenBudget: 100_000,
    botAgentCompactionTriggerRatio: 0.8,
    botImageInputEnabled: parsed.BOT_IMAGE_INPUT_ENABLED,
    botImageMaxBytes: parsed.BOT_IMAGE_MAX_BYTES,
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
