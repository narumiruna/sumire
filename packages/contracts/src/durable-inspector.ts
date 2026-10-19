export type DurableInspectionView = "conversations" | "tasks" | "documents" | "entries"
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
  status: "pending" | "running" | "waiting" | "completing" | "terminal"
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

export type DurableEntryItem = {
  type: "entry"
  id: number
  conversationId: number
  kind: string
  byTaskId?: number
  head?: number
  role?: "system" | "user" | "assistant" | "toolResult"
  timestamp?: number
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
  nextCursor?: string
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
