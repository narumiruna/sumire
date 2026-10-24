# Admin UI/UX Fix Validation

Date: 2026-10-24

Baseline: `6e88481` (`main`)

Environment: Node.js 26.10.0 and Chromium through the admin Playwright configuration.

## Result

The four fixes retain the existing save boundaries, browser drafts, and authentication cleanup. The complete browser suite passed: **406 passed, 0 failed, 0 skipped, 0 flaky**. All 19 new regression cases passed four times: **76 passed**. All five required root checks passed, including **2,078 tests**, after the retry-focus correction.

All API data and credentials in these checks are synthetic. The checks do not use production settings or live provider connections.

## Verified behavior

| Area | Result and evidence |
| --- | --- |
| Failed saves | HTTP 409 and 500 focus the existing workspace alert after the busy state ends. At 1440 × 900, 390 × 844, and 320 × 844, the whole alert is visible above the status area. Retrying sends the identical connection draft, revision, and staged secret replacement. It does not save policy changes. A successful save returns focus after the editor closes and the busy state ends; completing a save after navigation does not focus the hidden section. |
| Focus boundaries | HTTP 401 clears the editor and opens sign-in. A delayed access-link read failure leaves focus in the active search input. Credential-save failure keeps focus and the synthetic key inside the authentication dialog. Background initial loads and OAuth polling do not request error focus. |
| Section navigation | Desktop pointer and keyboard section links focus the destination heading and reveal the page start. A draft Telegram ID survives navigation. Mobile navigation closes the menu and returns focus to Sections. The handler still leaves modified clicks to the browser. Explicit editor targets and browser history do not receive a global scroll reset. |
| Text contrast | Enabled solid, soft, surface, and ghost controls use existing high-contrast Radix tokens. Green badges, colored code labels, and the active sidebar link retain their status colors with darker text. Tests require at least 4.5:1 for controls in normal, hover, and keyboard-focus states, and for noninteractive badges in their normal state. Existing warning, disabled-state, and control-boundary checks remain in place. |
| Selector names | Provider and Model buttons use one displayed-value calculation for visible text and accessible names. Keyboard selection, Escape, focus return, empty values, and unavailable saved references retain the exact displayed value or fallback. No replacement is selected automatically. Search input and popup names stay unchanged. |

The 19 cases in `apps/admin/tests/uiux-regressions.spec.ts` cover the failures and focus boundaries above. Existing role-based locators now use the new selector names. The two desktop popup-navigation checks now require a focused, visible destination heading instead of focus on the old navigation link.

A separate Playwright probe checked Control, Meta, Shift, Alt, and non-primary click events. None was prevented by the application or changed its route or scroll position. Normal navigation retained unrelated query parameters, the selected chat, and the draft without writes. At 390 and 320 px, the closed mobile menu retained focus on its Sections trigger.

## Layout review

All 45 all-page screenshots were inspected: nine pages at 1440 × 900, 768 × 1024, 390 × 844, 320 × 844, and 640 × 900 with 2× CSS zoom. Pixel comparison confirmed that the final captures are unchanged after the retry-focus correction.

The checks retain the sand/teal theme, visible labels, panel boundaries, and status colors. There is no page-level horizontal overflow in this matrix. Visible main-area buttons and selectors retain at least 44 logical pixels of height, scaled to 88 rendered pixels at 2× CSS zoom. Existing focus and long-list tests cover controls near the sticky status area. Native-width popup checks remain enabled at every original viewport size.

The contrast helper measured 9.65:1 to 11.85:1 for the affected controls and badges across their tested states. The active sidebar link measured 10.85:1. An axe-core 4.14.0 scan of all nine pages at 1440 and 390 px found no remaining contrast or Provider/Model name violations. It reported only the four existing desktop chat-directory name mismatches described below. No uncaught page errors or page-level overflow occurred during that scan.

The added 2× CSS zoom matrix checks closed page layouts. An extra open-popup probe found an existing Radix positioning defect, described below. CSS zoom is not native browser zoom or operating-system magnification.

## Commands and evidence

Run root checks before browser checks. Dependency builds can reload Vite pages and invalidate concurrent browser measurements.

| Command | Result |
| --- | --- |
| `npm ci` | Passed; three existing audit findings |
| `npm test --workspace @narumitw/sumire-admin` | 287 passed |
| `npm run format:check` | Passed |
| `npm run lint` | Passed |
| `npm run typecheck` | Passed |
| `npm test` | 2,078 passed |
| `npm run build` | Passed |
| `npm run test:browser --workspace @narumitw/sumire-admin -- --workers=4 --reporter=line,json` | 406 passed |
| `npm run test:browser --workspace @narumitw/sumire-admin -- tests/uiux-regressions.spec.ts --repeat-each=4 --workers=4 --reporter=line,json` | 76 passed |
| `npm exec -- changeset status --since=origin/main` | Passed after staging the changeset; admin 0.6.1 → 0.6.2 only |
| `git diff --check` | Passed |

Local evidence is under `/tmp/sumire-uiux-fixes.JiwhXD/`:

- `accepted-browser.json` and `accepted-browser.log`: complete browser results.
- `accepted-browser/admin-visual-*/`: all 45 page screenshots.
- `accepted-browser/uiux-regressions-*/`: error and navigation screenshots.
- `contact-sheets/`: grouped images used for visual inspection.
- `accepted-regressions.json`: repeated regression results and contrast attachments.
- `accessibility.json` and `accepted-accessibility.log`: repeat accessibility scan.
- `navigation-boundaries.json`: modified-click, query, draft, and mobile-focus observations.
- `accepted-root-*.log`: required root checks.
- `base-zoom.log` and `current-zoom.log`: matching baseline and branch popup geometry.

These are temporary local artifacts, not committed images. Repository tests reproduce the four defects and generate new screenshots.

## Earlier failures and remaining limits

The initial regression run failed all 14 cases. Corrected contrast locators were then rerun against the baseline and failed on measured ratios. Later fixture corrections retained the existing rule that no model picker appears until an available provider is selected. Additional cases cover unavailable models, session expiry, background errors, and modal focus.

The first complete browser run passed 402 cases and failed three: two still expected the old navigation-link focus, and one provider locator also matched a pending-draft button. These assertions now use the planned heading focus and an exact provider name. A later run overlapped root builds and had nine failures; Vite dependency reloads also destroyed the accessibility scan's execution context. Neither run is final acceptance evidence.

The next complete run passed 404 cases and exposed an intermittent focus failure after a successful connection retry. The old animation frame did not wait for the enabled Add connection button to render. Focus now runs after the editor closes and the busy state ends. A new delayed-save test also verifies that navigation away prevents focus on the hidden section. All 19 regression cases then passed four times.

Remaining limits are outside this four-fix scope:

- At 640 × 900 with 2× CSS zoom, the open model popup is misplaced. Both the baseline and this branch place it at x=100, y=1140 with width=1080. The PR does not claim to fix this existing positioning defect.
- The repeat accessibility scan still reports the same four label/name mismatches on desktop chat-directory buttons as the baseline. They expose status through `aria-describedby`; those buttons are not changed here. All other scanned page/viewport combinations report zero violations. This work does not establish complete WCAG compliance.
- `npm ci` and `npm audit` reported three existing dependency findings: two high and one moderate, affecting `launch-editor`, `undici`, and the propagated Pi dependency finding. Dependency versions and the lockfile are unchanged.
- Live authentication, provider acceptance, model execution, native assistive technology, and non-Chromium browsers were not tested.

## Scope and recovery

Review found no API, policy schema, database, backend, dependency, or permission-rule changes. A later section-link click or component unmount cancels a pending navigation animation frame. Its callback ignores stale destinations. Error focus skips missing targets and modal-hidden content. Successful connection saves focus only a visible, enabled target after rendering. Test payloads contain only synthetic values.

The patch changeset affects only `@narumitw/sumire-admin`. Revert the admin source changes through the normal release process if recovery is needed. A code revert does not undo administrator settings; use the existing revision-checked settings flow for those changes. No package was published, release tag created, or release workflow dispatched.
