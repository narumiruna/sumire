import type { StatusProviderId } from "@narumitw/sumire-policy"

export type ServiceStatusProviderId = StatusProviderId

export type ServiceStatusDiagnostic =
  | "source_unavailable"
  | "delivery_failed"
  | "forbidden"
  | "chat_unavailable"
  | "timeout"
  | "queue_full"
  | "cancelled"
  | "rate_limited"

export interface ServiceStatusComponent {
  id: string
  name: string
  status: string
  groupId?: string | null
  isGroup?: boolean
}

export interface ServiceStatusCatalog {
  provider: ServiceStatusProviderId
  components: ServiceStatusComponent[]
  fetchedAt: number | null
  stale: boolean
  error: ServiceStatusDiagnostic | null
}

export interface ServiceStatusSourceResult {
  provider: ServiceStatusProviderId
  lastAttemptAt: number | null
  lastSuccessAt: number | null
  lastFailureAt: number | null
  lastError: ServiceStatusDiagnostic | null
}

export interface ServiceStatusDeliveryRecord {
  chatId: number
  provider: ServiceStatusProviderId | "test"
  lastAttemptAt: number | null
  lastSuccessAt: number | null
  lastFailureAt: number | null
  lastError: ServiceStatusDiagnostic | null
  pendingCount: number
  nextDueAt: number | null
}

export interface ServiceStatusDeliveryResponse {
  items: ServiceStatusDeliveryRecord[]
  sources: ServiceStatusSourceResult[]
  offset: number
  limit: number
  total: number
  serverTime: number
  nextPollAt: number | null
}

export interface ServiceStatusTestRequest {
  chatId: number
  revision: number
  confirm: true
}

export interface ServiceStatusTestResult {
  chatId: number
  success: boolean
  code: ServiceStatusDiagnostic | null
  attemptedAt: number
}
