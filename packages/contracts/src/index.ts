import type { effectivePolicy, Policy } from "@narumitw/sumire-policy"

export type {
  DurableConversationItem,
  DurableDocumentItem,
  DurableDocumentProjection,
  DurableDocumentScope,
  DurableEntryContentBlock,
  DurableEntryItem,
  DurableEntryMessage,
  DurableInspectionItem,
  DurableInspectionLoadedResponse,
  DurableInspectionQuery,
  DurableInspectionResponse,
  DurableInspectionView,
  DurableNumericUsage,
  DurableTaskItem,
} from "./durable-inspector.js"

export type {
  GitHubAccount,
  GitHubApplicationState,
  GitHubConnection,
  GitHubFlow,
  GitHubReceipt,
} from "./github-auth.js"

export type {
  RuntimeConfigEntry,
  RuntimeConfigMutation,
  RuntimeConfigResponse,
} from "./runtime-config.js"

export type Snapshot = {
  revision: number
  applied: number
  status: string
  policy: Policy
  epoch: number
}

/** Provider requirements only; policy permission and live entitlement are separate. */
export interface ToolAvailability {
  available: boolean
  /** Fixed host-owned diagnostic; never include credentials or raw upstream errors. */
  reason: string
}

/** Fixed diagnostics only. Never include transport addresses or upstream error text. */
export type McpObservationFailure = "transport" | "listing" | "timeout" | "cancelled"

/** Memory-only discovery of the saved configuration, not permission or health. Times are Unix milliseconds. */
export type McpObservation =
  | { state: "untested" }
  | { state: "checking"; revision: number; startedAt: number }
  | { state: "succeeded"; revision: number; completedAt: number }
  | {
      state: "failed"
      revision: number
      completedAt: number
      reason: McpObservationFailure
    }

export interface Inventory {
  tools: string[]
  toolAvailability?: Record<string, ToolAvailability>
  skills?: { name: string; description: string }[]
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
    /** Missing observations are unknown. Only current success establishes a tool count. */
    observation?: McpObservation
    /** Published tool names after exposure and safety limits, not every remote tool. */
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
