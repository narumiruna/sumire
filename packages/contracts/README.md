# Sumire Contracts

Shared management API data types for the bot and administration frontend: Snapshot, Inventory, Chat, ChatResponse, AuditEntry, ImportReport, and runtime configuration entries/mutations/responses. Runtime configuration responses include secret metadata only; variable values are non-confidential.

Policy types belong to `@narumitw/sumire-policy`. This package imports them only as types and provides no runtime validation, HTTP client, database access, or UI components. Runtime policy validation remains in the policy package.

## Service status API

The type-only `service-status.ts` exports are also available from the package index:

- `ServiceStatusProviderId` uses the policy provider union.
- `ServiceStatusComponent` contains stable ID, name, status, and optional `groupId` and `isGroup` metadata. Missing metadata stays optional.
- `ServiceStatusCatalog` contains one provider's components, fetch time, stale flag, and fixed diagnostic.
- `ServiceStatusSourceResult` and `ServiceStatusDeliveryRecord` keep attempt, success, and failure times separate. Delivery records also contain pending count and next due time; `"test"` identifies manual test results.
- `ServiceStatusDeliveryResponse` contains paginated delivery records, source results, server time, and next poll time.
- `ServiceStatusTestRequest` requires a chat ID, applied revision, and `confirm: true`. `ServiceStatusTestResult` contains success, diagnostic code, and attempt time.
- `ServiceStatusDiagnostic` permits only `source_unavailable`, `delivery_failed`, `forbidden`, `chat_unavailable`, `timeout`, `queue_full`, `cancelled`, and `rate_limited`. Result types have no raw-error field.

Times are numeric UTC epoch milliseconds or `null` where unknown. These contracts have no status reader dependency and add no runtime code to browser imports. The bot owns request validation and delivery authorization.

Run checks from the repository root:

```sh
npm run test --workspace @narumitw/sumire-contracts
npm run build --workspace @narumitw/sumire-contracts
```
