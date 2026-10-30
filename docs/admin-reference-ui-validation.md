# Admin Reference UI Validation

Validated on 2026-10-30 against the supplied 1448 × 1086 conversation-records image.

## Result

- Use a light green sidebar with visible icons, grouped sections, and an administrator footer.
- Use a white workspace, a sans-serif page heading, chat identity, and a three-cell context strip. Show breadcrumbs on Conversation records. Keep the other page headers compact.
- Show History and Branch view below the context strip.
- Show compact History previews on the left and selected entry details on the right on desktop screens.
- Keep the existing entry-details dialog on narrow screens.
- Add loaded-page ordering, Previous/Next entry controls, and Copy content.
- Keep only existing administration destinations. Do not add the unimplemented destinations shown in the reference image.

## Integration and Data Boundaries

- Fast-forwarded `main` to `ad71727`, which includes upstream PR #216. The visual work is on `narumi/feat/reference-admin-ui`.
- Preserved the earlier local implementation in Git stash `wip: preserve reference UI before upstream history sync`. The stash was not applied over the upstream implementation or deleted.
- Retained the upstream History API, bounded content reads, cursor pagination, inspected-conversation ownership checks, session-generation checks, and abort handling. No server, contract, storage, authentication, or environment-variable changes are part of this UI change.
- Search and filters cover only the loaded History page. They do not scan other pages.
- Oldest/Newest order follows native entry order within the loaded page, not message timestamps. Previous/Next follows the filtered display order and does not cross page boundaries or infer missing IDs.
- List previews contain at most 320 characters and render saved text literally. They omit thinking and tool arguments. Full approved content remains available in entry details.
- Copy content copies text and tool arguments, excludes thinking, and reports clipboard failures. Existing JSON-copy controls remain available.

## Checks

All required checks passed from the repository root:

- `npm run format:check`
- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `git diff --check`

Lint exits successfully with five existing CSS specificity warnings and one informational finding in an unchanged test. The admin unit suite passes 389 tests.

After the review fixes, the full browser suite passes all 639 tests with synthetic API fixtures:

```sh
npm run test:browser --workspace @narumitw/sumire-admin -- --workers=8
```

The validation run used a temporary Playwright configuration on port 18468 because port 17466 was already in use. The existing server process was not stopped.

Coverage includes native ordering, loaded-page filters, navigation boundaries, inherited entries, missing records, safe literal content, permission failures, session changes, stale reads, raw collections, keyboard focus, chat switching, and retained settings drafts. Seven new tests cover keyboard focus during delayed entry reads, enabled boundary controls, focus moved away from navigation, and the narrow-screen dialog. The unchanged density and workflow height tests also pass. See `docs/admin-reference-ui-review-ledger.md` for each review outcome. Layout checks cover 320, 390, 768, 1440, and 1448 pixels, fallback fonts, text contrast, 44-pixel controls, and page overflow.

## Visual Evidence

Local screenshots are under `/tmp/sumire-reference-ui-results/`:

- `reference-history-1448.png`: desktop list and selected details.
- `reference-history-{768,390,320}.png`: narrow History layouts.
- `reference-detail-{768,390,320}.png`: narrow entry-details dialogs.

Screenshots are test artifacts, not tracked project assets. Regenerate them with `tests/reference-ui.spec.ts`.

## External Handoff

Product owner: after a deployment is available, compare the rendered UI with the reference image on the intended devices. Expected result: readable controls and the requested visual hierarchy. Physical-device behavior, production-session behavior, and subjective visual acceptance were not verified by these synthetic browser tests. No deployment or product approval is claimed; no additional release approval was required for completion of this coding task.
