import type { effectivePolicy, Policy } from "@narumitw/sumire-policy"

export type {
  DurableConversationItem,
  DurableDocumentItem,
  DurableDocumentProjection,
  DurableDocumentScope,
  DurableEntryItem,
  DurableInspectionItem,
  DurableInspectionLoadedResponse,
  DurableInspectionQuery,
  DurableInspectionResponse,
  DurableInspectionView,
  DurableNumericUsage,
  DurableTaskItem,
} from "./durable-inspector.js"

export type Snapshot = {
  revision: number
  applied: number
  status: string
  policy: Policy
  epoch: number
}

export interface Inventory {
  tools: string[]
  builtInTools?: string[]
  providers: {
    id: string
    name: string
    configured: boolean
    apiKey: boolean
    oauth: boolean
    models: { id: string; name: string; thinking: string[]; reasoning: boolean; image: boolean }[]
  }[]
  mcp: {
    name: string
    connection: string
    tools: string[]
    fields?: string[]
    enabled?: boolean
    exposure?: string
    toolExposure?: Record<string, "codemode" | "direct" | "hidden">
    url?: string
    command?: string
    args?: string[]
    cwd?: string
    env: Record<string, null>
    headers: Record<string, null>
  }[]
}

export type Chat = { id: number; name: string; type: string }
export type ChatResponse = Chat & { effective: ReturnType<typeof effectivePolicy> }

export type AuditEntry = {
  id: number
  time: number
  actor: string
  operation: string
  revision: number
  outcome: string
  target: string
}
export type ImportReport = { name: string; report: Record<string, unknown> }
