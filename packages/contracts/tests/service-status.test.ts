import type { StatusProviderId } from "@narumitw/sumire-policy"
import { expect, expectTypeOf, it } from "vitest"
import type {
  ServiceStatusCatalog,
  ServiceStatusComponent,
  ServiceStatusDeliveryRecord,
  ServiceStatusDeliveryResponse,
  ServiceStatusDiagnostic,
  ServiceStatusProviderId,
  ServiceStatusSourceResult,
  ServiceStatusTestRequest,
  ServiceStatusTestResult,
} from "../src/index.js"

it("exports browser-safe status API types with the policy provider union", async () => {
  expectTypeOf<ServiceStatusProviderId>().toEqualTypeOf<StatusProviderId>()
  expectTypeOf<ServiceStatusDiagnostic>().toEqualTypeOf<
    | "source_unavailable"
    | "delivery_failed"
    | "forbidden"
    | "chat_unavailable"
    | "timeout"
    | "queue_full"
    | "cancelled"
    | "rate_limited"
  >()
  expectTypeOf<ServiceStatusComponent>().toEqualTypeOf<{
    id: string
    name: string
    status: string
    groupId?: string | null
    isGroup?: boolean
  }>()
  expectTypeOf<ServiceStatusTestRequest["confirm"]>().toEqualTypeOf<true>()
  expect(Object.keys(await import("../src/service-status.js"))).toEqual([])
  expect(Object.keys(await import("../src/index.js"))).toEqual([])
})

it("preserves unknown freshness, distinct source outcomes, and independent delivery times", () => {
  const component: ServiceStatusComponent = { id: "api", name: "API", status: "operational" }
  const catalog: ServiceStatusCatalog = {
    provider: "cloudflare",
    components: [
      { ...component, id: "group", isGroup: true, groupId: null },
      { ...component, groupId: "group", isGroup: false },
    ],
    fetchedAt: null,
    stale: true,
    error: "source_unavailable",
  }
  const source: ServiceStatusSourceResult = {
    provider: catalog.provider,
    lastAttemptAt: 2000,
    lastSuccessAt: 1000,
    lastFailureAt: 2000,
    lastError: "source_unavailable",
  }
  const delivery: ServiceStatusDeliveryRecord = {
    chatId: -100,
    provider: "test",
    lastAttemptAt: 3000,
    lastSuccessAt: 1000,
    lastFailureAt: 3000,
    lastError: "forbidden",
    pendingCount: 2,
    nextDueAt: 4000,
  }
  const response: ServiceStatusDeliveryResponse = {
    items: [delivery],
    sources: [source],
    offset: 0,
    limit: 25,
    total: 1,
    serverTime: 3000,
    nextPollAt: null,
  }
  expect(response.sources[0]?.lastError).toBe("source_unavailable")
  expect(response.items[0]?.lastSuccessAt).toBe(1000)
  expect(response.items[0]?.lastFailureAt).toBe(3000)
  expect(component).not.toHaveProperty("groupId")
})

it("keeps confirmed test requests separate from bounded fixed-code outcomes", () => {
  const request: ServiceStatusTestRequest = { chatId: 42, revision: 3, confirm: true }
  const success: ServiceStatusTestResult = {
    chatId: request.chatId,
    success: true,
    code: null,
    attemptedAt: 1000,
  }
  const failure: ServiceStatusTestResult = {
    chatId: request.chatId,
    success: false,
    code: "rate_limited",
    attemptedAt: 2000,
  }
  expect(success.success).toBe(true)
  expect(failure.code).toBe("rate_limited")
  expectTypeOf<ServiceStatusCatalog["fetchedAt"]>().toEqualTypeOf<number | null>()
  expectTypeOf<ServiceStatusDeliveryResponse["items"]>().toEqualTypeOf<
    ServiceStatusDeliveryRecord[]
  >()
  expectTypeOf<ServiceStatusDeliveryResponse["sources"]>().toEqualTypeOf<
    ServiceStatusSourceResult[]
  >()
  expectTypeOf<ServiceStatusTestResult["code"]>().toEqualTypeOf<ServiceStatusDiagnostic | null>()
})
