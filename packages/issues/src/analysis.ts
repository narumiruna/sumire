import { z } from "zod"

export const MAX_ANALYSIS_ATTEMPTS = 3
export const MAX_ANALYSIS_QUEUE = 32
export const ANALYSIS_TIMEOUT_MS = 300_000
export const analysisState = z.enum([
  "idle",
  "queued",
  "running",
  "blocked",
  "completed",
  "failed",
  "cancelled",
])
export const analysisReason = z.enum([
  "model_unavailable",
  "policy_changed",
  "image_unsupported",
  "queue_full",
  "storage_limit",
  "session_unavailable",
  "generation_failed",
  "invalid_report",
  "timeout",
  "cancelled",
  "issue_closed",
])
const text = (max: number) => z.string().trim().min(1).max(max)
export const proposalSchema = z
  .object({
    title: text(120),
    rationale: text(2000),
    changes: z
      .array(text(500))
      .min(1)
      .max(8)
      .refine((items) => new Set(items).size === items.length, "Changes must be distinct"),
    tradeoffs: text(1500),
    preview: z
      .object({
        title: text(80),
        layout: z.enum(["stack", "columns"]),
        sections: z
          .array(
            z
              .object({ heading: text(60), body: text(400), button: z.string().trim().max(60) })
              .strict(),
          )
          .min(1)
          .max(4),
      })
      .strict(),
  })
  .strict()
export const analysisReportSchema = z
  .object({
    summary: text(2000),
    limitations: text(1500),
    questions: z
      .array(text(500))
      .max(3)
      .refine((items) => new Set(items).size === items.length, "Questions must be distinct"),
    proposals: z
      .array(proposalSchema)
      .max(3)
      .refine(
        (items) => new Set(items.map((item) => item.title)).size === items.length,
        "Proposal titles must be distinct",
      ),
  })
  .strict()
  .refine((value) => value.proposals.length > 0 || value.questions.length > 0, {
    message: "Publish proposals or clarification questions",
  })
export type AnalysisReport = z.infer<typeof analysisReportSchema>
export type Proposal = z.infer<typeof proposalSchema>
export type AnalysisState = z.infer<typeof analysisState>
export type AnalysisReason = z.infer<typeof analysisReason>
export interface IssueAnalysis {
  id: string
  issueId: number
  attempt: number
  state: AnalysisState
  reason: AnalysisReason | null
  sessionId: string | null
  conversationId: number | null
  submissionId: number | null
  model: string | null
  createdAt: number
  updatedAt: number
  deadline: number | null
  report: AnalysisReport | null
  selectedProposal: number | null
  revision: number
}
export interface IssueAnalyses {
  available: boolean
  analyses: IssueAnalysis[]
}
export const analysisRequestSchema = z
  .object({
    requestId: z.uuid().toLowerCase(),
    revision: z.number().int().positive().safe(),
    context: z.string().trim().max(4000).default(""),
  })
  .strict()
export const analysisSelectionSchema = z
  .object({
    analysisId: z.uuid().toLowerCase(),
    revision: z.number().int().positive().safe(),
    proposal: z.number().int().min(0).max(2).nullable(),
  })
  .strict()
export const analysisCancelSchema = z
  .object({ analysisId: z.uuid().toLowerCase(), revision: z.number().int().positive().safe() })
  .strict()
