# Chat-centered Durable validation

## Result

The chat directory retains observed names and types across startup. Chats and Durable share bounded server search, exact selected-chat metadata lookup, selection controls, and display-name resolution. Durable starts with persisted selection and task-history evidence, followed by compact object browsing and expandable advanced/raw inspection.

Base: `2c47915` on `main`. Branch: `narumi/feat/chat-centered-durable`.

## Confirmed name-loss mechanism

Before the fix, `npm run test --workspace @narumitw/sumire -- tests/admin-application.test.ts` failed the actual administration startup regression: one test failed and three passed. After a file-backed store reopened, `startAdmin()` received the existing chat ID from factory inventory. The assertion expected `{ id: -100, type: "supergroup", name: "Persistent group" }` but received `{ id: -100, type: "group", name: "-100" }`.

The startup observation and unconditional upsert caused this loss. The final regression uses actual factory inventory, repeated administration restart, session recreation on the same store, authenticated HTTP metadata reads, a persisted rename, and old ID-only records. It does not call Telegram or models to resolve names.

| Writer | Merge rule | Evidence |
| --- | --- | --- |
| Telegram metadata, including commands and callbacks | Replace present observed fields; preserve missing, blank, and ID-only names. Private names use complete observed first/last names. Group rename events take priority over the old title in that event. | `admin-telegram.test.ts`, `admin-chat-metadata.test.ts` |
| Startup inventory, legacy model import, policy-created ID records | Create missing rows only. Never replace an existing observed name or type with ID/sign inference. | `admin-application.test.ts`, `admin-chat-metadata.test.ts` |
| Access request issuance, including already-approved `/allow` | Observe current metadata without changing policy or granting access. | `admin-access.test.ts`, `admin-telegram.test.ts` |
| Delayed approval and legacy pending requests | Insert missing metadata only, within the approval transaction. Never replay stale request metadata over a later observation. | `admin-access.test.ts` |

Schema version 3 remains unchanged. No migration or automatic backfill is needed. No verified current independent name source exists in the tracked storage contracts. Overwritten metadata requires a fresh Telegram observation. Reading transcripts, bulk remote name lookup, and opening sessions for recovery are excluded.

## Directory and navigation evidence

- `admin-server.test.ts` covers authenticated compatible array reads, global stored-directory search before pagination, complete IDs, literal SQL wildcard characters, Chinese names, duplicate names, exact metadata lookup, invalid/duplicate/unsupported parameters, and independent requests.
- `chat-directory.test.ts` covers neutral unknown names, whitespace/ID-only records, untrusted text, duplicate names, and encoded query paths.
- `chat-directory.spec.ts` covers search beyond 100 records, complete negative IDs, paginated queries, keyboard selection, matching Chats/Durable names after persisted rename and reload, exact metadata outside visible pages, loading/unknown/403/read failure, retries, stale query/page/lookup responses, rapid A→B→A navigation, refresh/back/forward, empty states, and session cleanup.
- `navigation.test.ts` retains compatible same-path links and removes old chat-specific inspector context on chat changes.
- Existing directory tooltip, filter clearing, draft retention, and exact narrow-screen scroll-restoration assertions remain active.

Search covers at most 1,000 stored directory records, with 100 results per API page. It does not search Telegram. A deterministic SQLite callback uses JavaScript `toLowerCase()` for name matching, preserving the previous client search behavior for Unicode names. Accented Latin, Greek, and Chinese names are tested. Search does not perform accent removal or language-specific collation. Access/type filters remain page-local and can use policy drafts. No endpoint grants access or creates a session during selection.

## Overview and lifecycle evidence

- Loaded conversation responses add optional `selectedConversation`. It is independent of the visible page, with at most one extra targeted conversation read. `null` means no available persisted selection. Older responses without the field remain usable and display selection unavailable.
- One context change or refresh uses at most three sequential inspector requests: one conversation page, one selected-conversation task page if available, and one requested inspection page if it was not already read. Each UI page requests 25 records. There is no polling, exhaustive scan, unrestricted document read, or automatic retry loop.
- Selection, history, and inspection retain their own timestamps and failures. A null selection projection says selected-conversation metadata is unavailable; it does not claim that no persisted selection ID exists. A failed overview block does not remove a successful requested detail. Page counts are not total counts. Historical `running` metadata is not a live execution claim.
- `durable-inspector.test.ts` covers bounded request reuse, missing context, old response compatibility, absent selection, off-page selection, partial errors, and unloaded sessions.
- `durable-inspector.spec.ts` retains all four views, approved JSON, parent/owner links, opaque pagination, manual refresh, deep links, context validation, cancellation, expiry, policy drafts, and keyboard checks. New cases cover off-page selection versus inspection target, history truncation, partial 403/503 failures, independent timestamps, clipboard success/failure, and long names/IDs at 390 and 320 px.
- Backend inspector and lifecycle tests retain GET-only authenticated access, sanitized errors, bound cursors/projections, no new sessions or work, cancellation, ownership leases, reset/disposal coordination, and excluded message/tool payloads.
- Clean, fully applied Durable views hide save chrome. Any pending policy, MCP, provider, or editor input, busy operation, or unapplied/failed revision keeps the existing bar and actions. `usability.spec.ts` tours Durable with clean, provider, MCP, policy, and mixed drafts; separate tests cover unfinished editor input and pending/failed/busy application. Existing leave confirmation remains tested.
- Client reads are sequenced, but aborting HTTP does not prove that the server's storage lease has drained. A rapid same-chat navigation can still receive a structured owner-busy error. It remains a read failure with manual refresh, not a reason to release the lease early or add an unbounded retry loop. This limit preserves the existing lifecycle boundary.

## Verification

Local final checks on Node.js 26.10.0:

| Command | Result |
| --- | --- |
| `npm run format:check` | Passed across all workspaces |
| `npm run lint` | Passed without warnings |
| `npm run typecheck` | Passed across all workspaces, including the screenshot script |
| `npm test` | Passed: 131 test files, 1,736 tests; bot 1,174, admin 73 |
| `npm run build` | Passed across all workspaces |
| `npm run test:browser --workspace @narumitw/sumire-admin` | Passed: 176 Chromium browser tests |
| `node apps/admin/scripts/capture-durable-comparison.ts origin/main apps/admin/test-results/durable-comparison` | Passed; six synthetic before/after screenshots generated |
| `git diff --check` | Passed |

The first full root test run overlapped browser work and had five process-recovery deadline failures in unchanged MCP/codemode tests. The isolated recovery checks passed, then an unmodified `npm test` passed in full without concurrent browser work. No timeout, assertion, or test selection was relaxed. Initial browser failures from changed copy/fixtures were corrected; the final stale-response test verifies actual request cancellation and that a released old handler cannot replace fresh metadata.

## Screenshot evidence

The comparison script archives tracked base frontend sources into a temporary directory. It runs base and current frontend code against the same synthetic API fixture, at 1440, 390, and 320 px with 900 px viewport height. It creates `before-<width>.png` and `after-<width>.png`, closes its own servers/browser, and removes the temporary source copy. It never reads production state or commits images.

Desktop and 320 px comparisons were visually reviewed. The selected chat, persisted conversation, history, timestamps, and short read-only notice precede advanced IDs and raw JSON. Long-ID and no-horizontal-page-overflow assertions pass. A collapsed selector keeps chat switching available without filling the first screen with directory rows.

PR CI runs the full browser suite and regenerates the six comparisons against the PR base. The `admin-browser-evidence` Actions artifact contains `durable-comparison/` and other test output, retained for seven days. Download the artifact from the PR's CI run during review; the script provides a reproducible replacement after artifact expiry.

## Review and release handoff

Review scope: correctness, query validation/SQL binding, source precedence, backwards-compatible array/projection fields, authorization, session ownership/cancellation, stale-result isolation, draft protection, and no unapproved payload expansion. The change does not add a model loop or execution controls.

Production deployment, real Telegram metadata updates, real device/screen-reader verification, and provider acceptance were not performed. Browser keyboard and semantic-role checks do not replace a real screen-reader check. These are handoff limits, not claims of verified live state.

Before rollout, the deployment owner must stop the single storage owner and take an access-controlled backup of the state volume, including `.telegramagent/admin.sqlite`. Use the repository-root Compose workflow. Retain current authorization and check allowed/denied chats after restart. Verify known names and types before and after restart, observe one authorized rename/private-name update, open Durable directly, and confirm selection does not start an unloaded session.

No schema migration is required. Roll back compatible frontend/backend/contracts builds together after reads drain; retain corrected metadata where possible. Older startup code can overwrite names again. Restore a state snapshot only with explicit administrator approval because it can restore revoked grants and outdated credentials/settings. Do not delete the state volume, disable authorization, or query all Telegram chats for recovery. No packages were published, version tags created, release workflows dispatched, or production services changed.
