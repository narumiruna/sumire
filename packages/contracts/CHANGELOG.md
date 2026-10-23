# @narumitw/sumire-contracts

## 0.6.0

### Minor Changes

- b5fa6fc: Fix imagegen tool availability after restart by reading Pi's non-secret credential metadata instead of an uninitialized auth snapshot. Preserve effective chat permissions and recheck asynchronous authorization before generation and delivery. Add optional capability diagnostics to the authenticated inventory, show provider requirements separately from policy in the WebUI, and log imagegen availability, permission, and installation without credentials or prompts.

## 0.5.0

### Minor Changes

- 7648df0: Show Durable relationships in an expandable tree and inspect recorded message text, thinking, tool arguments, and tool results. Keep collection reads metadata-only, bound explicit content reads, and show incomplete data without exposing image bytes or protocol fields.
  
  Apply a shared Radix sand/teal workspace to all eight production Admin pages. Add consistent navigation, headers, touch targets, structured facts, permission tables, and responsive chat, MCP, and provider inspectors while preserving drafts, authentication, protected values, and separate save scopes. Keep Durable content first with retained mobile expansion and focus, accessible record colors, independent detail sizing, and secondary history, raw collections, metadata, and JSON views.
- 6ea8d02: Add skill management to the administration WebUI with discovered descriptions, global availability, shared defaults, and per-chat inheritance or explicit selections. Apply selected skills to each chat’s prompt without changing tool access. Preserve existing policy data and manual removals through persistent first-seen skill registration.

### Patch Changes

- Updated dependencies [6ea8d02]
  - @narumitw/sumire-policy@0.4.0

## 0.4.0

### Minor Changes

- 8072e66: Add shared stored-directory search and exact chat metadata lookup. Let Durable select chats directly with history-safe URLs, then show persisted conversation selection and bounded task history before compact object inspection. Preserve the inspected conversation across tab changes, approved raw metadata, manual refresh, per-block read times, draft protection, and read-only session ownership.
- 4db4191: Add a read-only, chat-scoped Pi Durable Inspector for already loaded sessions. Show bounded object metadata and approved document projections with authenticated reads, query-bound pagination, and lifecycle-safe storage leases. Inspection does not load chats, change durable state, or start model/tool work.

## 0.3.1

### Patch Changes

- b0384ec: Update dependencies and restore compatibility with Pi 1.3 and TypeScript 7. Preserve durable tool output, MCP namespace discovery, and API generation. Remove lint, install, build, and experimental passkey warnings.
- Updated dependencies [b0384ec]
  - @narumitw/sumire-policy@0.3.1

## 0.3.0

### Minor Changes

- 2798cbf: Require Node.js 26 or newer across all workspaces. CI, release workflows, and Docker stages now use Node.js 26. Node.js versions below 26 are no longer supported.

### Patch Changes

- Updated dependencies [2798cbf]
  - @narumitw/sumire-policy@0.3.0

## 0.2.2

### Patch Changes

- 61fc250: Group tools by explicit inventory source in compact, accessible sections. Add bulk expansion controls and per-user local expansion preferences without changing permissions. Expose built-in tool metadata separately from the combined inventory.

## 0.2.1

### Patch Changes

- Updated dependencies [ae28992]
  - @narumitw/sumire-policy@0.2.1

## 0.2.0

### Minor Changes

- 0bd4846: Extract shared management API contracts and policy schemas and rules into private workspace packages. Remove administration frontend imports of bot source, and update dependency builds, Docker stages, and CI.

### Patch Changes

- Updated dependencies [0bd4846]
  - @narumitw/sumire-policy@0.2.0
