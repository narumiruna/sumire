# Task-centered administration UI

## Goal

Let an administrator identify a chat's known operating state, blocking reason, and next action from the directory and chat header. Reduce save controls and internal terminology without changing authorization, policy resolution, or save boundaries.

Implementation and pull-request delivery were authorized by the user after this plan was drafted. Production deployment and live settings changes remain outside this authorization. Actual user acceptance is still required before this plan can be deleted. Checked tasks are supported by `docs/admin-task-centered-validation.md`, including 272 admin unit tests, 306 browser tests, and all five root checks. The CI font-layout correction and its failing-before/passing-after cases are recorded in the same validation document. The user-acceptance task below is blocked on the administrator's direct review; fixture tests are not a substitute.

## Context

The user selected one chat and inspected Overview and settings. Browser access then failed. Search and complete settings flows were not fully tested, and no settings were saved. Treat the reported friction as design input, not proof that untested flows fail.

Repository inspection on 2026-10-23 found:

| Evidence | Current behavior | Required change |
| --- | --- | --- |
| `apps/admin/src/chats.tsx` | Directory badges show approval, disabled state, and draft context. Detail blockers cover approval, disabled chat, missing effective model, and missing local authentication. | Share one deterministic summary between rows and details. Do not add another independent status calculation. |
| `apps/admin/src/chats.tsx`, `packages/contracts/src/index.ts` | Local provider configuration and unchecked remote execution are separate. Provider inventory has no model-execution verification result. | Keep unknown, missing, and unchecked states distinct. Do not label a locally configured chat as verified or guaranteed usable. |
| `apps/admin/src/save-status.tsx`, `main.tsx` | Most pages show revision details, save help, and three scope buttons even with no edits. Clean Durable already omits this panel. | Use a compact clean state; preserve all pending, failure, and independent-save notices. |
| `packages/policy/src/index.ts`, `policy-editors.tsx` | `effectivePolicy` supplies field sources. Global availability limits defaults and chat selections. `null` and explicit empty selections differ. | Label scope and source beside each field without changing resolution rules. |
| `apps/admin/src/navigation.tsx` | Nine flat destinations use stable section query values and legacy aliases. | Group destinations by task and change display labels without breaking URLs. |
| `apps/admin/src/chat-directory.tsx`, `chats.tsx` | Search is server-side; type/access filters apply to the loaded page. Pages contain up to 100 records with no total count. Search/filter state and mobile return state already exist. | Reduce header/footer height and preserve existing state. Do not imply that page-local filters cover all records. |
| `apps/admin/src/policy-changes.ts` | Pending changes identify scopes but chat changes are generic. | Add useful field and impact summaries from saved and draft policy, not from audit text. |
| `apps/admin/tests/{chat-directory,chat-workspace,usability,consistency,control-consistency}.spec.ts` | Existing tests cover directory state, drafts, save boundaries, status distinctions, keyboard use, and reflow. | Extend these contracts and update affected assertions. Do not replace behavior tests with screenshots. |

## Architecture

- Keep status presentation in the admin workspace. Use `effectivePolicy`, saved policy, provider inventory, and the saved/applied snapshot as inputs.
  - Add one focused status helper with unit tests. Use it in directory rows and chat details.
  - Do not change the policy package, contracts, backend, or database unless discovery proves an essential input is missing. Record and approve any resulting scope change before implementation.
- Keep current state separate from draft preview.
  - The primary summary describes saved configuration and its application status.
  - Show draft effects separately as not yet saved. An approval or authentication draft must not make the current state appear repaired.
- Use the following presentation contract:

| Condition | Required result |
| --- | --- |
| Not approved or explicitly disabled | State the access restriction. Approval and enabled state remain separate facts. |
| Missing effective model or local authentication | Show setup required, a specific reason, and a repair action. |
| Missing provider information or unavailable input | Show status unknown; do not infer readiness or failure. Offer the relevant review or retry action. |
| Application failed or revisions differ | Show failed or pending application. Do not claim that saved settings are active. |
| No known blocker and matching applied revision | Show configured locally; model response not checked. This is not a successful execution claim. |
| Several conditions apply | Choose one primary action in a fixed order: access restriction, application failure/pending, model setup, missing status information. Keep other conditions available in details. |

- Inventory refresh changes the local configuration facts, not the remote verification state. Do not automatically start OAuth, MCP probes, discovery, or model generation.
- Keep policy, MCP, provider selection, and credentials as separate save operations. Navigation and repair links must not save settings.

## Non-Goals

- No new model-execution check, background probe, or billable request.
- No new authorization rules, persistence schema, audit history reconstruction, or Pi model loop.
- No full localization framework or automatic translation of chat names. Use consistent English UI terms and preserve user-provided names.
- No unrelated Durable Inspector redesign, dependency upgrade, or production deployment.

## Plan

### Discovery and acceptance baseline

- [x] Reproduce the reported states with isolated API fixtures, including the approved chat with missing local authentication; record which observations reproduce and distinguish missing authentication from unchecked remote execution. Acceptance: named fixture scenarios and a status/action matrix in `docs/admin-task-centered-validation.md`.
- [x] Record baseline geometry for a fixed 17-chat fixture at 1440×900 and 390×844, and audit all draft/save inputs and repair destinations. Acceptance: visible full-row count, clean save-panel height, and destination/focus expectations recorded in the validation document; no production writes or external probes.
- [x] Run baseline admin unit and browser suites before edits. Acceptance: command results recorded, with existing failures separated from regressions. Use Node.js 26 or newer and the repository's Playwright configuration.

### P0 — Explain current state

- [x] Implement the shared chat-state helper and its priority rules in `apps/admin/src/`. Acceptance: unit cases cover unapproved, disabled, missing/disallowed model, disabled provider, missing authentication, unknown provider, applied/pending/failed revisions, several blockers, and saved-versus-draft differences.
- [x] Render the shared summary in Chats directory rows and above the selected chat tabs. Acceptance: the same chat has matching saved-state labels and reasons in both locations; a configured chat still says model response is unchecked; draft approval does not change its current-state claim.
- [x] Connect each blocking reason to one repair destination and focus the relevant control or heading. Acceptance: browser tests follow access, enabled-switch, model, authentication, and application actions; all preserve chat selection and unrelated drafts and issue no mutation. Directory repair actions must not nest interactive controls.
- [x] Replace the clean save panel with a compact saved/applied line and optional revision details. Acceptance: it appears only when every draft/input scope is clean, no operation is active, and revisions match; policy-only, MCP-only, provider-only, unstaged-input, busy, pending, failed, and mixed states retain their required notices and actions in `usability.spec.ts`.
- [x] Label global availability, shared defaults, and this-chat overrides beside affected controls and summary fields. Acceptance: tests distinguish inherited values, explicit empty lists, selected-but-globally-blocked values, and default resets; editing a chat does not modify defaults or grant access.

### P1 — Improve task flow

- [x] Group side navigation under Chat management, Models and tools, System settings, and Activity. Acceptance: Chats/Chat access, Model providers/Tool permissions/Skills/Tool connections, Shared defaults, and Conversation records/Audit appear in those groups; old section values and aliases, selected chat, modified-click links, and browser back/forward still work. Keep MCP and Durable as secondary technical descriptions.
- [x] Compact the shared directory toolbar and move detailed search rules into a keyboard-accessible disclosure. Acceptance: the fixed 17-chat fixture shows at least six complete rows at 1440×900 with the clean state and help closed; mobile controls remain usable and full-directory search versus page-local filters remains explicit in tests.
- [x] Hide pagination controls only when offset is zero and a completed, successful response contains fewer than 100 records. Acceptance: tests cover 0, 17, 99, 100, and 101 records, an empty later page, loading, and errors; later pages always retain a route back. Refresh remains available. Do not add a total-count API for this change.
- [x] Strengthen the selected-row appearance without reducing directory state retention. Acceptance: tests retain query, type/access filters, page, tab, and scroll when switching chats or returning from details; selected state is visible without color alone and remains keyboard accessible.
- [x] Expand pending-policy review with changed field names and affected scope. Acceptance: unit tests compare saved and draft fields, separate this-chat changes from inheriting-chat effects, distinguish explicit overrides, and avoid secrets and endpoint values; the save confirmation shows these effects and the existing active-work cancellation warning. Do not claim an exact chat count without complete data.
- [x] Move Sign out into the account menu, make Reload secondary, and place Copy chat ID beside the ID. Acceptance: keyboard tests cover menu open/close, focus return, logout cleanup, reload draft retention, and copy feedback; the current repair action has higher visual priority.

### P2 — Apply consistent presentation

- [x] Adjust affected shared styles and Radix component variants to reduce competing panels and reserve strong buttons for current actions. Acceptance: clean status is not styled as a save action; links, buttons, badges, selected rows, and focus indicators follow one documented treatment in the validation record.
- [x] Verify affected surfaces at 1440, 850, 390, and 320 CSS pixels and 200% CSS zoom. Acceptance: Playwright checks no horizontal page overflow or obscured actions, long mixed-language names, keyboard focus, text labels independent of color, text contrast of at least 4.5:1, and control boundaries of at least 3:1.

### Validation and handoff

- [x] Update `docs/admin-webui.md` and `docs/admin-task-centered-validation.md` to describe the delivered state labels, navigation, scope rules, limits, and evidence. Acceptance: documentation matches implemented behavior and clearly separates fixture checks from live provider or device validation.
- [x] Add a release changeset for every package actually changed by implementation, including private packages. Acceptance: at least `@narumitw/sumire-admin` is included; backend, contracts, or policy bumps appear only if those packages change. The planning-only change uses an empty changeset.
- [x] Run admin unit and complete browser suites, then all five required root checks. Acceptance: record results for `npm run test --workspace @narumitw/sumire-admin`, `npm run test:browser --workspace @narumitw/sumire-admin`, `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`; leave unavailable or failed checks open. Run relevant bot tests if implementation affects it.
- [ ] Obtain user acceptance of the revised fixture-backed flow. Acceptance: the user can identify current status, reason, and next action, complete a staged setting/review/cancel flow, and return to the previous search without ambiguity; record the response and unresolved findings. Live settings changes and production checks require separate authorization.

## Risks

- A simple green readiness badge can imply remote success that existing data cannot prove. Disposition: use explicit locally configured/unchecked language and test it.
- Collapsing the save panel can hide non-policy drafts or failed application. Disposition: make every independent scope part of the compact-state condition and test mixed states.
- Shared directory changes also affect Durable. Disposition: run the complete browser suite, including Durable directory, URL, and navigation cases.
- Rows that repeat all blockers can erase density gains. Disposition: show one primary reason in rows and retain complete reasons in details; verify measured row targets.
- No total count exists. Disposition: retain the possible extra empty page at exact 100-record boundaries instead of inventing pagination certainty.

## Rollback / Recovery

The intended implementation changes presentation only and requires no data migration. Revert the UI change or use the previous compatible application image. Do not restore an older policy database to undo a visual change. Keep authentication, secret storage, and save endpoints unchanged. A code revert or reload does not recover unsaved browser drafts; warn the administrator before a separately authorized deployment.

## Completion Checklist

- [x] All discovery and implementation tasks have passing acceptance evidence in the validation record.
- [x] Rows and details use one status calculation; no unchecked state claims verified model execution.
- [x] Repair links, settings scopes, independent saves, stale-result handling, authentication cleanup, and legacy links pass regression tests.
- [x] Required unit, browser, formatting, lint, type, test, and build checks pass; `git diff --check` passes.
- [x] Documentation and changesets match the actual package scope; no generated images, production data, or credentials are included.
- [ ] User acceptance is recorded and every material finding is resolved or explicitly accepted. Production deployment is not part of this plan.
- [ ] Delete this plan only after every task and completion check has evidence; retain the validation document as the handoff record.
