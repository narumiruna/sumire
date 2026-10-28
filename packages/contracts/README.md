# Sumire Contracts

Shared management API data types for the bot and administration frontend: Snapshot, Inventory, Chat, ChatResponse, AuditEntry, ImportReport, and runtime configuration entries/mutations/responses. Runtime configuration responses include secret metadata only; variable values are non-confidential.

Policy types belong to `@narumitw/sumire-policy`. This package imports them only as types and provides no runtime validation, HTTP client, database access, or UI components. Runtime policy validation remains in the policy package.

Run checks from the repository root:

```sh
npm run test --workspace @narumitw/sumire-contracts
npm run build --workspace @narumitw/sumire-contracts
```
