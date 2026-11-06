# @narumitw/sumire-contracts

## 0.10.0

### Minor Changes

- 58d33ba: Reorganize administration around explicit configuration scopes and separate save operations. Add provider list/detail, model-removal impact review, list-first secrets, shared GitHub connection entry, compact capability lists, and a chat-directory conversation reader. Preserve policy inheritance, read-only inspection, credential boundaries, and draft recovery.
  
  Add optional, revision-bound MCP discovery observations with safe typed outcomes and timestamps. Distinguish untested, successful-empty, failed, and unknown results without granting tool permissions.

## 0.9.2

### Patch Changes

- 7399c4b: Update workspace dependencies, including Pi 1.5.0 and Polymarket 0.16.0. Import TypeBox directly, preserve typed string enums with Pi's updated schema helpers, and regenerate the Polymarket catalog with the current TypeScript compiler.
  
  Migrate the bot to Durable conversation observations while preserving progress delivery and the full active transcript. Keep nested tool results in session completion events. Preserve message completion events and direct tool results when a bulk commit exceeds the bounded observation window. Keep literal HTML entity spellings unchanged with the updated Markdown tokenizer.
  
  Update the bundled curl-impersonate library to v2.3.2 with verified Linux archive checksums. This matches the Chrome profiles required by impers 0.1.3.
  
  Back up durable storage before deployment. Pi 1.5 upgrades `pi.live` documents; rollback requires the matching pre-upgrade state.
- Updated dependencies [7399c4b]
  - @narumitw/sumire-policy@0.5.2

## 0.9.1

### Patch Changes

- 0c227d3: Restore the repository to commit 35a2b199b517640c87adbbfd5c12f5c187b454d5. Restore the Node.js container runtime, Docker build layout, URL readers, tests, documentation, and dependency versions from that snapshot. Replace the reverted changesets with this rollback changeset.
- Updated dependencies [0c227d3]
  - @narumitw/sumire-policy@0.5.1

## 0.9.0

### Minor Changes

- e9235ee: Add a read-only Conversation History with saved message content, user-turn groups, loaded-page filters, and responsive Event details. Retain branch inspection and existing object links. Add bounded, ancestry-scoped history API reads and stable entry continuation tokens without changing durable state or starting model work.

## 0.8.0

### Minor Changes

- 0ca1947: Add WebUI GitHub Device Flow with verified-account confirmation, encrypted paired access/refresh credentials, session-owned cancellation and outcome recovery, and single-flight refresh before authorized shell execution. Preserve manual PATs and existing tool permissions, protect refresh state from generic APIs, and prevent stale credential writes or subprocess dispatch after revocation.
- 825ca3c: Replace Telegram notification recipients with GitHub mention author usernames. Reply on GitHub only to allowed authors who directly mention the account authenticated by GH_TOKEN. Add bounded polling, isolated Pi Durable generation, persisted response recovery, and delivery authorization checks.
  
  Migrate legacy Telegram ID lists to empty GitHub allowlists under admin schema v5. Remove the Telegram notification-reading tool and update the administration page, setup guidance, and compatibility links.

### Patch Changes

- 76b6b56: Use the applied managed GH_TOKEN for GitHub notifications and replace the generic recipient variable with a dedicated administration page. Store validated recipient IDs in policy settings with review, application, audit, and conflict recovery. Keep private-chat and tool permission checks before and after notification requests.
- Updated dependencies [825ca3c]
- Updated dependencies [76b6b56]
  - @narumitw/sumire-policy@0.5.0

## 0.7.0

### Minor Changes

- 593c3df: Add administrator-managed encrypted runtime secrets and non-confidential variables. Resolve current stored credentials for Morsel, Firecrawl, and explicit MCP bindings after settings application. Add a deny-by-default variable reader and preserve standalone URL-reader environment compatibility. Keep newly discovered MCP tools denied until explicitly approved so credential activation cannot expand permissions.

## 0.6.2

### Patch Changes

- 203d5d3: Update Pi to 1.4.0 and refresh workspace dependencies and development tools. Add explicit Durable document checkpoint policies without changing document identities or fork behavior. Support sleeping tasks in administration inspection and regenerate the Polymarket 0.14.0 SDK catalog.
  
  Pi Durable automatically upgrades SQLite storage to schema version 2. Before deployment, stop the bot and take a consistent state backup. Rollback to Pi Durable 1.3.0 or earlier requires the previous image and matching pre-upgrade state backup.

## 0.6.1

### Patch Changes

- Updated dependencies [9377d61]
  - @narumitw/sumire-policy@0.4.1

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
