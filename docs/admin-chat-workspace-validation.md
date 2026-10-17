# Chat workspace validation

## Scope

All browser requests use isolated API fixtures. No production settings, data, credentials, Telegram requests, or remote model checks were used. Policy calculations, API contracts, permissions, and save boundaries are unchanged.

## Changes

- The directory uses header, scrollable list, and footer grid regions. Only the list scrolls on desktop. The sticky directory height uses its measured document position and the existing save-status height, not a title-dependent offset. Measurement updates run outside the ResizeObserver delivery and are cancelled on cleanup. If the bound cannot fit the header, footer, and one full row, the directory uses natural document scrolling. Header and footer size changes also update this check.
- Detail content uses document scrolling. Narrow and short viewports use natural directory scrolling. Returning to the narrow directory restores its document scroll position and focuses the selected row without scrolling it again.
- The header reserves separate title/metadata and copy-action columns. Narrow screens stack them. Row titles have a two-line limit; their full text remains in the accessible button name and title attribute.
- Approval badges use distinct text and check/minus icons. Readiness keeps the existing blocker conditions and shows each blocker with its action. Secondary approval, enablement, configuration, verification, application, and technical caveats are in the Readiness details disclosure.

## Tab investigation

Before changing source, `chat-workspace.spec.ts` clicked Access, History, and Overview at 1440 and 390 CSS pixels. Each selected the matching panel. Keyboard End selected History. Switching chats retained the selected tab and updated the ID. There were no additional API requests or dirty settings. The four baseline screenshot/interaction tests passed.

The final suite repeats these checks. Inspection found controlled Radix tabs with `onValueChange`, matching trigger/content values, and inactive panels hidden. The automated failure was not reproducible; tab handlers and state logic were not changed.

**Manual reproduction remains blocked.** The Chrome DevTools tool could not start because its configured Chromium executable `/home/narumi/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome` does not exist. A local fixture-only server was prepared, then stopped. Headless Playwright uses a working local Chromium installation; this does not replace manual verification. Repeat Access/History clicks in an available manual browser before closing the saved plan.

## Regression evidence

`apps/admin/tests/chat-workspace.spec.ts` adds 13 tests:

- Desktop/narrow screenshots of an approved long emoji/CJK supergroup, a short unapproved group, and two same-name groups with different IDs. Additional after screenshots cover an unbroken title.
- Click and keyboard tab selection, one visible matching panel, retained tab on chat switch, no requests from navigation, and no dirty policy.
- Layout/readiness at 1440, 390, and 320 CSS pixels: no horizontal overflow, stable desktop copy-action alignment, narrow stacking, full title accessibility, selected-row ID, visible keyboard focus, explicit missing-authentication action, both actions for unapproved chats, and distinct expandable status fields.
- All 100 desktop rows can be fully revealed above the footer. Clicking visible rows preserves list scroll position. Returning to the narrow directory preserves document scroll position and focuses the selected row.
- Expanded onboarding remains outside the list. At 600 pixels high, the desktop directory uses natural document scrolling. Disabled previous-page controls remain disabled; screenshot review confirms their disabled appearance.

The existing narrow keyboard-navigation test now expects focus on the selected row when returning from details, rather than resetting focus to search. Other existing tests retain filter, pagination, policy editing, application, draft, and session-expiry coverage.

## Commands and results

Node.js 26.10.0:

- Root `npm run format:check`, `npm run lint`, `npm run typecheck`, and `npm run build`: passed.
- Root `npm test`: final full rerun passed, 1,475 tests. During initial implementation, two bot MCP SIGTERM cases timed out. During review fixes, five bot process-recovery cases timed out at their existing 5-second limit, followed by cleanup assertions. A focused review rerun passed all 35 MCP-session and durable-runtime tests; the subsequent complete root rerun passed. No bot code or timeout was changed.
- `npm run test:browser --workspace @narumitw/sumire-admin -- --output=/tmp/sumire-pr126-browser`: 134 passed. No ResizeObserver errors were reported in the final run.
- `git diff --check`: passed.

The initial new layout tests failed because the test refocused Copy chat ID before pressing Shift+Tab. Using the page keyboard corrected the test. An early measurement implementation also generated ResizeObserver notifications; deferred, change-only updates corrected that issue. Final layout tests assert no page errors.

## Screenshots

Local artifacts are not committed:

- Before: `/tmp/sumire-chat-before/chat-workspace-chat-screenshots-at-{1440,390}px/`
- After: `/tmp/sumire-chat-after/chat-workspace-chat-screenshots-at-{1440,390}px/`
- Names: `before-directory-WIDTH.png`, `before-chat-INDEX-WIDTH.png`, and matching `after-...` files. Index 0 is the long approved name; 1 is the short unapproved name; 2 and 3 share a display name but have different IDs. Index 4 is the additional after-only unbroken-string case.

Review of the desktop before screenshot confirms footer/list overlap and a wrapped copy action. The desktop after screenshot separates the footer and fixes the action column. The narrow after screenshot shows both approval and authentication blockers with reachable controls.

## PR #126 review ledger

The checkout remote is `narumiruna/sumire`. The current branch is the head of open PR #126. The review contains two inline findings. The review receipt and summary add no separate change request. All review and conversation pages were fetched.

| Item | Severity and scope | Independent evidence | Outcome |
| --- | --- | --- | --- |
| `4302968966` | P2; the new directory height bound defeated the PR goal of accessible rows. | A real fixture API error pushed the workspace below the 900-pixel viewport. The new regression test failed before the fix: the list had only 8 pixels of height. | Already addressed. A measured natural-scroll fallback keeps a full row usable. The test now selects rows 0, 50, and 99 after document scrolling, checks footer separation, and confirms bounded sticky scrolling returns after the error clears. |
| `4302968969` | P2; the new mobile scroll restore did not cover all detail entry actions. | Before the fix, both footer buttons restored the old row-selection scroll position. Four tests failed at 390 and 850 pixels; for example, Show selected chat restored 3029 instead of 5604 at 390 pixels. | Already addressed. `showChatDetails` records scroll before hiding the directory. Row selection and both footer actions use it. All four regression cases now restore the footer position, keep the selected ID and focus, and make no API requests or dirty settings. |

All five new regression cases failed before source changes and passed after the fix. The full browser suite passed 134 tests. Root format, lint, typecheck, build, and the final complete test rerun passed. No item was deferred. The original manual tab check remains separate and blocked as documented above.

## Limits

Manual browser verification remains open. Chromium fixture results do not certify screen-reader output, real-device behavior, remote authentication, or runtime availability. No production deployment was performed. Keep `docs/plans/2026-10-17_chat-workspace-layout-plan.md` until the manual verification has evidence or the user explicitly accepts that limitation.
