# Administration visual design plan

## Goal

Raise the visual quality of the administration app from functional to considered.

The app is currently flat and undesigned in a measurable way: zero transitions, zero shadows, zero custom typography, seven icons in total, and status conveyed almost entirely by sentences of prose.
It renders correctly and passes its contrast and reflow tests, but nothing in the visual treatment helps an administrator read state at a glance.

The central opportunity is that the app already owns a design system it does not use.
Radix Themes 3.3 is installed and 22 of its components are referenced nowhere in the codebase, including `DataList`, `Table`, `Link`, `Spinner`, `Skeleton`, `SegmentedControl`, `Separator`, `IconButton`, and `Tooltip`.
Meanwhile 16 hand-rolled `table`, `dl`, `ul`, and `ol` structures are supported by roughly 340 lines of bespoke CSS.
Most of this work is adoption and deletion, not invention.

## Relationship to the consistency plan

This plan is the second of two and depends on the first.

`docs/plans/2026-10-20_admin-uiux-consistency-plan.md` fixes structural correctness: one surface primitive, one link treatment, heading rhythm, prose measure, the save bar, control consistency, and 18 recorded defects.
That plan answers "is it coherent".
This plan answers "is it attractive and readable at a glance".

Phase 1 of the consistency plan introduces `apps/admin/src/surfaces.tsx`.
Start this plan after that file exists, and extend it rather than creating a parallel styling layer.
Where the two plans touch the same rule, the consistency plan owns the decision and this plan owns the refinement.

## Context

- `apps/admin/src/styles.css` is 943 lines with zero `transition`, zero `animation`, and zero `box-shadow` declarations.
  Every state change is instantaneous and every surface is a one-pixel border.
- `apps/admin/index.html` is a single minified line with no favicon, no description, and no `theme-color`.
  The document title is the constant `Sumire` and never reflects the active section.
- `main.tsx:1810` configures `Theme` with `accentColor="teal" grayColor="slate" radius="medium"` and nothing else.
  The `scaling`, `panelBackground`, and `appearance` props are unset.
- Only seven icons appear in the whole app: `Gear`, `HamburgerMenu`, `Exit`, `Reload`, `MagnifyingGlass`, `CheckCircled`, and `MinusCircled`.
  Approval, pending, failed, inherited, and unknown states are distinguished by words alone.
- Loading states are bare sentences such as `Loading administrator session…`, `Loading settings…`, and `Loading Durable…`.
  Empty states are single sentences such as `No import history.` and `No audit records on this page.`
- `apps/admin/tests/usability.spec.ts` measures normal, muted, disabled, pending, error, and control-boundary contrast.
  Every color change in this plan must keep those measurements passing.

## Architecture

Work inside Radix Themes rather than beside it.

Prefer a Radix component over bespoke markup plus CSS wherever one exists.
Prefer a Radix token over a literal value.
Delete the bespoke CSS that a migrated component makes redundant, and treat the net line count of `styles.css` as a success signal.

Keep the app self-hosted and offline-capable.
No runtime asset may be fetched from a third-party host.

Encode status in a small semantic set used identically everywhere, instead of per-site color choices.
Color is never the only carrier of meaning; it reinforces a label or an icon that already says it.

## Non-goals

- No change to behavior, save boundaries, permissions, API routes, or deep-link parameters.
- No new runtime dependency, CSS framework, animation library, or icon library beyond the installed `@radix-ui/react-icons`.
- No externally hosted font, script, or image.
- No brand identity work, logo design, illustration, or marketing surface.
- No dark-mode decision; that belongs to the consistency plan's open decision and this plan inherits whatever it chooses.
- No redesign of information architecture, navigation structure, or section membership.

## Open decisions

Three choices should be made before Phase 2 begins.
Each has a recommendation so the work is not blocked.

**Typeface.**
Option A keeps the Radix system font stack and invests the effort in scale, rhythm, and numerics instead.
Option B self-hosts a variable font such as Inter and ships it from the app's own assets.
Recommendation is A: a self-hosted administration tool benefits more from predictable rendering and zero font-loading cost than from a distinctive typeface, and the current visual weakness is spacing and hierarchy rather than letterforms.

**Density.**
Option A sets `Theme scaling="95%"` to tighten the dense configuration screens.
Option B keeps `100%`.
Recommendation is A, verified against the existing 44-pixel touch-target assertions, because the permission matrix and audit list are the screens an administrator spends the most time scanning.

**Surface style.**
Option A keeps bordered panels and adds elevation only to genuinely floating layers such as popovers and the sticky save bar.
Option B moves panels to a soft shadow treatment with `panelBackground="translucent"`.
Recommendation is A: borders read better in a dense form-heavy tool, and reserving shadow for floating layers makes the sticky save bar legible as an overlay.

## Plan

### Phase 1 — Adopt the installed component system

- [x] Replace the hand-rolled definition lists with `DataList` in `chats.tsx`, `durable-inspector.tsx`, and `providers.tsx`.
      Acceptance: `.effective-settings`, `.overview-settings`, `.durable-metadata`, and `.durable-usage` bespoke CSS is deleted or reduced to layout-only overrides; label and value pairs align consistently across all three files; the single-column reflow at 650 pixels still applies.
- [x] Replace the hand-rolled access tables with `Table` in `main.tsx`.
      Acceptance: `.access-table` CSS is deleted; column widths size to content rather than to `table-layout: fixed` thirds; the documented matching, draft, saved, and revocation counts and accessible names are unchanged.
- [x] Replace raw anchors with `Link`, and give icon-only or repeated-label controls `IconButton` with `Tooltip`.
      Acceptance: no unstyled anchor remains; repeated row actions such as "Revoke access" and "Edit fields for <server>" no longer repeat their full label in every row while keeping an accessible name.
- [x] Replace the two-option and three-option native filters with `SegmentedControl`, and use `Separator` for the rules currently drawn with one-pixel borders.
      Acceptance: the chat type and access filters read as controls at a glance; ad-hoc `border-bottom` separators are replaced by a consistent rule; no native `select` remains, coordinating with Phase 4 of the consistency plan.

### Phase 2 — Typography, density, and numerics

- [x] Implement the chosen typeface and density decisions and apply a deliberate type scale.
      Acceptance: heading sizes step consistently within and across sections; body, secondary, and caption text use three defined sizes rather than ad-hoc `size="1"` and `size="2"` choices; the 44-pixel target and contrast assertions still pass.
- [x] Apply tabular numerals and a monospace treatment to identifiers, counts, revisions, and token totals.
      Acceptance: chat IDs, revision numbers, record counts, and Durable usage figures align vertically in lists and tables; identifiers are visually distinct from prose.
- [x] Establish a vertical rhythm so spacing between a heading, its description, and its controls is consistent everywhere.
      Acceptance: the spacing between a section heading and its first control is identical across all eight sections; no two adjacent panels use different outer margins.

### Phase 3 — Status color and semantics

- [x] Define a semantic status set covering approved, pending, failed, inherited, overridden, disabled, and unknown, and express it as tokens.
      Acceptance: the set is documented in `docs/admin-webui.md`; each status has a defined color, icon, and label; no section invents a one-off color.
- [x] Apply the set consistently to badges, list rows, panel accents, and the save bar.
      Acceptance: approval state in the chat directory, the access tables, the permission matrix, and the chat detail header all use the same visual language; failed audit records, failed applications, and failed connection tests are visually identical in kind.
- [x] Discipline accent usage so teal signals the primary action and the current location, not decoration.
      Acceptance: at most one teal solid action is visible per view; secondary and tertiary actions use neutral treatments; the current navigation item remains the only teal-filled navigation element.
- [x] Verify every color change against the existing contrast measurements.
      Acceptance: `usability.spec.ts` passes without relaxing a threshold; color never carries meaning alone, and each status remains identifiable in grayscale.

### Phase 4 — Shell, shape, and document chrome

- [x] Refine the sidebar: brand treatment, navigation item states, and the account block.
      Acceptance: hover, focus, and current states are visually distinct from each other; the account block reads as secondary; the mobile collapsed state matches the desktop language.
- [x] Refine the workspace header and the sticky save bar as the app's two persistent surfaces.
      Acceptance: the header reads as chrome rather than content; the save bar is legible as a floating layer over scrolled content, using the surface decision from the open decisions section.
- [x] Apply a consistent radius and elevation scale.
      Acceptance: panels, inputs, buttons, badges, and popovers use a defined radius step rather than mixed four, six, and eight pixel values; elevation appears only on floating layers.
- [x] Complete the document chrome in `index.html` and the shell.
      Acceptance: a self-hosted favicon exists; a description and `theme-color` are set; the document title reflects the active section, for example `Tool permissions · Sumire`; `index.html` is formatted readably rather than minified to one line.

### Phase 5 — Iconography

- [x] Introduce a restrained icon set from the installed `@radix-ui/react-icons` for navigation and the Phase 3 status set.
      Acceptance: each of the eight navigation items has an icon; each semantic status has one icon used everywhere it appears; no icon is introduced without a defined meaning.
- [x] Apply the accessibility rule for every icon.
      Acceptance: a decorative icon beside text is `aria-hidden`; an icon-only control has an accessible name and a tooltip; no information is available only through an icon.

### Phase 6 — Motion and feedback

- [x] Add restrained transitions to hover, focus, selection, disclosure, and panel state changes.
      Acceptance: transitions are short and applied only to color, background, border, and opacity; no layout-shifting animation is introduced; focus rings appear instantly rather than fading.
- [x] Honor `prefers-reduced-motion`.
      Acceptance: with the preference set, all non-essential transitions are disabled and every state remains distinguishable.
- [x] Use `Spinner` for busy actions and `Skeleton` for initial loads, replacing the bare loading sentences.
      Acceptance: `Loading administrator session…`, `Loading settings…`, `Loading Durable…`, `Loading audit records…`, and `Loading chat name…` are replaced by components that preserve their existing `role="status"` announcements; the busy state on `main` still disables configuration controls as documented.
- [x] Give transient confirmations a visible treatment.
      Acceptance: the copy-chat-ID confirmation and similar transient messages are visually distinct from permanent body text and do not shift layout when they appear.

### Phase 7 — Empty and error states

- [x] Give empty states structure rather than a single sentence.
      Acceptance: the no-MCP-connections, no-audit-records, no-import-history, no-matching-access-entries, no-approved-options, and no-chat-selected states each have a consistent treatment with a clear next action where one exists; the existing "Select a chat" panel is the reference pattern.
- [x] Give error and partial-failure states a consistent visual treatment.
      Acceptance: request errors, validation errors, partial Durable read failures, and the contained section error from the consistency plan's error boundary share one visual language; `role="alert"` usage is unchanged.

### Phase 8 — Verification and delivery

- [x] Capture before and after screenshots of all eight sections at 1440, 390, and 320 pixels against the existing fixtures.
      Acceptance: no horizontal page overflow at any width; screenshots stay outside Git; the before set is captured from the post-consistency-plan baseline so this plan's contribution is isolated.
- [x] Record the `styles.css` line count before and after.
      Acceptance: the net change is reported; a reduction is expected from Phase 1 and is the success signal for component adoption.
- [x] Extend the browser suites where the visual structure changed.
      Acceptance: every existing assertion either passes or is deliberately updated with a recorded reason; no accessibility, save-state, security, cancellation, expiry, pagination, or draft-retention assertion is weakened; reduced-motion behavior has a test.
- [x] Update `docs/admin-webui.md` and add a patch changeset for `@narumitw/sumire-admin`.
      Acceptance: the status semantic set and any changed visual contract are documented; the changeset describes the visual outcome.

## Verification evidence

Implementation and automated verification are complete. User screenshot review remains open; do not delete this plan yet.

- Decisions: system font stack; 95% density with 44-pixel button/selector targets; solid bordered panels with elevation only on floating layers. Explicit light mode is inherited from the consistency baseline.
- Runtime: Node.js v26.10.0. Base: `b3fdbc1`. Branch: `narumi/feat/admin-visual-refinement`.
- Focused unit tests: 198 passed. Browser suite: 243 passed.
- Root format:check, lint, typecheck, test, and build: passed. Root tests: 1,868 passed.
- Contrast thresholds remain unchanged. Text ratios before → after: normal 16.39 → 16.39; muted 5.94 → 5.94; disabled 5.22 → 5.22; warning 14.51 → 14.51; pending 14.04 → 13.79; error 4.59 → 4.59. Filter boundary: 3.30 → 3.30. Checkbox boundary: 3.22 → 3.22.
- styles.css: 1,153 → 1,147 lines (−6). Adopted DataList, Table, Link, IconButton, Tooltip, SegmentedControl, Separator, Spinner, and Skeleton.
- Tables are extracted into policy-editors.tsx, not main.tsx. providers.tsx contained no definition list; its raw link was migrated.
- Before and after screenshots: all eight sections at 1440, 390, and 320 pixels, outside Git under `/tmp/sumire-admin-visual-design/{before,after}/visual-design-visual-evidence-at-<width>px/<section>.png`.
- Full command evidence, screenshot names, assertion-update reasons, production asset verification, and review limits: [Administration visual verification](../admin-visual-validation.md).
- Static review found and fixed the production favicon path, ambiguous MCP failure mapping, and desktop save-control target size. Layout, overflow, scroll retention, and chunk-size failures from initial integration runs were fixed without relaxing acceptance thresholds.
- No stored state, API route, query parameter, permission rule, or save boundary changed. No third-party runtime asset or runtime dependency was added.

## Completion checklist

- [x] The three open decisions are resolved and recorded.
- [x] No hand-rolled structure remains where an installed Radix component covers the same need.
- [x] Every status in the semantic set renders identically wherever it appears, and remains identifiable in grayscale.
- [x] No behavior, save boundary, permission rule, or API changed.
- [x] No runtime asset is fetched from a third-party host.
- [x] Focused checks run and recorded; unavailable checks left open.
- [x] Root checks run and recorded; failed or unavailable checks left open.
- [ ] User review confirms the after screenshots are a clear improvement over the before set at all three widths.
- [x] Final diff reviewed; no secrets, chat data, generated output, or screenshot binaries staged.
- [ ] After every task and completion check passes, delete this plan and report its path with the implementation handoff.

## Rollback and recovery

Revert the presentation changes and rebuild the admin assets.
No database rollback, session reset, or policy migration is required, because no stored data, API route, or deep-link parameter changes.
Keep each phase in its own commit so a single phase can be reverted without losing the others, and keep Phase 1 component migrations separate from Phase 2 through 6 styling so a regression can be isolated to either adoption or aesthetics.
