# Durable Inspector visual refinement

## Goal

Improve Admin WebUI visual quality to match the supplied reference. Use Durable as the first visual benchmark: a compact relationship navigator and a content-first detail pane. A user must be able to identify the selected record, read its content, and follow its relationships without moving through repeated panels.

The user expanded the goal to the complete Admin WebUI. Treat this as a staged quality goal, not an arbitrary numerical score. The current iteration fixes the reviewed Durable preview defects; it does not claim completion of the production redesign.

This is a design and implementation plan only. Do not change the UI, commit, update the PR, or deploy until implementation is requested. Present a fixture-based visual preview for approval before completing the redesign.

## Context

The supplied screenshot and current sources show these problems:

| Current problem | Required change |
| --- | --- |
| The tree uses browser bullets, disclosure markers, underlined links, and repeated `Inspect` actions. | Use aligned navigation rows with one disclosure control and one record target. |
| A wide tree contains repeated instructions and long status sentences. | Use short labels, secondary IDs, compact state indicators, and contextual help. |
| The selected tree node has no clear selected treatment. | Mark the inspected record with a persistent row highlight and visible keyboard focus. |
| Selection context and task-history panels push the workspace below the initial viewport. | Use a compact header; move expanded history into a secondary disclosure. |
| The detail pane starts with raw tabs, generic headings, availability prose, and a large metadata grid. | Start with the record title, its location, and its content. |
| Message content is inside nested bordered panels; ordinary text uses a code-block appearance. | Use one detail surface. Render ordinary messages in the body font and reserve monospace for code, arguments, and tool output. |
| A selected record is repeated in a metadata list below the detail pane. | Keep collection browsing in an explicit secondary view; do not duplicate it under a selected record. |

Implementation sources:

- `apps/admin/src/durable-inspector.tsx`: context, history, raw tabs, selected-record layout, and `EntryContent`.
- `apps/admin/src/durable-tree.tsx`: relationship rows, disclosures, collection states, and pagination.
- `apps/admin/src/durable-presentation.ts`: structured record labels and summaries.
- `apps/admin/src/styles.css`: Durable layout, typography, spacing, and surfaces.
- `apps/admin/src/surfaces.tsx`: shared `Panel`; do not change its global appearance for this feature.

## Design quality reference

The user supplied Pi Session Inspector as the quality reference after reviewing the first static preview. The first preview was too plain. Tidier spacing alone does not meet the requested result.

- Use warm, paper-like neutral surfaces, fine separators, and a compact Inspector toolbar instead of a general settings-page composition.
- Make records easy to scan with aligned icons, short type labels, secondary IDs, and compact state indicators.
- Use low-saturation type colors: violet for system records, blue for user records, sage for assistant records, apricot for tool calls, and blue-gray for tool results. Keep a separate selected-row treatment; type color is not success or error status.
- Use monospace for technical labels and code, not for all message text. Keep the planned readable type sizes rather than copying the reference's small labels.
- Refine density, alignment, control sizing, code surfaces, and disclosure details together. A palette change alone is not sufficient.
- Retain the left relationship navigator and content-first detail pane. The reference is a visual standard, not authorization to add its search, minimap, live capture, metrics, or unrelated views.
- Use synthetic content only. Do not store the private reference URL, access fragment, session identifiers, real messages, or reference screenshots in the repository.

## Visual specification

### Workspace

- Keep the existing Admin shell, Radix icons, and typography tokens. The review-only fixture may use provisional local color values to establish the requested warm visual direction. Before production adoption, map the accepted palette to existing Radix tokens and verify contrast; keep the change scoped to Durable.
- At desktop widths of at least 1,100 px, use a 288–336 px navigator and a flexible detail pane, with a 16 px gap.
- At narrower widths, put the full-width navigator in a `Browse records` disclosure above the detail pane. Keep the current record location visible when navigation is closed. After node selection, close navigation and move focus to the detail heading; reopening navigation must retain its expanded branches. Keep the page free of horizontal scrolling.
- Put the workspace directly after a compact chat/context header. At 1440 × 900, its heading and first navigation row must be visible without scrolling when no error banner is present.
- Show the inspected conversation and persisted selection as separate compact labels. Do not use `Active` to imply running work.
- Keep refresh and chat switching in the header. Put history, direct-ID lookup, raw collection tabs, and data-scope help in secondary disclosures.
- Do not introduce nested fixed-height vertical scrollers for the page, detail pane, and message body. Start with normal page scrolling and a desktop sticky navigator bounded by the viewport. Long navigator content may scroll inside that navigator; message blocks must not create another vertical scroll area.

### Relationship navigator

- Replace visible bullets and browser disclosure triangles with aligned chevrons and type icons from the existing icon package.
- Use 36 px minimum row height on desktop, 44 px on touch layouts, and 16 px indentation per level.
- Give each row one primary label, such as `Conversation`, `Model response`, `codemode`, or `User message`. Show the record ID as secondary text.
- Use a full-row selected background and a thin accent marker. Distinguish selection, hover, and keyboard focus. Persisted selection uses a separate labeled badge.
- Put the expand control and record link beside each other. Expanding must not select a record; selecting must not toggle expansion.
- Replace repeated `Inspect conversation/task` links with row selection. Do not repeat completion prose under every expanded task; show a short recorded-outcome badge instead.
- Keep incomplete-data, missing-parent, and cycle explanations available beside the relevant collection or node. Use concise labels with expandable detail, not a paragraph under every normal node.
- Keep `Load more` and retry controls inside their own collections. Counts must say `loaded` and must not imply a complete history.
- Use semantic nested lists and labeled disclosure buttons. Do not add `role="tree"` unless the complete tree keyboard interaction is implemented and tested. Native links must keep modifier-click and browser history behavior.
- Highlight a selected node when it is on loaded pages. Do not scan extra pages or fetch ancestors to make an absent node appear.

### Detail pane

- Use one heading, for example `User message` or `Tool result · codemode`, followed by a small ID/time line and relationship links.
- Put message content or approved document fields immediately below that heading. Move the full metadata grid into `Record details`.
- Remove normal-state sentences such as `Message content is available`. Keep error, withheld, metadata-only, unavailable, and truncated states explicit.
- Remove the nested `Message content` card. Separate multiple messages with spacing and a light divider; show a small role label only when useful.
- Render user, assistant, and system text with the body font and preserved whitespace. Render tool output and argument text in monospace. Do not infer code blocks from text fragments.
- Keep thinking collapsed by default. Show tool identity and result status once at the appropriate message level, not in repeated grids.
- Group technical fields and copyable metadata/content JSON under `Record details` and `Raw data`, collapsed by default. Keep copy feedback and manual-copy fallback.
- Do not parse out transport annotations, hide text by matching phrases, repair truncated arguments, render fetched HTML, or load URLs found in content.

### Surface and state rules

- Use flat surface colors, one outer workspace treatment, and light internal separators. Do not use gradients in record headers. Do not replace nested borders with nested shadows.
- Use body text at the existing 14–16 px tokens and secondary labels at 12–13 px. Do not reduce the main font size to fit more records.
- Use low-saturation type colors for record surfaces, a separate accent marker and outline for selection, and semantic labels for recorded errors or warnings. Always include text and icons; color alone must not convey type or state.
- Show loading and read errors within the affected pane or collection. A read failure must not look like an empty record.
- Keep long names, deep nesting, multiline text, and large output within the pane width. Any label abbreviation must retain its complete accessible name.

## Admin WebUI follow-up sequence

- [ ] After approval of the Durable visual benchmark, audit the shared shell, typography, spacing, form controls, buttons, and state treatments against the same design rules.
- [ ] Apply approved shared rules to Chats, Access, Defaults, Tool permissions, MCP connections, Model providers, and Audit in scoped changes. Keep policy editing, draft retention, authentication, transport, and save boundaries unchanged.
- [ ] Review real desktop and mobile pages with populated, empty, error, long-content, and unsaved states. Tests passing alone do not establish visual acceptance.

## Self-review corrections

- [x] Increase secondary-text contrast to at least 4.5:1 on every role surface and selected row. Caption, ID, and badge tests pass; measured minimum is about 5.29:1.
- [x] Bring message text and tool output above 410 px at 390 and 320 px widths without reducing their font sizes. Both mobile controls retain accessible names and 44 px touch targets.
- [x] Cap cumulative visual indentation while retaining semantic nested lists and complete record labels. Tests with 14 added levels and a long name pass at 1440, 390, and 320 px without navigator or page horizontal scrolling.
- [x] Decouple detail height from navigator height. Deep-branch tests confirm unchanged detail height and unchanged desktop footer position within 1 px.

## Execution status

Implementation was requested on `narumi/feat/durable-content-tree` in PR #157. The visual-approval gate remains in effect. Production interaction changes must wait for approval of the fixture preview.

The review-only fixture is served by Vite at `/tests/fixtures/durable-visual-preview.html?record=user` or `?record=tool`. It uses synthetic records and makes no Inspector API requests. It is not included in the production entry point.

Capture and validate the preview from the repository root:

```sh
npm run test:browser --workspace @narumitw/sumire-admin -- tests/durable-visual-preview.spec.ts --workers=1 --output=/tmp/sumire-durable-visual-preview
```

- [x] Revise the static preview to match the stated design quality reference and capture both record types at 1440, 768, 390, and 320 px. All 11 preview checks pass, including 14 px minimum navigation and code text.
- [x] Update PR #157 with the validated revised preview and reference-aligned design direction without changing production interactions.
- [ ] Receive user approval before starting the remaining implementation tasks.

The first preview was not accepted visually. The reference-aligned preview passed its initial checks, but later self-review found the four defects listed above. After correcting them, root formatting, lint, typecheck, 1,854 unit tests, build, all 251 Admin browser tests, and `git diff --check` pass. A separate read-only review found no additional issues. Validation does not establish user acceptance.

Preview browser checks cover no API requests, no horizontal overflow, desktop selection contrast, a closed mobile navigator, body-font user text, and monospace tool output without an internal vertical scrollbar. These checks do not replace the production interaction checks in the completion checklist.

Current screenshots are local review artifacts under `/tmp/sumire-quality-browser/`, not committed files. Desktop tool-result and mobile user-message captures were reviewed. User approval remains pending, so task 1 and the final acceptance checklist remain open.

## Plan

1. [ ] Build a fixture-based static preview of the proposed header, navigator, and content-first detail layout. Capture 1440 × 900 and 390 × 844 views. Include a selected nested tool result and an ordinary user message. Acceptance: user approval of the visual direction before completing interaction changes.
2. [ ] Reorganize `durable-inspector.tsx` so the workspace is the primary content, with history and raw collection browsing secondary. Acceptance: initial-viewport check passes and the selected record is not repeated below its detail pane.
3. [ ] Restyle and restructure `durable-tree.tsx` rows with type icons, concise labels, selection, independent expansion, and collection-local status. Acceptance: keyboard and pointer tests prove that selection and expansion are separate and no record becomes unreachable.
4. [ ] Flatten `EntryContent` and selected-record surfaces; move metadata and raw JSON into secondary disclosures. Acceptance: user text is readable without a metadata grid above it; arguments, thinking, result status, truncation, and copy actions remain available.
5. [ ] Apply Durable-scoped CSS using existing tokens. Acceptance: desktop, narrow, long-label, and deep-tree fixtures have no horizontal page overflow, overlapping controls, clipped focus, or nested message scroll boxes.
6. [ ] Update behavior and screenshot coverage without weakening lifecycle assertions. Acceptance: existing read budgets, query-bound pagination, cancellation, permission clearing, deep links, back/forward, and withheld-document behavior remain intact.
7. [ ] Update `docs/admin-webui.md` and the Admin changeset for the implemented interaction. Acceptance: documentation matches visible labels and controls; only affected packages receive a version change.

## Boundaries

- No backend, storage, contract, authentication, content-limit, or redaction changes are planned.
- Keep read-only access, explicit bounded reads, manual refresh, and incomplete-data warnings.
- Keep historical inspection separate from persisted conversation selection.
- Do not add a graph canvas, animation library, tree dependency, inferred transcript titles, full-history scan, polling, search, or layout preference storage.
- This iteration changes only the review fixture, its checks, and this plan. Follow-up work may refine other Admin sections under the expanded user goal, after approval of the visual benchmark. Do not add workspace-specific formatting policy.
- Use synthetic fixtures for screenshots. Do not commit the supplied production screenshot, binary review artifacts, private chat content, or administrator identifiers.

## Completion Checklist

- [ ] The user approves the fixture-based visual preview.
- [ ] Review desktop 1440 × 900, narrow 768 × 1024, mobile 390 × 844, and 320 px layouts. Screenshots include ordinary text, a tool result, a deeply nested branch, and an incomplete/error state.
- [ ] Keyboard-only review passes: visible focus, independent expansion and selection, reachable pagination/copy controls, and logical DOM order. Check text contrast and 200% zoom.
- [ ] Focused Admin unit and browser tests pass, including untrusted literal text, truncated-empty content, missing parents/cycles, retained selection, permission changes, and chat-switch cancellation.
- [ ] All Admin browser tests pass: `npm run test:browser --workspace @narumitw/sumire-admin -- --workers=1`.
- [ ] Root `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` pass. Record any external blocker instead of marking the check complete.
- [ ] `git diff --check` passes; review confirms no generated output, sensitive data, or unrelated global CSS changes.
- [ ] The implemented result is accepted, documentation and changeset are current, and no deployment is claimed without separate verification.

## Rollback / Recovery

This is a frontend-only change with no storage migration. Revert the visual-refinement commit to restore the current inspector. Keep the existing entry-content API and read-only storage ownership unchanged. Do not reset conversations or restore a database backup for a display rollback.
