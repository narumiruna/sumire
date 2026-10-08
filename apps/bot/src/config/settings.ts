import path from "node:path"

import { z } from "zod"

const optionalString = z.preprocess((value) => {
  if (typeof value !== "string") return value
  const normalized = value.trim()
  return normalized || undefined
}, z.string().optional())

const optionalTelegramUserId = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z
    .string()
    .trim()
    .regex(/^[1-9]\d*$/u)
    .transform(Number)
    .pipe(z.number().int().max(Number.MAX_SAFE_INTEGER))
    .optional(),
)

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
  BOT_ADMIN_ID: optionalTelegramUserId,
  LOGFIRE_TOKEN: optionalString,
  MORSEL_API_KEY: optionalString,
})

export interface Settings {
  projectRoot: string
  botWorkdir: string
  botToken: string
  botWhitelist: ReadonlySet<number>
  botAdminId?: number
  botMcpConfigPath: string
  botCodemodeTimeoutSeconds: number
  botMaxConsecutiveRepliesToBots: number
  botGroupPassiveContextEnabled: boolean
  botSkillsDir: string
  botEnabledSkills: ReadonlySet<string>
  botSystemPromptPath: string
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
  botChannelImageInputEnabled: boolean
  botImageMaxBytes: number
  botAudioInputEnabled: boolean
  botAudioMaxBytes: number
  botAudioMaxDurationSeconds: number
  botAudioTranscriptionTimeoutSeconds: number
  botAudioMaxTranscriptChars: number
  logfireToken?: string
  morselUrl: string
  morselApiKey?: string
  morselMode: "disabled" | "rich_only" | "smart"
  morselLongReplyThreshold: number
  morselShareExpiresInSeconds: number
  morselTelegramInstantView: boolean
  morselTimeoutSeconds: number
}

export function loadSettings(
  environment: NodeJS.ProcessEnv = process.env,
  projectRoot = process.cwd(),
  workdir = projectRoot,
): Settings {
  const parsed = environmentSchema.parse(environment)
  const root = path.resolve(projectRoot)
  return {
    projectRoot: root,
    botWorkdir: path.resolve(workdir),
    botToken: parsed.BOT_TOKEN,
    botWhitelist: parsed.BOT_WHITELIST,
    botMcpConfigPath: path.join(root, "mcp.json"),
    botCodemodeTimeoutSeconds: 300,
    ...(parsed.BOT_ADMIN_ID !== undefined ? { botAdminId: parsed.BOT_ADMIN_ID } : {}),
    botMaxConsecutiveRepliesToBots: 1,
    botGroupPassiveContextEnabled: true,
    botSkillsDir: path.resolve(root, "skills"),
    botEnabledSkills: new Set<string>(),
    botSystemPromptPath: path.resolve(root, "instructions/SYSTEM.md"),
    botSoulPath: path.resolve(root, "instructions/SOUL.md"),
    botSoulRequired: false,
    botSoulMaxChars: 8_000,
    botDocumentInputEnabled: true,
    botDocumentMaxBytes: 20_000_000,
    botDocumentMaxMarkdownChars: 50_000,
    botDocumentConversionTimeoutSeconds: 30,
    botDocumentMaxConcurrentConversions: 2,
    botReplyTreeEnabled: true,
    botReplyTreeMaxRecordsPerChat: 1_000,
    botReplyTreeMaxIndexBytes: 1_000_000,
    botUrlTimeoutSeconds: 15,
    botUrlContentTimeoutSeconds: 180,
    botUrlMaxExtractedChars: 12_000,
    botUrlAllowedSchemes: new Set(["http", "https"]),
    botSessionLogDir: path.resolve(root, ".telegramagent/sessions"),
    botAgentMaxAttempts: 3,
    botAgentRetryBaseDelaySeconds: 1,
    botAgentContextTokenBudget: 100_000,
    botAgentCompactionTriggerRatio: 0.8,
    botImageInputEnabled: true,
    botChannelImageInputEnabled: true,
    botImageMaxBytes: 8_000_000,
    botAudioInputEnabled: true,
    botAudioMaxBytes: 20_000_000,
    botAudioMaxDurationSeconds: 600,
    botAudioTranscriptionTimeoutSeconds: 180,
    botAudioMaxTranscriptChars: 12_000,
    ...(parsed.LOGFIRE_TOKEN ? { logfireToken: parsed.LOGFIRE_TOKEN } : {}),
    morselUrl: "https://morsel.narumi.dev/",
    ...(parsed.MORSEL_API_KEY ? { morselApiKey: parsed.MORSEL_API_KEY } : {}),
    morselMode: "smart",
    morselLongReplyThreshold: 1_000,
    morselShareExpiresInSeconds: 2_592_000,
    morselTelegramInstantView: true,
    morselTimeoutSeconds: 12,
  }
}
