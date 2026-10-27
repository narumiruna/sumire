# Admin UI/UX Recovery Validation

Date: 2026-10-27

Base: `5673557` (`main`)

## Result

All five reviewed findings are resolved. The required root checks passed, including **2,148 unit tests**. The complete admin browser suite passed **500 tests**, with no failures, skips, or flaky results. The four focused regression files passed three consecutive runs: **252 passed**.

Final checks ran with Node.js 26.10.0 and Chromium through Playwright 1.64.1. A separate Git worktree used the committed lockfile and the intended implementation. Its admin sources and tests were compared with the delivery worktree. The unrelated lockfile modification in the delivery worktree was preserved and excluded from the change.

All browser API requests and credentials are synthetic. No production settings, live provider connections, or MCP processes were used.

## Verified behavior

| Finding | Acceptance evidence |
| --- | --- |
| Policy save recovery | A real fixture revision advance rejects the old PUT. Loading and reviewing the latest settings sends no PUT. Disjoint edits survive, overlapping values require an explicit choice, and the next reviewed save uses the latest revision. Atomic lists are not combined. |
| Unknown save outcome | A committed PUT with a lost or malformed response can be confirmed without another PUT. Later local edits, including edits that restore an original value, remain visible for resolution. Discard retains the unresolved-outcome warning. Another policy submission is blocked until reconciliation; direct approval reviews cannot bypass that guard. |
| Read and application failures | Cancelled or failed recovery reads retain the draft and original base. Invalid revision/application metadata cannot become a save base. A successful settings response records persistence before inventory, audit, or import refresh. Failed or pending application remains distinct from a refresh error. Client reference checks block invalid recovered selections before a PUT; backend validation remains unchanged. |
| Draft and session boundaries | MCP drafts, secret inputs, and unfinished access input survive recovery and revision changes. A second revision advance requires another review. HTTP 401 clears recovery state. A late settings read or application-retry continuation from an expired session cannot replace a later session's draft. A virtual WebAuthn credential tests the sign-in transition without a real account. |
| Provider and Model pickers | Both 122-result lists retain combobox focus for arrows and Enter. Filtering reveals the active result; zero results have no active descendant. Options have no Tab stops. Tab and Shift+Tab follow the closed trigger's native focus order. Pointer selection and Escape return focus; section changes do not focus hidden triggers. |
| Explicit navigation targets | Pointer and keyboard navigation reveal and focus model availability at 1440, 390, and 320 px. Repeated same-page requests work. Initial known anchors wait for the destination render. Later navigation, history changes, expiry, and unmount cancel stale callbacks. Selected chats, URL parameters, and drafts remain intact without writes. Ordinary sidebar and history focus behavior remains unchanged. |
| Audit names and layout | Accessible names match visible labels, including exact matching and UTC instructions. Custom exact-value fields remain separately named. Selectors fill their fields and keep 44 px minimum height. Exact filter values, inclusive UTC bounds, pagination, and collapsed summaries retain their behavior. |
| MCP discard focus | Confirmed keyboard discard clears the draft and focuses visible, enabled Add connection after rendering. Cancellation retains values and focus. Navigation and expiry cancel queued editor focus. |
| Untrusted values | Recovery comparisons render policy values as text. The markup fixture creates no image, runs no script, and loads no embedded URL. No recovery state is written to browser storage. |

The deterministic recovery helper has unit coverage for disjoint and overlapping edits, additions/removals, provider order, absent chat records, inheritance, explicit empty lists, identical saved drafts, post-submission edits, and input immutability.

## Layout and focus review

Changed draft, error, recovery, and Audit focus states were checked at:

- 1440 × 900.
- 390 × 844.
- 320 × 844.
- 640 × 900 with 2× CSS zoom.

The recovery dialog fits the viewport and scrolls internally when necessary. Radio labels remain beside their controls with 44 logical pixels of target height. Long status text wraps. Focused controls remain visible above the bounded changes bar, and the checked pages have no horizontal overflow. The existing all-page visual matrix also passes.

CSS zoom is not native browser zoom or operating-system magnification. The previously documented open model-popup positioning defect under 2× CSS zoom is not fixed by this change. Picker popup checks use native viewport widths; the new recovery dialog and closed-page reflow have separate CSS-zoom checks.

## Commands and evidence

Commands ran from the repository root in the clean verification worktree. Root builds completed before browser checks; they did not run concurrently with Vite measurements.

| Command | Result |
| --- | --- |
| `npm ci` | Passed; three existing audit findings: two high and one moderate |
| `npm test --workspace @narumitw/sumire-admin` | 344 passed |
| `npm run typecheck --workspace @narumitw/sumire-admin` | Passed |
| `npm run format:check` | Passed |
| `npm run lint` | Passed; one existing `innerText` performance warning in `tests/durable-workspace-visual.spec.ts` |
| `npm run typecheck` | Passed |
| `npm test` | 2,148 passed |
| `npm run build` | Passed |
| `npm run test:browser --workspace @narumitw/sumire-admin -- --workers=4 --reporter=line,json` | 500 passed; no failures, skips, or flaky results |
| `npm run test:browser --workspace @narumitw/sumire-admin -- tests/uiux-regressions.spec.ts tests/uiux-navigation-discard.spec.ts tests/uiux-picker-audit.spec.ts tests/uiux-recovery-layout.spec.ts --repeat-each=3 --workers=4 --reporter=line,json` | 252 passed; no failures, skips, or flaky results |
| `git diff --check` | Passed |
| `npm exec -- changeset status --since=origin/main` | Passed; admin patch only |

Local evidence is under `/tmp/sumire-uiux-implementation/`:

- `accepted-clean-root-*.log`: final required root checks.
- `accepted-clean-browser.json` and `.log`: complete browser results.
- `accepted-clean-browser/`: generated screenshots, including recovery and Audit focus states.
- `accepted-repeated-browser.json` and `.log`: repeated regression results.
- `clean-install.log`: installation with the committed lockfile.
- `baseline-recovery.log`: six expected failures before recovery implementation.

Screenshots and logs are local artifacts, not committed assets. The tests generate new evidence when run again.

## Corrections found during implementation

The initial recovery cases failed on the missing recovery action and the loss of saved state after a failed related-data refresh. Further review identified post-submission edits, unresolved discard, repeated unknown outcomes, and old-session continuations. These paths now have explicit guards and regression tests.

Browser checks also found incorrect hidden-control and changes-bar test locators, accessible names that included nested select text, and a model-workflow fixture that returned an empty object instead of the existing settings Snapshot response. These were corrected. An invalid-reference assertion now requires rejection before any PUT rather than relying on the fixture's server error.

A provisional initial-load schema check rejected partial legacy presentation fixtures. That check was removed without changing initial-load compatibility; strict validation remains on the new save and recovery paths. Visual review found a narrow-dialog overflow, separated radio labels, and Audit selectors that no longer filled their fields. Bounded dialog height, scoped radio styles, and selector geometry checks address those regressions. Final staged-diff review found no remaining actionable issue in correctness, security, lifecycle, compatibility, regression, or scope.

## Limits and recovery

- Live Passkey enrollment, hardware authenticators, native assistive technology, non-Chromium browsers, provider acceptance, and real MCP execution were not tested.
- Recovery intentionally treats whole lists, the provider list, and chat records as atomic values. Choosing a draft value can replace concurrent changes within that value; the dialog requires an explicit decision and shows both values. No automatic list union occurs.
- Drafts and recovery state remain in memory. A browser warning cannot preserve them after the tab is closed.
- No backend, policy schema, API contract, database, dependency, or permission-rule change is included. The patch changeset affects only `@narumitw/sumire-admin`.
- Revert the admin patch through the normal release process if needed. A code revert does not undo saved administrator settings; use the revision-checked settings workflow for those changes. No package publication, version tag, or release workflow dispatch is part of this work.
