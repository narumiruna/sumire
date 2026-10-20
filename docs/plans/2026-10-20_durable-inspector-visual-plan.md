# Admin WebUI visual refinement

## Goal

Apply the approved Durable Inspector visual direction to all eight production Admin pages in the current branch and PR #157. Use Radix Themes, primitives, colors, and icons where their semantics fit. Use flat warm surfaces, compact structure, readable content, and visible keyboard focus. Do not claim a numerical design score or production deployment.

The user explicitly expanded implementation from Durable to the whole Admin WebUI. The static Durable preview is a reference, not the delivered application.

## Context

The Durable iteration already implements a relationship navigator, independent expansion and selection, content-first details, and secondary history, metadata, and JSON disclosures. Its bounded reads, privacy rules, pagination, cancellation, and selection semantics must remain unchanged.

Other pages previously used inconsistent headings, nested panels, unstructured facts, and cold surfaces. The current implementation replaces those presentation patterns without changing their API or save behavior.

## Design rules

- Use the existing Radix Theme with a sand neutral palette and teal accent. Use existing role palettes in Durable. Do not use gradients or decorative nested shadows.
- Use one shared page heading, description, and action layout. Keep the Durable header compact so mobile content remains visible above 410 px.
- Keep every actual `.panel` at an 8 px radius with a solid 1 px border. Preserve native section, fieldset, and legend semantics. Use native sections for flat inner groups.
- Use Radix Button, TextField, Checkbox, Tabs, Popover, Dialog, AlertDialog, Badge, Callout, DataList, Table, Code, layout components, and icons where appropriate. Keep native disclosures and real navigation links. Do not add dependencies solely for appearance.
- Keep body text at 14–16 px and metadata at 12–13 px. Provide 44 px interactive targets and visible focus. Verify normal text contrast of at least 4.5:1.
- Keep complete IDs and accessible names. Long names and values must not cause horizontal page overflow at 1440, 768, 390, or 320 px widths.
- Use synthetic fixtures for screenshots. Do not commit reference screenshots, private URLs, session fragments, credentials, real chat content, or binary review artifacts.

## Plan

- [x] Establish the Durable benchmark in production. Evidence: content-first workspace, role-colored rows, independent expand/select controls, retained mobile navigation, and existing production visual tests.
- [x] Replace the shared shell presentation in `main.tsx`, `navigation.tsx`, `surfaces.tsx`, `sections.tsx`, `save-status.tsx`, and `styles.css`. Evidence: sand Theme, icon links, shared header, mounted sections, unchanged save handlers, and responsive layout contracts.
- [x] Refine Chats in `chats.tsx` and `chat-directory.tsx`. Use a directory beside an inspector, Radix search and selection controls, identity headers, a setup Callout, and semantic effective-setting facts. Preserve directory requests, pagination, scroll measurements, focus, and all four mounted tabs.
- [x] Refine Access, Defaults, and Tool permissions in their production components. Use named Radix tables, approval facts, fieldsets, compact matrices, and Chevron icons. Preserve immediate access-link approval versus staged policy changes, inheritance versus explicit empty lists, retained selections, and expansion preferences.
- [x] Refine MCP connections and its editor. Use saved connections beside the guided editor and review actions. Preserve masked secrets, patch omission/null/map behavior, exact save scope, confirmations, and disabled rules. Focused MCP unit and browser checks pass.
- [x] Refine Model providers and its endpoint editor. Use a current-default summary and separate authentication/check and model/save inspectors. Preserve searchable selectors, local-versus-remote check wording, OAuth cancellation, and distinct credential/model save actions.
- [x] Refine Audit and activity. Make configuration activity primary, keep the five labeled filter inputs and UTC bounds, show structured actor/revision/outcome facts, and put import reports in a secondary section. Preserve query pagination, grouping limits, raw records, and draft retention.
- [x] Add shared synthetic browser fixtures and production all-page visual coverage. Evidence: four viewport tests capture all eight pages, check warm Theme, headings, text contrast, touch targets, panels, read-only browsing, and horizontal overflow. Existing strict all-section geometry tests also pass.
- [x] Complete visual review and migrate presentation assertions without weakening security, lifecycle, geometry, or request-budget checks. Evidence: all-page desktop/mobile captures, unchanged strict directory bounds and scroll stability, and regression checks for mobile MCP title/action layout and provider-popup viewport bounds.
- [x] Update operator documentation and the existing affected-package changeset for all eight production pages. Evidence: `docs/admin-webui.md` and `.changeset/durable-content-tree.md` describe the implemented pages and unchanged save scopes.
- [x] Complete final validation after root checks. Root formatting, lint, typecheck, 1,855 unit tests, build, independent review, and the six-image comparison capture pass. All 269 existing Admin browser cases pass in a clean run, and all four new all-page visual cases pass. Stop builds during live-Vite browser validation: rebuilding workspace dependencies can reload the page and invalidate draft-state tests.
- [x] Commit intended sources and tests on the current branch, update PR #157, and confirm GitHub Actions. Evidence: implementation commit `ffbf001` and successful CI run `39458768485`, including all browser flows and comparison captures.

## Validation evidence

- The prior Durable production iteration passed root formatting, lint, typecheck, 1,855 unit tests, build, and 268 Admin browser tests.
- CI fix `8061c6f` passed GitHub Actions. It retains the strict mobile content-position bound and adds a wider fallback-font regression. The comparison script waits for the intended record without requiring a mobile-hidden duplicate ID to be visible.
- Current all-page checks pass at 1440 × 900, 768 × 1024, 390 × 844, and 320 × 844. Screenshots are local artifacts under `/tmp/sumire-allpages-visual/`.
- The existing bundle-size budget remains unchanged. The build splits Radix into a separate vendor chunk; the budget regression test passes.
- Final all-page root formatting, lint, typecheck, 1,855 unit tests, and build pass. Radix, React, and application JavaScript chunks remain below the unchanged 500,000-byte budget.
- Independent read-only review found an icon-sizing selector affecting MCP text actions. The selector is now scoped to shared shell actions, the mobile MCP subheader stacks without squashing its title, and new geometry assertions pass.
- The root Theme's viewport-height rule is restricted to the root Theme, not portalled Popovers. Directory reveal margins and compact toolbar spacing preserve strict row/footer bounds and last-row selection scroll stability.

## Boundaries

- No backend, storage schema, API contract, authentication protocol, content limit, redaction, or policy-helper changes.
- Preserve mounted editors, browser drafts, inactive-selector closing, SaveStatus measurements, confirmation dialogs, save scopes, and session-expiry cleanup.
- Preserve Durable read-only access, bounded explicit reads, manual refresh, incomplete-data warnings, and the distinction between inspection and persisted conversation selection.
- Do not add polling, automatic discovery, automatic remote model checks, graph dependencies, inferred transcript titles, or exhaustive history reads.
- Keep formatting policy in root `biome.json`. Do not change generated output or local runtime state.

## Completion Checklist

- [x] The user authorizes the full eight-page production implementation in the current branch and PR.
- [x] Review all eight synthetic production pages at desktop and mobile widths. Keep existing populated/empty, long-content, error, keyboard, and cross-page draft tests. Evidence: 32 production captures and retained interaction suites.
- [x] The complete Admin unit and browser suites pass with unchanged security and lifecycle coverage: 177 Admin unit tests and 273 browser tests, including four new all-page visual cases.
- [x] Root `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` pass. All 1,855 unit tests pass.
- [x] `git diff --check`, independent review, documentation, and changeset checks pass; no generated output or sensitive data is included.
- [x] PR #157 contains the intended implementation and its GitHub Actions run passes. Evidence: `ffbf001`, run `39458768485`; the remaining plan edit records this result only.
- [ ] User acceptance of the production visual result remains separate from automated validation. No deployment or live Telegram/provider acceptance is claimed.

## Rollback / Recovery

This visual change has no storage migration. Revert its frontend commit to restore the preceding presentation. Keep the bounded entry-content API and read-only storage ownership unchanged. Do not reset conversations or restore a database backup for a display rollback.
