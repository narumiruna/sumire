# Sumire Contracts

Shared management API data types for the bot and administration frontend: Snapshot, Inventory, Chat, ChatResponse, AuditEntry, ImportReport, and runtime configuration entries/mutations/responses. Runtime configuration responses include secret metadata only; variable values are non-confidential.

Policy types belong to `@narumitw/sumire-policy`. This package imports them only as types and provides no runtime validation, HTTP client, database access, or UI components. Runtime policy validation remains in the policy package.

## MCP observations

`Inventory.mcp[].observation` is optional. A missing field means Unknown, not successful discovery or zero tools. Existing `connection` and `tools` fields remain available for older clients.

| State | Fields and meaning |
| --- | --- |
| `untested` | No current observation. |
| `checking` | Saved `revision` and Unix-millisecond `startedAt`. |
| `succeeded` | Saved `revision` and Unix-millisecond `completedAt`; `tools` contains published names after exposure/safety limits and can be empty. |
| `failed` | Saved `revision`, `completedAt`, and a fixed `reason`: `transport`, `listing`, `timeout`, or `cancelled`. No raw endpoint or upstream diagnostic is included. |

Observations are memory-only and bound to the saved/applied configuration and authorization epoch. Apply, configuration invalidation, and restart remove them. A connection result is neither execution permission nor current service health. Discovery registers names without granting global, default, chat, or server permission. The frontend shows a count only for current successful observations.

Run checks from the repository root:

```sh
npm run test --workspace @narumitw/sumire-contracts
npm run build --workspace @narumitw/sumire-contracts
```
