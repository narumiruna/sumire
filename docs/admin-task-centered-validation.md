# Task-centered administration validation

## Scope

This change affects the admin workspace only. Browser checks use intercepted API fixtures and dummy chat IDs. They do not use production settings, provider credentials, Telegram requests, or model generation. No backend, policy resolver, contract, database schema, or dependency changes are intended.

The user's earlier inspection covered one selected chat's Overview and settings. Search and the complete settings flow were not verified because browser access was lost. No settings were saved. This record does not convert that partial inspection into evidence of other failures.

## Baseline

Baseline source: `origin/main` at `94c5db7`.

- Node.js: 26.10.0. `npm ci` completed and configured Husky. npm reported one existing high-severity dependency advisory; no dependency remediation is included.
- Admin unit suite: 181 tests passed in 19 files.
- The normal browser command could not start because port 17466 already had a listener. That process was not stopped or reused.
- A temporary Playwright configuration used the same Chromium/test setup on the free port 17476, with strict port binding and no server reuse. The first full attempt exceeded the command's 300-second limit. A background run with two workers completed: 279 passed, one existing visual test exceeded its 30-second limit. That 1440px visual test passed alone with a 60-second limit in 9.1 seconds.
- The fixed 17-chat baseline reproduced **Approved** in the directory while selected details reported missing local authentication. This is missing configuration, not a failed remote verification result.

| Viewport | Baseline complete visible rows | Baseline clean save panel |
| --- | --- | --- |
| 1440×900 | 2 | 122px |
| 390×844 | 4 | 92.59px |

Measurements use full row bounds inside both the list region and viewport. Names and IDs are fixture data; no production screenshot is retained.

## State and action contract

`apps/admin/src/chat-state.ts` is the shared saved-state resolver for directory rows and selected-chat details. It uses `effectivePolicy`, local provider inventory, and the saved/applied revision state. It does not perform network requests.

| Fixture condition | Primary label | Repair destination and focus |
| --- | --- | --- |
| Missing approval | Access not approved | This chat's Access heading |
| Explicitly disabled chat | Disabled | Chat enabled checkbox |
| Failed application | Application failed | Save status region; no automatic retry |
| Pending application or mismatched revisions | Application pending | Save status region; no automatic retry |
| Missing or excluded effective model | Setup required | Chat model override selector |
| Missing local authentication | Setup required | Model providers page heading |
| Missing provider or selected model inventory | Status unknown | Model providers page heading |
| No known blocker and matching applied revision | Configured locally | No repair action; Model response not checked |

Priority is access restrictions, application state, model setup, then unknown inventory information. Additional issues remain under Readiness details. Approval and the enabled switch are independent. Draft effects do not change the saved-state summary. The access filter remains page-local and draft-aware; explicit draft access appears separately from saved labels.

Repair buttons change location/focus only. Fixture request records confirm GET-only behavior for the status scenarios. Model authentication checks, OAuth, MCP probes, discovery, and generation do not start automatically.

## Delivered behavior and regression coverage

- `src/chat-state.test.ts`: separate approval and enabled states; missing/disallowed model; disabled provider; missing authentication; missing provider/model/inventory; applied/pending/failed revisions; several blockers; saved-versus-draft behavior.
- `src/save-status.test.ts`: compact state requires every scope to be clean, no busy operation, successful application, and matching revisions. Independent policy/MCP/provider/input/busy/pending/failed and mixed states keep full notices and controls.
- `src/policy-editors.test.ts`: field-local scope/source labels, inherited selections, explicit empty selections, retained globally blocked values, defaults, and per-field model/thinking source. Existing callbacks and accessible control names remain unchanged.
- `src/policy-changes.test.ts`: changed field names, selection resets, explicit empty selections, added/removed overrides, default inheritance impact, global limits, and provider definition fields. Summaries omit selected values, endpoint values, and credentials. They preserve scope-level pending counts.
- `src/navigation.test.ts`: task groups, primary labels, secondary MCP/Durable descriptions, stable section query values, legacy aliases, selected chat, and deep-link context.
- `tests/task-centered.spec.ts`: row/detail agreement, repair focus and GET-only navigation, saved-state draft isolation, confirmation/cancel/discard, 0/17/99/100/101 record pagination, loading/error back navigation, measured density, reflow, contrast, Account keyboard behavior, and clipboard success/failure.
- Existing browser suites retain cross-section draft, conflict, save cancellation, application retry, session expiry, stale-result, directory scroll/query/filter/tab, modified link, and legacy URL coverage. Shared directory changes also run through the Durable Inspector suites.

The compact save line is neutral text, not a save button. Scope notices and save actions appear when attention is required. Clean Conversation records views keep their previous hidden-save-panel behavior. Selected rows use a stronger text weight and inset boundary as well as color. Strong buttons prioritize repair or explicit save actions; Reload and Copy chat ID are secondary. Sign out is in the Account menu.

Search remains server-side before pagination. Type/access filters and detailed search rules are under Filters and search scope. Pagination disappears only for a completed successful first response with fewer than 100 records. Later pages always keep Previous chats, including empty and failed pages. There is no invented total count.

The confirmation lists changed fields and their scope and retains the active-work cancellation warning. Policy saves do not include MCP, provider selection, or credential drafts. None of the display changes expands availability ceilings or access approval.

## Verification results

Local checks after the CI layout fix passed on Node.js 26.10.0. Remote results are available in the [PR #159 checks](https://github.com/narumiruna/sumire/pull/159/checks).

| Check | Result |
| --- | --- |
| `npm run test --workspace @narumitw/sumire-admin` | 272 tests passed in 22 files |
| Complete Chromium suite | 306 tests passed, including 24 task-centered cases and four fallback-font workspace cases |
| Root `npm run format:check` | Passed |
| Root `npm run lint` | Passed without warnings |
| Root `npm run typecheck` | Passed |
| Root `npm test` | 1,968 tests passed across all nine workspaces |
| Root `npm run build` | Passed |
| `git diff --check` | Passed |

The complete browser command after the CI fix was `npm run test:browser --workspace @narumitw/sumire-admin -- --config playwright.ci-fix.config.ts --workers=2`, with the normal test timeout. The temporary configuration imported `playwright.config.ts`, retained its Chromium/test settings, and set both baseURL and webServer URL to `http://127.0.0.1:17476`. Its webServer command was `npm run dev -- --port 17476`; server reuse remained disabled. The temporary file was removed after testing. The existing listener on 17466 was unchanged. The final suite ran without source or test edits.

| Viewport | Final complete visible rows | Final clean save line |
| --- | --- | --- |
| 1440×900 | 6 | 45px |
| 390×844 | 6 | 33.59px |

The measurement fixture has 17 named private chats, one approved chat, and missing local provider authentication. It matches the baseline status conditions. The tests attach their geometry results instead of committing screenshots.

Reflow checks include 1440, 850, 390, and 320 CSS pixels and 200% CSS zoom. Contrast checks use composited computed colors and require 4.5:1 text and 3:1 control boundaries. These checks are not screen-reader certification or real-device browser zoom evidence.

Intermediate integration runs failed on a JSX brace error and selectors for intentionally changed labels, disclosures, and pagination. These were corrected before the final runs. A real 320px regression put selected conversation content below the existing 410px bound. The longer navigation label caused wrapping; the mobile trigger now bounds and truncates visible text while retaining its full accessible name. The original 410px bound passes without relaxation. An intermediate root run also failed three unchanged bot subprocess/deadline tests while browser tests ran. The complete root suite passed after the browser run ended; no bot changes were made.

### CI fallback-font regression

[CI run 39822262468](https://github.com/narumiruna/sumire/actions/runs/39822262468) passed 300 browser cases but failed the two 320px conversation workspace cases. Message and tool-output content started at 416.875px, below the unchanged 410px limit. Browser installation succeeded; it was not the failure.

The default macOS font kept the page title on one line. Arial and Verdana wrapped the title to two lines and reproduced the same 416.875px result locally. The mobile page header had both bottom padding and bottom margin. Reducing that duplicate space keeps the complete title, existing text sizes, and 44px action targets. The fix changes only narrow-screen header spacing, not the test limit.

Four new 320px cases cover message and tool content with Arial and Verdana. They failed before the CSS fix and pass after it. The tests retain the 410px limit, assert the requested fallback font, and attach title/header/content bounds. The focused workspace suite passed 18 cases; the complete browser suite passed 306 cases. All five root checks passed again. No CI retry policy, timeout increase, or workflow change was required.

## Review and remaining acceptance

A separate read-only source review checked correctness, security boundaries, lifecycle cleanup, compatibility, regressions, and scope. It found two actionable items: ambiguity between draft-aware access filters and saved labels, and the missing package changeset. The filter now explains its draft scope and each affected row exposes draft access separately. The changeset now bumps `@narumitw/sumire-admin` with a patch entry. Source review alone is not rendered-layout or remote-provider evidence. Final diff review also confirmed that test changes retain draft isolation, save boundaries, stale-result checks, pagination failure paths, and the existing narrow-screen geometry bounds.

Actual user acceptance remains open. Automated fixture flows do not prove that the administrator finds the revised interface clear. Keep `docs/plans/2026-10-23_admin-task-centered-plan.md` until the user confirms status/reason/next-action clarity and the staged review/cancel/return-to-search flow.

Real devices, live provider acceptance, production ingress, and production deployment are not verified by this change. No live setting change, model request, package publication, version tag, or release workflow is part of this work.

## Recovery

No data migration is required. Revert the admin change or use the previous compatible application image after separately authorized deployment coordination. Do not restore an older policy database for a visual rollback. Warn before reload or replacement because a code revert cannot recover unsaved browser drafts.
