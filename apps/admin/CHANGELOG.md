# @narumitw/sumire-admin

## 0.11.0

### Minor Changes

- fec4129: Restyle administration to match the conversation-records reference with a light green sidebar, breadcrumbs, chat identity, and a three-part context strip. Present the existing bounded History results as a compact entry list with text previews, loaded-page filtering, ordering, and previous/next entry navigation. Retain upstream pagination, branch inspection, raw collections, read-only access, and mobile detail dialogs. Keep keyboard focus on desktop entry controls during detail reads, and preserve the compact chat and settings headers.
- e9235ee: Add a read-only Conversation History with saved message content, user-turn groups, loaded-page filters, and responsive Event details. Retain branch inspection and existing object links. Add bounded, ancestry-scoped history API reads and stable entry continuation tokens without changing durable state or starting model work.

### Patch Changes

- 6cf870a: Remove the chat directory's nested scrollbar and height limit. Use page scrolling at every viewport size and preserve the scroll position when returning from chat details.
- 428ee7d: Simplify chat administration with one directory or detail pane at every screen width, a shared chat actions menu, and compact overview rows. Preserve drafts, navigation, warnings, and directory focus and scroll; keep all four chat tabs visible on narrow screens.
- 461a8f3: Merge chat access management into Chats and show a compact, responsive directory with right-aligned three-dot menus. Stage per-chat access grants, revocations, and undo actions without changing chat settings or saving automatically. Preserve manual approval, complete access lists, legacy links, and editor drafts.
  
  Avoid a redundant GitHub status refresh after saving the public Client ID so the application retry button does not become disabled again during a click.
- Updated dependencies [e9235ee]
  - @narumitw/sumire-contracts@0.9.0

## 0.10.0

### Minor Changes

- 0ca1947: Add WebUI GitHub Device Flow with verified-account confirmation, encrypted paired access/refresh credentials, session-owned cancellation and outcome recovery, and single-flight refresh before authorized shell execution. Preserve manual PATs and existing tool permissions, protect refresh state from generic APIs, and prevent stale credential writes or subprocess dispatch after revocation.
- 825ca3c: Replace Telegram notification recipients with GitHub mention author usernames. Reply on GitHub only to allowed authors who directly mention the account authenticated by GH_TOKEN. Add bounded polling, isolated Pi Durable generation, persisted response recovery, and delivery authorization checks.
  
  Migrate legacy Telegram ID lists to empty GitHub allowlists under admin schema v5. Remove the Telegram notification-reading tool and update the administration page, setup guidance, and compatibility links.

### Patch Changes

- 76b6b56: Use the applied managed GH_TOKEN for GitHub notifications and replace the generic recipient variable with a dedicated administration page. Store validated recipient IDs in policy settings with review, application, audit, and conflict recovery. Keep private-chat and tool permission checks before and after notification requests.
- 316f0d5: Add bounded read-only GitHub notification tools that share the applied encrypted GH_TOKEN with GitHub CLI. Manage private Telegram recipients on a dedicated administration page with validated policy storage, review, application, and conflict recovery. Preserve normal tool permissions for direct and codemode execution.
- Updated dependencies [0ca1947]
- Updated dependencies [825ca3c]
- Updated dependencies [76b6b56]
  - @narumitw/sumire-contracts@0.8.0
  - @narumitw/sumire-policy@0.5.0

## 0.9.0

### Minor Changes

- d0ad4cd: Include GitHub CLI in the production image and resolve its GH_TOKEN from administrator-managed encrypted secrets for each shell call after settings application. Reuse the WebUI secret controls with GitHub setup guidance, retain existing tool permissions, and do not inherit host GitHub credentials.

## 0.8.0

### Minor Changes

- 593c3df: Add administrator-managed encrypted runtime secrets and non-confidential variables. Resolve current stored credentials for Morsel, Firecrawl, and explicit MCP bindings after settings application. Add a deny-by-default variable reader and preserve standalone URL-reader environment compatibility. Keep newly discovered MCP tools denied until explicitly approved so credential activation cannot expand permissions.

### Patch Changes

- 9f3bc6c: Rename the host bootstrap encryption setting to ENCRYPTION_KEY. Accept 32-byte keys encoded as 64 hex characters from `openssl rand -hex 32`, while preserving canonical Base64 support for existing encrypted databases. Update reserved-name checks, administration guidance, and setup documentation. Permit explicit deletion of legacy entries whose names become reserved without allowing new values under those names.
- Updated dependencies [593c3df]
  - @narumitw/sumire-contracts@0.7.0

## 0.7.3

### Patch Changes

- 9ee71d1: Rename Tool connections to MCP Servers in the WebUI without changing existing section URLs.

## 0.7.2

### Patch Changes

- bf6de77: Preserve settings drafts through revision conflicts and unknown save outcomes. Correct model-picker keyboard navigation, explicit section targets, Audit labels, and focus after MCP draft discard.
- c7276b3: Add a violet-flower SVG icon for the browser tab, navigation, and administrator sign-in screens. Match the existing forest-green and warm neutral theme.

## 0.7.1

### Patch Changes

- f53afc0: Remove default and chat references in the same policy draft when a model is removed from global availability. Clear matching model and thinking settings so reviewed changes can be saved without invalid model references.
- 203d5d3: Update Pi to 1.4.0 and refresh workspace dependencies and development tools. Add explicit Durable document checkpoint policies without changing document identities or fork behavior. Support sleeping tasks in administration inspection and regenerate the Polymarket 0.14.0 SDK catalog.
  
  Pi Durable automatically upgrades SQLite storage to schema version 2. Before deployment, stop the bot and take a consistent state backup. Rollback to Pi Durable 1.3.0 or earlier requires the previous image and matching pre-upgrade state backup.
- Updated dependencies [203d5d3]
  - @narumitw/sumire-contracts@0.6.2

## 0.7.0

### Minor Changes

- 6b45844: Guide provider and model setup through explicit save scopes, compact mobile chat actions and settings layouts, group navigation by task, and provide one record-specific refresh action.
- 40828b0: Apply the warm editorial direction B to all administration pages. Make shared defaults editable in place, count actual pending policy differences, and separate bottom draft actions from saved application status. Keep provider setup, permissions, skills, connections, chat access, records, and audit actions on their existing API contracts.

### Patch Changes

- 9377d61: Separate saved settings from local model setup, add long-list permission filters and fixed editing context, and edit shared model defaults in place. Keep provider authentication, global availability, and chat overrides separate.
- 3426c4e: Put model selection, chat approval, connection setup, and chat actions before advanced details. Add bounded access lists, tool/source search, explicit global-limit editing, and one settings review while preserving drafts, permissions, and separate save actions.
- 073624a: Reveal failed saves without losing drafts, focus desktop section headings after navigation, improve control and status contrast, and include selected provider and model values in accessible names.
- Updated dependencies [9377d61]
  - @narumitw/sumire-policy@0.4.1
  - @narumitw/sumire-contracts@0.6.1

## 0.6.1

### Patch Changes

- e504a57: Make pending-input warnings actionable, retain explicit default-model intent, and open chat model controls directly. Reveal connection editors and advanced settings only when needed, and add readable exact-value audit filters without changing save scopes or permissions.
- b5fa6fc: Fix imagegen tool availability after restart by reading Pi's non-secret credential metadata instead of an uninitialized auth snapshot. Preserve effective chat permissions and recheck asynchronous authorization before generation and delivery. Add optional capability diagnostics to the authenticated inventory, show provider requirements separately from policy in the WebUI, and log imagegen availability, permission, and installation without credentials or prompts.
- Updated dependencies [b5fa6fc]
  - @narumitw/sumire-contracts@0.6.0

## 0.6.0

### Minor Changes

- 7648df0: Show Durable relationships in an expandable tree and inspect recorded message text, thinking, tool arguments, and tool results. Keep collection reads metadata-only, bound explicit content reads, and show incomplete data without exposing image bytes or protocol fields.
  
  Apply a shared Radix sand/teal workspace to all eight production Admin pages. Add consistent navigation, headers, touch targets, structured facts, permission tables, and responsive chat, MCP, and provider inspectors while preserving drafts, authentication, protected values, and separate save scopes. Keep Durable content first with retained mobile expansion and focus, accessible record colors, independent detail sizing, and secondary history, raw collections, metadata, and JSON views.
- 6ea8d02: Add skill management to the administration WebUI with discovered descriptions, global availability, shared defaults, and per-chat inheritance or explicit selections. Apply selected skills to each chat’s prompt without changing tool access. Preserve existing policy data and manual removals through persistent first-seen skill registration.

### Patch Changes

- a667851: Show saved chat setup state and repair actions, compact clean save controls, clarify setting scopes, and group administration tasks without changing policy or save boundaries. Keep narrow conversation workspaces compact when fallback fonts wrap the page title. Keep standalone comparison capture compatible with native Node TypeScript loading.
- Updated dependencies [7648df0]
- Updated dependencies [6ea8d02]
  - @narumitw/sumire-contracts@0.5.0
  - @narumitw/sumire-policy@0.4.0

## 0.5.0

### Minor Changes

- 8072e66: Add shared stored-directory search and exact chat metadata lookup. Let Durable select chats directly with history-safe URLs, then show persisted conversation selection and bounded task history before compact object inspection. Preserve the inspected conversation across tab changes, approved raw metadata, manual refresh, per-block read times, draft protection, and read-only session ownership.
- 4db4191: Add a read-only, chat-scoped Pi Durable Inspector for already loaded sessions. Show bounded object metadata and approved document projections with authenticated reads, query-bound pagination, and lifecycle-safe storage leases. Inspection does not load chats, change durable state, or start model/tool work.

### Patch Changes

- 8072e66: Preserve observed chat names and types across startup, imports, partial updates, and delayed access approvals. Persist group renames and complete private display names without changing access policy or loading sessions. Show unknown names separately from metadata read states.
- ed32d1c: Make Durable inspection context-first, with readable record labels, recorded task outcomes, UTC dates, and labeled approved document values after explicit inspection. Keep historical conversation targets across related views and make direct Conversation ID lookup retrieve the requested record. Preserve read-only access, bounded manual reads, and secondary technical details without new API fields or automatic value reads.
- e6865d6: Unify administration panels, controls, and status hierarchy. Add guided MCP steps and contain malformed-record failures without changing save or permission behavior.
- Updated dependencies [8072e66]
- Updated dependencies [4db4191]
  - @narumitw/sumire-contracts@0.4.0

## 0.4.3

### Patch Changes

- b0384ec: Update dependencies and restore compatibility with Pi 1.3 and TypeScript 7. Preserve durable tool output, MCP namespace discovery, and API generation. Remove lint, install, build, and experimental passkey warnings.
- Updated dependencies [b0384ec]
  - @narumitw/sumire-contracts@0.3.1
  - @narumitw/sumire-policy@0.3.1

## 0.4.2

### Patch Changes

- 1823bd5: Use the shared policy resolver in the administration editor, replace the bot's legacy session representation with explicit checkpoint and passive-context operations, and share MCP revision transactions and market batch-result handling without changing external behavior.

## 0.4.1

### Patch Changes

- 9c7774a: Restore directory scroll when returning from chat details without a current directory row.
- 1dea978: Separate the chat directory list and footer, stabilize chat headers and long titles, and prioritize readiness blockers with expandable status details. Keep directories usable below tall page content and retain directory scroll through footer actions. Add responsive layout and tab navigation regression tests.

## 0.4.0

### Minor Changes

- 2798cbf: Require Node.js 26 or newer across all workspaces. CI, release workflows, and Docker stages now use Node.js 26. Node.js versions below 26 are no longer supported.

### Patch Changes

- Updated dependencies [2798cbf]
  - @narumitw/sumire-contracts@0.3.0
  - @narumitw/sumire-policy@0.3.0

## 0.3.3

### Patch Changes

- 61fc250: Group tools by explicit inventory source in compact, accessible sections. Add bulk expansion controls and per-user local expansion preferences without changing permissions. Expose built-in tool metadata separately from the combined inventory.
- Updated dependencies [61fc250]
  - @narumitw/sumire-contracts@0.2.2

## 0.3.2

### Patch Changes

- ae28992: Enable first-seen built-in and MCP tools in global and shared-default permissions. Preserve manual removals, explicit chat overrides, server gates, and chat access. Track registered names persistently and record automatic grants in the audit log. Keep startup available when permission lists are full. Register MCP names before authorization, but count only allowed tools against the runtime metadata limit.
- Updated dependencies [ae28992]
  - @narumitw/sumire-policy@0.2.1
  - @narumitw/sumire-contracts@0.2.1

## 0.3.1

### Patch Changes

- 0bd4846: Extract shared management API contracts and policy schemas and rules into private workspace packages. Remove administration frontend imports of bot source, and update dependency builds, Docker stages, and CI.
- Updated dependencies [0bd4846]
  - @narumitw/sumire-contracts@0.2.0
  - @narumitw/sumire-policy@0.2.0

## 0.3.0

### Minor Changes

- dcd5173: Add a responsive chat-centric workspace with sidebar links, page-scoped search and filters, compatible chat deep links, effective policy summaries, contextual staged access actions, Model & Tools editing, and scoped audit history. Remove the obsolete chat selector, close remaining search popovers on navigation, preserve cross-section drafts, and show persistent scoped policy review, apply, discard, and pending access changes without changing backend save boundaries.
  
  Keep access undo and pending counts consistent. Refresh current chat metadata with Reload. Clear the session and sensitive drafts when a chat request returns 401. Clear cached chat metadata after sign-out.
- cff5f69: Clarify administration save scopes and chat readiness, add guided MCP patch editing and redacted change previews, and provide filtered, grouped audit history with accessible controls.
  
  Keep MCP previews consistent with saved transports, clear audit errors after query recovery, and bind model-list check results to the checked endpoint settings.
- 5e2fc04: Centralize global and shared-default tool permissions with retained-selection warnings. Separate MCP connections, replace duplicate Defaults editors with saved/draft summaries, and clarify the all-chat override reset. Preserve authorization rules, drafts, legacy section links, and separate saves.

### Patch Changes

- c9051b2: Prioritize chat setup blockers, compact effective settings and directory rows, and clarify provider authentication and separate model and policy save actions. Add browser coverage for tab navigation and responsive action layout.

## 0.2.0

### Minor Changes

- 426f3d7: Add a Passkey-authenticated Radix administration interface with persistent chat policies, model provider management, MCP configuration, audit records, and HTTPS deployment guidance. Expose the shared bounded public-network helpers for provider requests. Add the private administrator-only `/admin` command to open the WebUI before chat approval. Use administrator-only first-passkey setup links, browser-bound WebAuthn challenges, and a state migration that revokes old Telegram sessions. Remove Telegram Web Login credentials. Add searchable provider and model setup, supported authentication dialogs, capability badges, explicit default selection, and separate custom endpoint controls. Load saved default and chat models into provider setup without promoting chat overrides to a shared default. Keep blank bind hosts on loopback, import valid MCP entries independently, use the runtime working directory for MCP probes, and apply the latest concurrent policy revision. Add revision-checked MCP deletion with confirmation and capacity recovery, block stale MCP startup after policy changes, ignore unused admin ports while the WebUI is disabled, and report unsupported imported thinking levels without failing the shared policy.
- 9f3168d: Remove environment-based chat authorization and require `BOT_ADMIN_ID` plus the SQLite administration policy for all bot admission, restored work, model access, and tools. New databases deny all chats until explicit WebUI approval. Existing permissions, revocations, Passkeys, sessions, and historical access reviews remain unchanged.
  
  This is a breaking bootstrap change for the pre-1.0 bot: `BOT_WHITELIST` is ignored, WebUI administration cannot be disabled, and Stage 1 reconciliation must be accepted before upgrade. Remove reconciliation mutation endpoints and UI controls while retaining read-only historical reports on the Audit page.
- 9f0d16c: Add `/allow` links for explicit Passkey-authenticated chat approval, with short-lived hash-only requests, atomic policy updates, and review of existing environment allowlist IDs without restoring revoked access. Upgrade administration SQLite state to schema version 3; rollback requires a matching pre-upgrade backup.

### Patch Changes

- a9be0e1: Clarify configuration scope, separate save outcomes, and inherited chat settings. Add searchable chat selection, accessible access rows, pending-edit protection, MCP authorization summaries, and readable audit history without changing API or authorization semantics. Track pending changes from advanced provider controls and clear matching MCP drafts after deletion. Keep MCP drafts and staged secrets while reloading saved state after an uncertain save or deletion.
- 4c68102: Add a custom endpoint draft discard action. Start an empty MCP update through the explicit Edit fields action. Preserve JSON drafts while typing server names, including intermediate matches with existing names. Explain that explicit MCP secret maps replace all entries and require null markers for keys to retain.
- e71bb34: Show known chat names beside Telegram IDs in access lists. Keep IDs visible when names are unavailable.
- e9f5653: Rename the URL-reading tool from `load_public_url` to `read_url_content`. Update bot instructions, skills, documentation, and tests to use the new name. No legacy alias is registered; update direct calls, codemode scripts, and tool allowlists. Existing bot permissions are not transferred automatically: authorize the new name globally and in the effective chat policy through the Web UI.
- 82b3428: Identify model validation conflicts by settings scope and model. Add inline model warnings and a confirmed action to make all chats inherit shared defaults without changing access or enabled switches.
- 34cee96: Set the browser page title to Sumire.
