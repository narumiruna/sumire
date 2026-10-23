# Administration UI/UX Remediation Validation

## Scope and limits

Validated on 2026-10-24 with Node.js 26.10.0, npm 11.19.1, and Playwright 1.64.1 Chromium. The browser tests intercept API requests and use synthetic data. They do not change a running bot, use real credentials, or test remote provider acceptance.

These are behavior, accessibility, and geometry checks, not a user study. They do not measure comprehension or production task-completion time. No API, database schema, or runtime permission change is included.

## Regression evidence

The initial `tests/remediation.spec.ts` run had nine failures across F1–F6 before implementation. The final admin browser run passed 340 tests, with no skipped, flaky, or unexpected results. The two remediation suites contribute 32 tests. The admin unit suite passed 282 tests in 23 files.

| Finding | Checked task | Evidence |
| --- | --- | --- |
| F1 | Leave an unfinished ID, tool name, endpoint, or secret input; return from another page; clear only that input | Desktop/mobile keyboard return and focus; unrelated policy changes, search, and selected chat retained; multiple blockers at 320 px and 200% zoom |
| F1 | Review changes from the policy status | Typed destinations cover access, tools, skills, defaults, endpoints, and chat fields; chat review opens its actual disclosure; protected values are absent from metadata |
| F2 | Shared defaults → choose another model → confirm save | Default intent survives selection, authentication, navigation, cancellation, and failed-save retry; availability-only and explicit chat-override tests remain intact |
| F3 | Chats → Change model | Model control is focused and fully visible, including with pending status; tool configuration stays collapsed; inheritance and conflict tests retain their checks |
| F4 | Add/Edit → close → resume; cancel replacement; save a protected-field patch | Initial view has no replacement form or reserved empty editor column; transport fields are selective; guided/JSON values and secret maps survive failure and reload; previews remain redacted |
| F5 | Open permissions, access, skills, or shared defaults | A usable row/action fits the reference mobile viewport; fresh and saved expansion preferences differ correctly; reset confirmation and payload tests still pass |
| F6 | Read records → filter by a known label or a custom exact value | Exact server query values, unknown labels, active summaries, UTC date bounds, pagination, retry, stale responses, and HTTP 401 handling remain covered |

Existing browser tests now open disclosures or connection editors through visible controls. Permission checks, mutation assertions, save-scope checks, and recovery checks were retained.

## Reference geometry

The following are viewport coordinates from the final browser report. Values are rounded to the nearest pixel. Clean-page checks start at scroll position zero. The model task uses the explicit Change model action.

| Viewport | Content or action | Top–bottom |
| --- | --- | --- |
| 390 × 844 | Complete first tool permission row | 610–825 px |
| 390 × 844 | First access revoke action | 634–688 px |
| 390 × 844 | First skill default-selection checkbox | 689–705 px |
| 390 × 844 | Edit default model action | 516–560 px |
| 390 × 844 | Add connection action | 422–466 px |
| 390 × 844 | Edit saved connection action | 635–679 px |
| 390 × 844 | Audit record heading and result | 454–475 px |
| 390 × 844 | Focused chat model control | 427–471 px |
| 1440 × 900 | Focused chat model control | 460–504 px |

Checkbox coordinates describe the indicator; its labelled row retains the existing larger interaction area. Button/select height checks remain at 44 px.

## Responsive and interaction review

All nine pages were captured at 1440 × 900, 768 × 1024, 390 × 844, and 320 × 844. The suites check page overflow, accessible control names, and 44 px buttons/selects. Separate tests retain long names, empty lists, populated lists, keyboard navigation, dropdown Escape behavior, and 200% CSS zoom.

Direct editor actions place focus below the sticky status area. Multiple unfinished fields can be cleared independently at 320 px and 200% zoom. New disclosures retain their mounted state. Navigation and disclosure actions do not submit configuration or start connection tests.

The existing contrast checks cover normal, muted, disabled, pending, error, and control-boundary states. Chats overview and Conversation records retain their useful disclosures and the compact clean-state behavior.

Local artifacts from this run:

- `/tmp/sumire-remediation-final/`: page, editing, blocked, and failed-state screenshots.
- `/tmp/sumire-remediation-browser.json`: test results and geometry attachments.
- `/tmp/sumire-remediation-baseline.log`: nine original failures.

These temporary files are not repository dependencies and are not committed.

## Required checks

| Command | Result |
| --- | --- |
| `npm run format:check` | Passed |
| `npm run lint` | Passed without lint warnings |
| `npm run typecheck` | Passed |
| `npm test` | 2,073 tests passed in 152 files across all workspaces |
| `npm run build` | Passed |
| `CI=1 npm run test:browser --workspace @narumitw/sumire-admin -- --reporter=line,json` | 340 passed; no skipped or flaky tests |
| `git diff --check` | Passed |

The admin SSR tests emit Node.js's non-failing localStorage experimental warning. No required check was unavailable.

Final review confirmed that changes are limited to admin sources/tests, documentation, and the admin patch changeset. No generated files, images, private URLs, or credentials are included. The API and save boundaries are unchanged; this UI-only change needs no data migration.
