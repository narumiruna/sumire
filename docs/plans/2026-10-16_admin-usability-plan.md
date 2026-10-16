# Administration usability plan

## Goal

Make access, setup readiness, inheritance, and save behavior clear across all seven administration sections. Deliver a persistent save/status bar and separate readiness indicators first, without changing authorization or silently combining save scopes.

## Context

The supplied review identifies confusing status and save behavior. Chats and Access received visual inspection; other sections were assessed through rendered content and controls. Mobile layout, keyboard use, contrast, and save/error flows remain unverified.

Repository evidence:

- `apps/admin/src/main.tsx` owns the policy draft, pending-change summary, MCP editor, Defaults, and save controls. It already distinguishes policy, unstaged input, MCP, and provider drafts, but the status area follows the editors.
- `apps/admin/src/styles.css` styles `.pending-bar` and `.saved-state` without persistent positioning. `.chat-list` has its own bounded scroll area.
- `apps/admin/src/chats.tsx` already shows setup blockers and explains that authentication configuration is not remote verification. Directory rows still use “Allowed”.
- `apps/admin/src/tool-permissions.tsx` already provides global/default controls, effective inherited permission text, and conflict explanations. Improve this existing editor rather than add a second one.
- `apps/admin/src/providers.tsx` separates credentials from model selection. Provider configuration checks do not establish remote authentication success.
- `apps/admin/src/activity.tsx` provides readable operation names and expandable raw records. `apps/bot/src/admin/server.ts` exposes offset-based audit and chat lists, not general filter queries.
- `docs/admin-webui.md` documents revision application, separate save scopes, inheritance, MCP secret updates, and security boundaries.
- Existing checks include frontend unit tests, `apps/admin/tests/*.spec.ts`, and backend `apps/bot/tests/admin-*.test.ts`.

## Architecture

Keep the current React/Radix frontend and bot-owned administration API. Policy and effective-permission resolution remain deterministic. Do not add another policy store, generic form framework, or automatic save mechanism.

Use separate status dimensions:

| Dimension | Meaning | Evidence |
| --- | --- | --- |
| Approved | Saved access grant; chat enabled state remains separate | Saved policy, with a distinct draft preview when edited |
| Configured | Required local fields and credential references are available | Loaded configuration/inventory, not a successful remote request |
| Verified | A specific supported remote check succeeded | Named check and its result; otherwise show “Not checked” |
| Applied | Runtime application reached the saved revision | Saved/applied revisions and application outcome |

A chat can be approved while setup is required. A saved revision can be unapplied. A configured provider can be unverified. Never use one green badge to imply all three are satisfied.

Save scopes remain explicit:

| Scope | Existing boundary to preserve |
| --- | --- |
| Policy | Shared draft across chat access, defaults, permissions, model availability, and custom provider configuration |
| MCP configuration | Per-connection save, secret-preservation rules, and runtime application |
| Provider credentials | Explicit credential or OAuth operation, separate from model selection |
| Provider model selection | Confirmed model/default save, with existing conflict checks |

The persistent bar summarizes these scopes and links to their controls. It must not offer a misleading combined save transaction. Keep revision details and long change lists expandable.

## Non-Goals

- Change access rules, inheritance, runtime application, cancellation, or credential storage.
- Add live model-generation checks, automatic connection tests, or a claim of full operational readiness.
- Add chat aliases, fetch Telegram names on page load, or introduce a new visual framework.
- Rewrite unrelated plans or change deployment authentication.

## Execution evidence

Implementation and automated validation are complete. `docs/admin-usability-validation.md` records the seven-section baseline inventory, save-state contract, design decisions, test coverage, measured contrast, full-diff review, and remaining external checks. Root formatting, lint, typecheck, tests (1,420), and build pass. Chromium passes 116 tests; local HTTP and offline HTTPS smoke checks pass. No schema migration or live-provider call was added. Changesets cover both affected packages.

User acceptance of the delivered redesign is still open. This is a review handoff, not a request to authorize implementation again. Retain this plan until that final criterion is satisfied.

## Plan

### 1. Confirm behavior and establish acceptance cases

- [x] Reproduce the review findings against the current UI and API fixtures; record which remain present, including accessible names in Defaults and Model providers. Acceptance: a seven-section behavior inventory identifies the source control and current result for each finding.
- [x] Map save scopes and pending states in `main.tsx` and `providers.tsx`; define labels, actions, disabled reasons, conflict handling, and draft retention. Acceptance: a reviewed state table covers clean, dirty, saving, saved/pending application, failed application, revision conflict, expired session, and multiple local drafts.
- [x] Inspect provider check capabilities and audit storage before adding new controls. Acceptance: document which checks can support “Verified”, which fields can support audit summaries, and whether audit filters need an additive API change. Unsupported verification remains “Not checked”; missing historical change details are not inferred.

### 2. First delivery: persistent save status and readiness

- [x] Make the existing save/status area persistent in `main.tsx` and `styles.css`, with compact per-scope status, change counts, explicit scope actions or links, and expandable revision details. Acceptance: browser tests show the bar in all seven sections with policy-only, MCP-only, provider-only, and mixed drafts; scrolling does not hide it or cover focused controls.
- [x] Preserve each save boundary while adding clear progress, success, failure, and disabled-reason text. Acceptance: browser tests prove saving or discarding one scope does not save or discard another, conflicts retain input, and failed application exposes retry without reporting “Applied”.
- [x] Replace ambiguous chat access labels with separate approval, enabled-state, configuration, verification, and application indicators where relevant. Reuse existing setup blocker actions. Acceptance: fixtures cover approved/missing credentials, disabled chat, configured/unverified provider, unknown inventory, draft access changes, and failed application; none reports full readiness from access alone.

### 3. Chats and Access scanning

- [x] Standardize ID-based fallback names in Chats and Access, including linked chats outside the loaded directory. Acceptance: unnamed private chats, groups, and channels have stable distinct names containing their IDs; observed names remain unchanged and numeric IDs remain visible.
- [x] Adjust the chat directory to the available viewport and remove avoidable nested scrolling. Acceptance: desktop and narrow-screen browser tests retain selection, filters, and the existing back-to-directory behavior; keyboard users can reach every row and detail control.
- [x] Compact Access into labeled searchable tables with explicit counts and pending-change links. Acceptance: tests cover grants, revocations, duplicate IDs, no matches, and multiple loaded pages; search scope and counts explicitly distinguish loaded data from server totals and do not imply complete search when only a page is searched.

### 4. Defaults and Tool permissions

- [x] Make Defaults a unified summary of model, thinking, tool, and MCP defaults with saved/draft values and direct links to their existing editors. Acceptance: each category has one authoritative editor, inherited values are distinguishable from explicit empty lists, and the bulk reset control explains every disabled condition.
- [x] Present the existing permission controls as a labeled Tool or server / Global / Default / Effective result matrix, with local blocked-state explanations and expandable policy help. Acceptance: unit and browser tests retain global ceilings, inherited versus explicit selections, stored selections after global removal, save conflicts, and the separate MCP server/tool gates; label effective results as applying to inheriting chats, not all chats.

### 5. MCP and model setup

- [x] Add a guided MCP editor for supported transport fields, retaining advanced JSON for the existing configuration shape. Acceptance: both editors round-trip the same supported configuration without silently dropping fields; invalid or unsupported guided input has a clear recovery path and does not overwrite the advanced draft.
- [x] Add an MCP change preview for added, changed, removed, and preserved fields before save. Acceptance: frontend and backend tests cover omitted fields, null secret preservation, literal replacement, empty-map clearing, stale revisions, and validation errors; previews never reveal existing secrets, and connection tests require explicit action because stdio startup can have side effects.
- [x] Organize Model providers as credentials → check status → model selection → explicit save, without requiring an unsupported remote check. Acceptance: tests distinguish configured, not checked, check failed, saved, and applied; credential refresh retains the model draft and unavailable saved models remain visible without automatic substitution.

### 6. Audit and cross-section consistency

- [x] Add actor, operation type, outcome, and date filters to Audit with bounded server queries if discovery confirms the need. Acceptance: backend tests cover validation, combined filters, date boundaries, stable pagination, and empty results; frontend tests prove filters apply across records rather than only the visible page. Preserve existing unfiltered callers if the API is extended.
- [x] Group related save/application records using structured revision and operation fields, with expandable individual records. Acceptance: tests cover retries, failed applications, unrelated same-revision events, and page boundaries without hiding failures or inventing missing events; summaries use only recorded fields and clearly identify unavailable change details.
- [x] Reduce repeated instructions and standardize visible navigation capitalization, including “Model providers”, while retaining existing deep-link compatibility. Acceptance: all seven sections retain one short task instruction, detailed rules remain available through expandable help, and navigation tests cover existing section/chat links and browser back/forward.

### 7. Validation and handoff

- [x] Add browser coverage for accessible names, keyboard order, focus visibility, status announcements, narrow screens, and zoom. Acceptance: all interactive controls in Defaults and Model providers have non-empty meaningful names; the new status area does not steal focus, trap navigation, or obscure controls at 200% zoom and 320 CSS-pixel width.
- [x] Measure text and control contrast in normal, muted, disabled, pending, and error states. Acceptance: record WCAG 2.2 AA results for affected components: 4.5:1 normal text, 3:1 large text and applicable non-text UI; do not rely on color alone for status.
- [x] Update `docs/admin-webui.md` and add changesets for affected packages. Acceptance: documentation matches save scopes, status meanings, search/filter scope, and verification limits; bump `@narumitw/sumire-admin` and also `@narumitw/sumire` if backend behavior changes. Use an empty changeset for this plan-only delivery if it becomes a separate pull request.

## Risks

- A persistent bar can reduce usable space or cover focused controls. Keep its default content compact and validate scroll/focus behavior on narrow screens and zoom.
- A wizard can imply atomic saving across unrelated stores. Preserve explicit boundaries and show the outcome of each operation separately.
- Guided MCP editing can erase secrets or unsupported fields. Share deterministic validation/update semantics with the advanced path and require a redacted change preview.
- Grouped audit entries can conceal failures or imply unavailable diffs. Retain individual records and do not synthesize historical changes.
- Existing read-only inspection does not prove mutation safety. Use isolated fixtures and temporary state for save/error tests, never production credentials.

## Rollback / Recovery

Prefer frontend-only changes for the first delivery and no database migration. Keep later API changes additive where possible. If a schema change becomes necessary, stop and add a migration-specific backup, compatibility, and restore procedure before implementation.

For deployment, retain the previous image and follow the private backup process in `docs/admin-webui.md`. Revert the frontend or deploy the compatible previous image if the interface fails. Do not restore an old policy snapshot merely to undo a visual change: it can restore revoked access. A display rollback cannot reverse credential updates or external side effects. After rollback, inspect actual saved/applied revisions and access before reopening administration traffic.

## Completion Checklist

- [x] All implementation tasks above have acceptance evidence; unavailable checks remain open with the required external action identified.
- [x] All seven sections pass the saved/draft/application review; mixed-scope saves, conflicts, failures, and session expiry retain their documented behavior.
- [x] Focused frontend/backend tests and `npm run test:browser --workspace @narumitw/sumire-admin` pass with recorded results.
- [x] Root `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` pass after TypeScript changes.
- [x] Mobile, keyboard, zoom, and measured contrast checks have recorded evidence, not just visual approval.
- [x] Documentation, affected-package changesets, and rollback guidance match the delivered scope; unresolved verification capabilities are explicitly labeled rather than implied.
- [ ] Blocked on user review of the delivered pull request: accept the persistent status/readiness delivery and the remaining sections. Delete this saved plan only after that acceptance is recorded and every completion check passes.
