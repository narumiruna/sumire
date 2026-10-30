export type DurableInspectionView = "conversations" | "tasks" | "documents" | "entries" | "history"
export type DurableDocumentScope = "session" | "conversation" | "task"

export type DurableInspectionQuery = {
  view: DurableInspectionView
  conversationId?: number
  taskId?: number
  scope?: DurableDocumentScope
  objectId?: number
  limit: number
  cursor?: string
}

export type DurableConversationItem = {
  type: "conversation"
  id: number
  parent?: { conversationId: number; at: number }
  owner?: { conversationId: number; taskId: number }
  active: boolean
}

export type DurableTaskItem = {
  type: "task"
  id: number
  conversationId: number
  kind: string
  version: number
  ownerTaskId?: number
  background: boolean
  abortRequested: boolean
  status: "pending" | "running" | "sleeping" | "waiting" | "completing" | "terminal"
  outcome?: "completed" | "failed" | "aborted" | "orphaned" | "faulted"
  startedAt?: number
  endedAt?: number
}

export type DurableNumericUsage = {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  total?: number
  cost?: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
    total?: number
  }
}

export type DurableDocumentProjection =
  | {
      kind: "pi.agent"
      model?: { provider: string; modelId: string }
      thinkingLevel?: string
    }
  | {
      kind: "pi.usage"
      models: Record<string, DurableNumericUsage>
      total: DurableNumericUsage
    }
  | { kind: "sumire.session"; activeConversation?: number }

export type DurableDocumentItem = {
  type: "document"
  id: number
  kind: string
  scope:
    | { kind: "session" }
    | { kind: "conversation"; conversationId: number }
    | { kind: "task"; taskId: number }
  family: boolean
  createdAt: number
  retiredAt?: number
  version?: number
  valueState: "metadata-only" | "available" | "withheld" | "unavailable"
  value?: DurableDocumentProjection
  withheldReason?: "unknown-kind" | "invalid-value" | "limit"
}

export type DurableEntryContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: string }
  | { type: "image"; mimeType: string }

export type DurableEntryMessage = {
  role: "system" | "user" | "assistant" | "toolResult"
  content: DurableEntryContentBlock[]
  toolName?: string
  toolCallId?: string
  isError?: boolean
}

export type DurableEntryItem = {
  type: "entry"
  id: number
  conversationId: number
  kind: string
  byTaskId?: number
  head?: number
  role?: "system" | "user" | "assistant" | "toolResult"
  timestamp?: number
  toolName?: string
  toolCallId?: string
  isError?: boolean
  /** Bounded saved model-facing content, included for history and entry objectId reads. */
  content?: { messages: DurableEntryMessage[]; truncated: boolean }
}

export type DurableInspectionItem =
  | DurableConversationItem
  | DurableTaskItem
  | DurableDocumentItem
  | DurableEntryItem

export type DurableInspectionLoadedResponse = {
  version: 1
  state: "loaded"
  readAt: string
  view: DurableInspectionView
  items: DurableInspectionItem[]
  /** Persisted selection on conversations reads; null means no selection or missing record. */
  selectedConversation?: DurableConversationItem | null
  nextCursor?: string
  /** Returned content is incomplete or the response byte limit omitted rows. */
  truncated: boolean
}

export type DurableInspectionResponse =
  | DurableInspectionLoadedResponse
  | {
      version: 1
      state: "not-loaded"
      readAt: string
      view: DurableInspectionView
      items: []
      truncated: false
    }
