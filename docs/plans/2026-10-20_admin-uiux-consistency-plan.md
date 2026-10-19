# Administration UI consistency plan

## Goal

Make the administration app readable by structure instead of by explanation.

An administrator must be able to identify the current state, find the primary action, and distinguish a control from a label without reading a paragraph first.
The app currently carries 152 explanatory paragraphs and 29 disclosure blocks across eight sections, four competing container idioms, three link idioms, and a save bar that places two contradictory status badges beside its primary action.

This is a presentation pass.
No documented behavior, save boundary, API, or permission rule changes.

## Context

- A browser review on 2026-10-20 rendered every section against the existing Playwright fixtures at 1440 and 390 pixels and recorded the findings in the table below.
- The current prose density is deliberate.
  `docs/admin-usability-validation.md` records an earlier pass that added explicit labels, counts, and disclosures to satisfy the save-state contract and the trust boundary.
  Those statements must remain reachable.
  Only their duplication and placement change.
- `docs/admin-webui.md` is the behavioral contract for the save bar, access tables, audit filters, tool permissions, model providers, and MCP configuration.
  Sections that describe visual structure need updating; sections that describe behavior do not.
- `apps/admin/tests/usability.spec.ts` already enforces contrast, focus visibility, 44-pixel targets, and reflow at 1440, 390, and 320 pixels with CSS zoom.
  The accessibility floor is covered.
  The gaps in this plan are hierarchy and consistency, not compliance.
- `apps/admin/src/main.tsx` is 1,813 lines and holds the shell, the save bar, and five section editors.
  Splitting it is in scope only where this work already touches a region, per the 1,000-line rule in the user's global instructions.

## Findings

| # | Finding | Source | Severity |
| --- | --- | --- | --- |
| 1 | Save bar renders up to ten children in one wrapped row, with a green applied badge beside an orange pending badge and the primary action last | `main.tsx:978–1134` | High |
| 2 | Four container idioms compete: Radix `Card`, bare `fieldset`/`legend`, `.permission-group`, unstyled `section` | `styles.css`, all sections | High |
| 3 | Three link idioms; `main` has no `a` rule, so Durable renders default user-agent blue beside teal ghost buttons | `styles.css:46`, `durable-inspector.tsx` | High |
| 4 | Native `select` and `input[type=date]` sit beside Radix `TextField` and `Select` | `chats.tsx:207`, `mcp-editor.tsx`, `audit.tsx` | High |
| 5 | MCP connections has no step structure, 2,054 pixels at desktop and 2,685 at 390, and an ambiguous "Edit enabled" / "Enabled" checkbox pair | `main.tsx:1400–1600`, `mcp-editor.tsx` | High |
| 6 | The save-boundary rule is restated in at least seven places | `main.tsx:950`, `main.tsx:1056`, `main.tsx:1414`, `chats.tsx:622`, `chats.tsx:672`, `providers.tsx`, `tool-permissions.tsx` | High |
| 7 | `Heading size="3"` without top margin renders at body-bold weight and collides with the paragraph above | `audit.tsx`, `main.tsx:1413`, `activity.tsx` | Medium |
| 8 | Paragraphs run the full container width, roughly 160 characters per line at 1440; only `.durable-inspection-context p` has a measure | `styles.css:786` | Medium |
| 9 | `IdList` prints its two helper paragraphs once per instance, so Access shows them twice verbatim | `main.tsx:134` | Medium |
| 10 | Plural agreement fails at four sites | `main.tsx:1007`, `main.tsx:1025`, `main.tsx:1210`, `tool-permissions.tsx:8` | Medium |
| 11 | No dark mode: `Theme` sets no `appearance`, no `prefers-color-scheme` block, light scales only | `main.tsx:1806`, `styles.css:1` | Medium |
| 12 | Chat detail heading does not clamp, so a long group name pushes the header to four lines | `chats.tsx:347` vs `styles.css:471` | Medium |
| 13 | "Pending policy change" badge is the fifth child of a four-column grid and inflates to a full-width bar | `tool-permissions.tsx:395` | Low |
| 14 | Defaults prints saved and draft model lines even when identical; the tool-permission equivalent guards on `dirty` | `main.tsx:1341–1352` | Low |
| 15 | Hardcoded "Model Providers" contradicts `pageLabel()`'s "Model providers" | `main.tsx:1322`, `main.tsx:412` | Low |
| 16 | Durable prints the same read time three times on one screen | `durable-inspector.tsx` | Low |
| 17 | Audit filter grid orphans "Through date" on its own row | `audit.tsx` | Low |
| 18 | No error boundary: a malformed `time` throws in `AuditRecord` and blanks the whole app, including the chat History tab | `activity.tsx:112` | Low |

## Architecture

Keep the work in the admin presentation layer.
Do not change the backend, the contracts package, the policy package, or any API route.

Introduce one surface primitive and one prose primitive in `apps/admin/src/surfaces.tsx`, then migrate call sites to them.
Keep Radix Themes as the component library and the teal accent as the single accent.
Replace native form controls with their Radix equivalents rather than restyling the native ones, so focus, sizing, and disabled treatment come from one source.

Each behavioral rule gets exactly one canonical location.
The save-boundary rule belongs in the save bar.
Scope-specific consequences stay next to their action only when the consequence is specific to that action and is not a restatement of the general rule.

Derive repeated status text from one helper rather than from per-site string literals, so plural agreement and naming are fixed once.

## Non-goals

- No new sections, routes, deep-link parameters, or API fields.
- No change to the save-state contract, the trust boundary, permission inheritance, or the bounded read sequence.
- No removal of a safety statement; deduplication relocates statements and must keep each one reachable.
- No component-library replacement, CSS framework, design-token package, or build-tooling change.
- No redesign of the Durable record model, the chat directory data flow, or the audit query model.
- No visual change to the sign-in and passkey registration views beyond what the shared primitives apply automatically.

## Open decision

Finding 11 needs a decision before Phase 1 closes.
Option A supports dark mode: add `appearance` handling, import the dark scales, and extend the contrast test to both themes.
Option B declares the app light-only: set `appearance="light"` explicitly on `Theme` so a dark-mode operating system cannot produce a half-themed page, and record the decision in `docs/admin-webui.md`.
Option B is the smaller change and is the recommendation unless dark mode is wanted now.
Proceed with Option B if no decision arrives before Phase 1 implementation, and state the assumption in the pull request.

## Plan

### Phase 1 — Shared primitives

- [x] Add `apps/admin/src/surfaces.tsx` with a `Panel` surface primitive and a `Prose` paragraph primitive, plus the supporting rules in `styles.css`.
      `Panel` replaces the Radix `Card`, bare `fieldset`, and unstyled `section` containers with one border, radius, padding, and heading rhythm, and keeps `fieldset` semantics where a group of controls needs them.
      `Prose` applies `max-width: 72ch`.
      Acceptance: one surface treatment renders across all eight sections; no `legend` notch remains; paragraph measure is at most 72 characters at 1440 pixels; existing accessible names and `aria-label` values are unchanged.
- [x] Establish link and button affordance rules in `styles.css`.
      Give `main a` an explicit teal treatment, and give `variant="ghost"` buttons that navigate a shared class so they read as controls rather than colored text.
      Give destructive ghost actions a visible boundary.
      Acceptance: no default user-agent blue link remains in `main`; Durable inline links, `href="#save-status"` links, and sidebar links share one treatment; "Revoke access", "Delete <server>", "Remove credential", and "Remove configuration" each have a visible control boundary.
- [x] Apply a heading rhythm so section headings separate from the paragraph above.
      Acceptance: "Import reports", "Configuration activity", and "MCP connections — saved separately" read as headings at 1440 and 390 pixels; heading sizes step consistently within a section.
- [x] Resolve the dark-mode decision recorded above and implement the chosen option.
      Acceptance: a dark-mode operating system produces either a complete dark theme or a complete light theme, never a mixed one; the decision is recorded in `docs/admin-webui.md`.

### Phase 2 — Save bar

- [x] Restructure the save bar in `main.tsx` into a status line, a scope row, and a right-aligned primary action.
      Show one status, not an applied badge beside a pending badge.
      Give **Apply policy changes** visual priority over the scope links.
      Acceptance: the bar never shows two contradictory state badges at once; the primary action is visually dominant; at 390 pixels the bar occupies no more than one quarter of the viewport height before content starts.
- [x] Preserve every save-state behavior that `docs/admin-webui.md` documents and `usability.spec.ts` asserts.
      Acceptance: clean, dirty, unstaged-input, saving, pending-application, failed-application, revision-conflict, and expired-session states each render their documented result; the bar still does not take focus on state change; the measured `--save-status-height` offset still drives workspace scroll padding; the bounded narrow-width scroll area remains.
- [x] Reduce the chrome above the first content on mobile.
      Fold "How saving works" into the save bar's existing disclosure set rather than stacking it above, and hide it on sections with no save action.
      Acceptance: at 390 pixels the first section content appears within 250 pixels of the viewport top on Chats; Durable with a clean applied revision shows no save chrome, as documented today.

### Phase 3 — Copy consolidation

- [x] Give each repeated rule one canonical location and delete the restatements.
      The general save-boundary rule lives in the save bar.
      Scope-specific consequences stay beside their action only where the consequence is specific to that action.
      Acceptance: the save-boundary rule appears once; each deleted sentence is either redundant with the canonical statement or relocated; `docs/admin-webui.md` still describes every rule.
- [x] Lift the shared `IdList` helper paragraphs to the Access section so they appear once rather than once per list.
      Acceptance: Access shows each helper sentence once; both lists keep their distinct labels, counts, and accessible names.
- [x] Derive repeated status strings from one helper so plural agreement and page naming are fixed at the source.
      Acceptance: findings 10 and 15 are resolved; no count string in the app disagrees with its number; no hardcoded page name contradicts `pageLabel()`.
- [x] Remove redundant repetition inside sections: the always-dual saved and draft lines on Defaults, and the thrice-printed read time on Durable.
      Acceptance: Defaults shows a draft line only when the draft differs from saved, matching the existing tool-permission behavior; Durable prints each block's read time once per block.

### Phase 4 — Control consistency

- [x] Replace the native `select` elements in `chats.tsx` and `mcp-editor.tsx` with the section-aware `SectionSelect` from `sections.tsx`.
      Acceptance: no native `select` remains in the app; the chat type and access filters, the MCP transport and exposure selects, and the secret field map select share one treatment; `SectionSelect`'s existing close-on-inactive-section behavior applies to the migrated controls.
- [x] Replace the native date inputs in `audit.tsx` with Radix `TextField` inputs that keep the existing `type="date"` semantics, or wrap them so they match the surrounding field treatment.
      Acceptance: audit filter fields share one visual treatment; the documented inclusive UTC bounds, validation, and rejection behavior are unchanged.
- [x] Fix the audit filter grid so the five filters balance across rows and the date pair stays together.
      Acceptance: no filter is orphaned on its own row at 1440 pixels; the layout reflows to a single column at 390 pixels without horizontal overflow.

### Phase 5 — MCP connections

- [x] Give MCP connections the numbered step structure that Model providers already uses.
      Separate choosing or creating a server from editing its fields, and put the server-name field inside the step that owns it.
      Acceptance: the page states which step creates a server and which edits one; the server-name field is no longer ambiguous about its effect; desktop scroll length drops measurably from the 2,054-pixel baseline.
- [x] Restructure the saved-connection summary so name, state, counts, and actions are visually distinct rather than six lines of equal-weight text.
      Acceptance: the server name reads as the primary identifier; connection state, discovered-tool count, and permission summary are distinguishable at a glance; the destructive delete action has a visible boundary.
- [x] Resolve the ambiguous checkbox pairs in the guided editor.
      "Edit enabled" followed by "Enabled" must make clear that the first selects the field for replacement and the second sets its value.
      Acceptance: each field-selection control is visually and textually distinct from the value control it governs; the documented patch semantics, including omitted-field preservation and transport cleanup, are unchanged; the redacted field-operation preview still lists the same operations.

### Phase 6 — Remaining defects

- [x] Clamp the chat detail heading to match the directory list clamp.
      Acceptance: a long group name occupies at most two lines at 1440 and 390 pixels; the full name remains available to assistive technology and on hover.
- [x] Fix the stretched "Pending policy change" badge in the permission matrix.
      Acceptance: the badge renders as a chip, not a full-width bar, at 1440 and 390 pixels; the four-column matrix and its mobile single-column reflow are unchanged.
- [x] Add an error boundary around the section editors so one malformed record cannot blank the app.
      Acceptance: a record with an invalid or absent `time` renders a contained error in its own section; the shell, navigation, save bar, and other sections keep working; the chat History tab degrades independently of the Audit section.

### Phase 7 — Verification and delivery

- [x] Extend `apps/admin/src/*.test.ts` for the new helpers.
      Acceptance: the status-string helper covers singular, plural, and zero counts; the error boundary has a unit test for a malformed audit record.
- [x] Extend the browser suites for the restructured save bar, MCP steps, and control migration.
      Acceptance: every existing assertion in `admin.spec.ts`, `usability.spec.ts`, `tool-permissions.spec.ts`, `access.spec.ts`, `chat-workspace.spec.ts`, and `durable-inspector.spec.ts` either still passes or is deliberately updated with the reason recorded; no save-state, security, cancellation, expiry, pagination, or draft-retention assertion is weakened.
- [x] Capture before and after screenshots of all eight sections at 1440, 390, and 320 pixels against the existing fixtures.
      Acceptance: no horizontal page overflow at any width; screenshots stay outside Git.
- [x] Update `docs/admin-webui.md` and add a patch changeset for `@narumitw/sumire-admin`.
      Acceptance: the save-status, tool-permissions, MCP, and audit sections describe the implemented structure; behavioral statements are unchanged except where the plan deliberately changed them; the changeset describes the consistency outcome.

## Verification evidence

Implementation and automated verification are complete. User visual acceptance remains open. The supplied plan was copied into this branch for tracking; its original path in the separate checkout was not changed.

- Node.js: `v26.10.0`; base: `e5757b3aec80eea53afe8117bae2d287c5497244` (`origin/main`).
- Branch: `narumi/refactor/admin-ui-consistency`.
- Option B implemented: explicit light appearance. A dark operating-system preference is covered by a browser test.
- `npm test --workspace @narumitw/sumire-admin`: 168 tests passed.
- `npm run test:browser --workspace @narumitw/sumire-admin -- --reporter=json`: 233 tests passed; zero failures, skips, or flaky tests.
- All root checks passed: `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`. Root test commands reported 1,838 passing tests.
- Final logs: `/tmp/sumire-ui-root-*.log`, `/tmp/sumire-ui-unit.log`, and `/tmp/sumire-ui-browser-json.log`.
- Contrast: normal 16.39:1; muted 5.94:1; disabled 5.22:1; warning 14.51:1; pending 14.04:1; error 4.59:1; selector boundary 3.30:1; checkbox boundary 3.22:1. Each measured text state exceeds 4.5:1 and each tested control boundary exceeds 3:1.
- Screenshots: `/tmp/sumire-admin-consistency-rapid-forest/index.html`, with 24 BEFORE and 24 AFTER PNGs under `before/` and `after/`. No screenshot is staged. AFTER captured the verified implementation before the pre-commit hook sorted imports in five files. That import-only change does not change the rendered layout.
- MCP heights (BEFORE → AFTER): 1440px, 2054 → 2036; 390px, 2685 → 2589; 320px, 2881 → 2929. The required desktop reduction passes. The 320px increase is recorded for user review; there is no horizontal overflow.
- Chats first content at 390px and 320px: 246.59px. Mobile save bar: 102.59px clean, 174.89–225px dirty, and 225px with disclosures expanded. Clean Durable has no save bar.
- No horizontal overflow in any of the eight sections at 1440, 390, or 320px. Existing CSS-zoom, focus, expiry, cancellation, conflict, pagination, permission, and draft-retention assertions pass.
- Existing test assertions changed only for singular agreement, Radix option selection instead of native `selectOption`, and opening the new `Replace secrets` disclosure. No behavioral assertion was removed or weakened.
- Early verification found excess MCP height, mobile spacing, a missing measurable selector border, and test locator conflicts. These were corrected before the final passing run. The final MCP layout keeps secret inputs reachable in a disclosure and retains their input when closed.
- Full diff reviewed for correctness, security, lifecycle, compatibility, regressions, and scope. Save-bar measurement now follows bar mount/unmount and cleans up its observer. MCP secrets clear when session expiry unmounts its editor; existing expiry tests pass. No backend, contracts, policy, API, dependency, or stored-data change is included.
- Browser fixtures do not prove live provider acceptance, real-device Passkeys, screen-reader output, or production deployment. Those paths are not changed by this presentation pass.

### Findings disposition

| Findings | Evidence |
| --- | --- |
| 1, 6 | Single-status save bar, scope row, primary action, canonical save explanation; save-state browser suite passes. |
| 2, 7, 8, 9 | Shared Panel/Prose, no legend notch, heading rhythm, 72ch measure, one Access helper set. |
| 3, 4 | Teal links, bounded ghost controls, Radix selectors/date fields; inactive-selector and contrast tests pass. |
| 5 | Three MCP steps, owned server-name field, compact state/count/action summary, explicit replacement labels, redacted preview tests. |
| 10, 15 | Shared singular/plural helper and canonical provider page label; count unit tests pass. |
| 11 | Explicit light-only theme, documented and browser-tested. |
| 12, 13 | Two-line named chat heading and content-sized pending chip; narrow-layout tests pass. |
| 14, 16, 17 | Conditional Defaults model draft, one read time per distinct Durable block, balanced audit filter rows. |
| 18 | Section boundaries plus independent Chat History boundary; malformed/absent-time unit/browser tests and corrected-record retry pass. |

### Remaining acceptance

User review must confirm the save bar, panel treatment, and MCP steps against the local side-by-side screenshots. This cannot be established by automated tests. Keep this plan until that review is recorded; do not mark its review or deletion criteria complete.

- Node.js version, base commit, and branch name.
- `npm test --workspace @narumitw/sumire-admin`.
- `npm run test:browser --workspace @narumitw/sumire-admin`.
- Root checks: `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`.
- Screenshot paths and measured desktop scroll lengths before and after, for MCP connections in particular.
- Contrast measurements from `usability.spec.ts`, including both themes if Option A is chosen.

## Completion checklist

- [x] Every finding in the table above is resolved or deliberately deferred with a recorded reason.
- [ ] User review confirms the restructured save bar, container treatment, and MCP steps are clearer than the baseline screenshots.
- [x] No documented behavior changed without a matching update in `docs/admin-webui.md`.
- [x] No safety or trust-boundary statement was deleted; each one remains reachable in exactly one canonical place.
- [x] Focused checks run and recorded; unavailable checks left open.
- [x] Root checks run and recorded; failed or unavailable checks left open.
- [x] Final diff reviewed; no secrets, chat data, generated output, or screenshot binaries staged.
- [ ] After every task and completion check passes, delete this plan and report its path with the implementation handoff.

## Rollback and recovery

Revert the admin presentation changes and rebuild the admin assets.
No database rollback, session reset, or policy migration is required, because no stored data, API route, or deep-link parameter changes.
Keep `surfaces.tsx` additive until its call sites are migrated, so each phase can be reverted independently.
