import { z } from "zod"

export const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024
export const MAX_ISSUES = 1000
export const MAX_ATTACHMENT_STORAGE = 64 * 1024 * 1024
export const ISSUE_PAGE_SIZE = 25
export const issueState = z.enum(["open", "closed"])
export const feedbackSchema = z
  .object({
    requestId: z.uuid(),
    analyze: z.boolean().optional(),
    description: z.string().trim().max(8000).default(""),
    source: z
      .object({
        section: z.string().trim().min(1).max(64),
        viewport: z
          .object({
            width: z.number().int().min(1).max(10000),
            height: z.number().int().min(1).max(10000),
          })
          .strict(),
      })
      .strict(),
    screenshot: z
      .string()
      .min(4)
      .max(4 * Math.ceil(MAX_SCREENSHOT_BYTES / 3))
      .optional(),
  })
  .strict()
  .refine((value) => Boolean(value.description || value.screenshot), {
    message: "Provide a description or screenshot",
  })
export type Feedback = z.infer<typeof feedbackSchema>
export type IssueState = z.infer<typeof issueState>
export interface IssueSummary {
  id: number
  title: string
  state: IssueState
  section: string
  hasScreenshot: boolean
  createdAt: number
  updatedAt: number
  revision: number
}
export interface Issue extends IssueSummary {
  description: string
  source: Feedback["source"]
}
export interface IssuePage {
  issues: IssueSummary[]
  next: number | null
}
export const issueMutationSchema = z
  .object({ revision: z.number().int().positive().safe(), state: issueState })
  .strict()
export const issueDeletionSchema = z
  .object({ revision: z.number().int().positive().safe() })
  .strict()

export type {
  AnalysisReason,
  AnalysisReport,
  AnalysisState,
  IssueAnalyses,
  IssueAnalysis,
  Proposal,
} from "./analysis.js"
export {
  ANALYSIS_TIMEOUT_MS,
  analysisCancelSchema,
  analysisReason,
  analysisReportSchema,
  analysisRequestSchema,
  analysisSelectionSchema,
  analysisState,
  MAX_ANALYSIS_ATTEMPTS,
  MAX_ANALYSIS_QUEUE,
  proposalSchema,
} from "./analysis.js"
export { renderProposalSvg } from "./preview.js"
