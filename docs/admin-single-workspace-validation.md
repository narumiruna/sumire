# Admin single-workspace validation

Date: 2026-10-30

Base: `bbf22de876d05772eeac7ac16b531f034b7c4b53`

## Decision and scope

The user rejected all three v1 designs as too complex. The user then requested fewer visible details, with primary settings visible and advanced content collapsed. After reviewing the v2 images, the user selected **A v2**: “先A 試試看”.

After the three-way implementation review, the user selected **Stop** (option 3). The iteration ends at A v2. The user later requested a pull request. That request authorizes a branch and commit for review, not another design round, deployment, or production acceptance.

This change keeps the section sidebar and uses one chat pane at every width. The directory and selected chat do not appear together. Primary Access, Model, and Tools values and actions remain visible. Readiness and advanced details start closed.

The implementation retains saved/application status, revision details, the actual brand asset, and the remote-response caveat. The generated image omitted some of these elements. The reading column is limited to 800 px so actions stay near their values.

Only the admin package changes. APIs, policy schemas, dependencies, environment variables, permissions, and save boundaries do not change. The changeset requests an admin patch.

## Findings

| ID | Priority | Status | Evidence |
| --- | --- | --- | --- |
| UI-01: directory/detail grouping | P2 | Verified | Exactly one pane is visible at 1440, 851, 850, 390, and 320 px. Back retains the selected row, search, filters, drafts, and scroll. Explicit chat links reveal details. |
| UI-02: value/action grouping | P2 | Verified | Overview has three plain setting rows in an 800 px maximum column. Actions remain beside their groups, with at least 44 px target height. At 390 px the facts occupy 249 px instead of 326 px. |
| UI-03: mobile spacing | P2 | Verified | Under the fixed 390 × 844 fixture, the first fact moves from y=439.59 to y=360.98. The required y≤400 condition passes. |
| UI-04: narrow tabs | P2 | Verified | At 320 px all four tabs fit in 288 px without internal overflow. Arrow, Home, End, active state, focus, and 44 px target height pass. |
| UI-05: initial complexity | P2 | Implemented; iteration stopped | The selected view has no fact cards or repeated healthy-status badges. Secondary details are closed. The user chose to stop at this version; no separate subjective acceptance is inferred. |

No unresolved implementation defect was found by the final checks. This does not establish usability for untested users, devices, or workflows.

## Preserved behavior

- Directory selection, manual chat IDs, search, filters, pagination, long names, and observed metadata remain available.
- Back focuses the selected directory row when visible. Otherwise, it focuses search. Directory scroll and editor drafts remain intact.
- Pane changes close portaled controls without focusing hidden triggers. Browser Back can restore the empty-selection directory.
- Explicit returns from Chat access focus the selected chat. A retained access target is used even if history cleared the current selection.
- Chat actions contains Copy chat ID and the conversation-record link at every width. The link retains its URL and native activation. Chromium checks cover Ctrl-click, Ctrl-Enter, Shift-Enter, ordinary selection, and menu focus return.
- Saved state remains separate from drafts and runtime verification. Errors, repair actions, save recovery, application failures, and security warnings are not moved into new disclosures.
- Policy, provider, MCP, and runtime transactions retain their existing boundaries. No autosave is added.

## Screenshots and provenance

The local comparison page is <http://127.0.0.1:17467/comparison/>. It shows the original desktop screenshot, selected A v2 design, and implementation. It also shows original/implemented 390 px and 320 px captures.

Persistent evidence is under:

`/home/narumi/.local/share/sumire-admin-visual-review/`

- `round-01/v1/`: recovered original attachments, rejected designs, and contact sheets.
- `round-01/v2/`: selected design, earlier comparison gallery, and the three-way comparison page.
- `round-01/baseline-recreated/v1/`: 61 captures made before source edits, with fixture, manifest, requests, and provenance.
- `round-01/implementation/v1/`: initial implementation evidence and failed-check logs.
- `round-01/implementation/v2/`: final 61-capture matrix, fixture, manifest, checks, screenshots, and source hashes.
- `review-state.json`: user decisions and finding status.
- `artifact-recovery.json`: attachment provenance and hashes.

The original temporary artifact directory disappeared before implementation. Six of the original 62 baseline images were restored exactly from conversation attachments. The other original image files were not recovered. The original six are never overwritten. The replacement matrix uses the original capture script, recorded edits, unchanged base source, and synthetic fixture. Recreated captures are labelled as new evidence, not original bytes.

The primary comparison uses retained original screenshots. Both matrix phases use Engineering (`-100101`), Overview, saved/applied revision 12, `openai/gpt-5`, six allowed tools, and closed disclosures. Conditions are Chromium, light sand/teal theme, device scale 1, en-US, UTC, reduced motion, and fixed Date `2026-10-29T10:30:00Z`.

Viewports are 1440 × 900, 768 × 1024, 390 × 844, and 320 × 844. Each matrix has no page-level horizontal overflow, uncaught page errors, or non-GET API requests. API data and credentials are synthetic. No live service setting is changed. Final captures park the pointer in the viewport corner to avoid accidental hover styles.

## Checks

Node.js 26.11.1 and Playwright 1.64.1 were used. Root builds ran before the final browser suite, not during layout measurements.

| Command or check | Result |
| --- | --- |
| `npm ci` | Passed; four existing dependency audit findings remain |
| `npm run format:check` | Passed |
| `npm run lint` | Passed; one existing `innerText` performance warning |
| `npm run typecheck` | Passed |
| `npm test` | 3,044 passed across workspaces |
| `npm run build` | Passed |
| Complete admin browser suite | 577 passed; no failures, skips, or flaky results |
| Focused new single-workspace coverage | 22 tests included in the complete suite |
| Same-fixture capture matrix | 61 before-edit captures and 61 final captures |
| New text contrast checks | All measured text exceeds 4.5:1 at the four native widths |
| Comparison-page browser checks | All seven images load at 1440, 390, and 320 px; no overflow; original-image links work by keyboard |
| `git diff --check` | Passed |
| `npm exec -- changeset status` | Admin patch only |

The final browser command was:

```sh
npm exec --workspace @narumitw/sumire-admin -- playwright test \
  --config=/home/narumi/.local/share/sumire-admin-visual-review/playwright-final.config.mjs \
  --workers=4
```

The local config uses the repository test directory and existing development server. It changes only server management, workers, reporter, and evidence paths. It does not omit tests or change their fixtures.

Detailed results are in `round-01/implementation/v2/evidence/`: `root-checks.json`, `root-*.log`, `browser-results.json`, `browser-full.log`, `visual-measurements.json`, `comparison-checks.json`, and `checked-source-sha256.txt`.

## Corrections during implementation

The initial browser run passed 565 of 571 tests. Six failures came from old exact text/disclosure assumptions. Tests now use real pane transitions and open the existing inspector disclosure before its actions. No forced clicks replace user navigation.

Further review found an empty-selection return case, menu keyboard activation that could lose modifiers, and explicit chat-return focus that could be skipped. Targeted regression tests cover each correction. A test observer was also corrected to observe native new tabs through the browser context rather than requiring a popup opener.

No source change followed the final root checks and 577-test browser run. Final source hashes are retained with the evidence.

## Limits and handoff

- The user stopped the iteration at A v2. This is not a separate usability or production-readiness result. Screenshot similarity is not proof of usability.
- Native assistive technology, hardware passkeys, real provider/OAuth acceptance, non-Chromium browsers, and macOS modifier keys were not tested.
- The existing model-popup positioning limit under 2× CSS zoom is unchanged. The suite checks native-width popups and separate page reflow; it does not prove native browser magnification behavior.
- The later request authorizes a branch and commit for review. Deployment, package publication, and production data mutation remain outside scope.

The required user direction is recorded: **Stop**. The administrator must perform any required live-device, provider and deployment acceptance checks before release. The implementation and evidence are retained. The completed implementation plan can be removed; no additional iteration is scheduled.
