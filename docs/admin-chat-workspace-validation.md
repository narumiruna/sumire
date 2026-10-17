# Chat workspace validation

## Scope

All browser requests use isolated API fixtures. No production settings, data, credentials, Telegram requests, or remote model checks were used. Policy calculations, API contracts, permissions, and save boundaries are unchanged.

## Changes

- The directory uses header, scrollable list, and footer grid regions. Only the list scrolls on desktop. The sticky directory height uses its measured document position and the existing save-status height, not a title-dependent offset. Measurement updates run outside the ResizeObserver delivery and are cancelled on cleanup.
- Detail content uses document scrolling. Narrow and short viewports use natural directory scrolling. Returning to the narrow directory restores its document scroll position and focuses the selected row without scrolling it again.
- The header reserves separate title/metadata and copy-action columns. Narrow screens stack them. Row titles have a two-line limit; their full text remains in the accessible button name and title attribute.
- Approval badges use distinct text and check/minus icons. Readiness keeps the existing blocker conditions and shows each blocker with its action. Secondary approval, enablement, configuration, verification, application, and technical caveats are in the Readiness details disclosure.

## Tab investigation

Before changing source, `chat-workspace.spec.ts` clicked Access, History, and Overview at 1440 and 390 CSS pixels. Each selected the matching panel. Keyboard End selected History. Switching chats retained the selected tab and updated the ID. There were no additional API requests or dirty settings. The four baseline screenshot/interaction tests passed.

The final suite repeats these checks. Inspection found controlled Radix tabs with `onValueChange`, matching trigger/content values, and inactive panels hidden. The automated failure was not reproducible; tab handlers and state logic were not changed.

**Manual reproduction remains blocked.** The Chrome DevTools tool could not start because its configured Chromium executable `/home/narumi/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome` does not exist. A local fixture-only server was prepared, then stopped. Headless Playwright uses a working local Chromium installation; this does not replace manual verification. Repeat Access/History clicks in an available manual browser before closing the saved plan.

## Regression evidence

`apps/admin/tests/chat-workspace.spec.ts` adds eight tests:

- Desktop/narrow screenshots of an approved long emoji/CJK supergroup, a short unapproved group, and two same-name groups with different IDs. Additional after screenshots cover an unbroken title.
- Click and keyboard tab selection, one visible matching panel, retained tab on chat switch, no requests from navigation, and no dirty policy.
- Layout/readiness at 1440, 390, and 320 CSS pixels: no horizontal overflow, stable desktop copy-action alignment, narrow stacking, full title accessibility, selected-row ID, visible keyboard focus, explicit missing-authentication action, both actions for unapproved chats, and distinct expandable status fields.
- All 100 desktop rows can be fully revealed above the footer. Clicking visible rows preserves list scroll position. Returning to the narrow directory preserves document scroll position and focuses the selected row.
- Expanded onboarding remains outside the list. At 600 pixels high, the desktop directory uses natural document scrolling. Disabled previous-page controls remain disabled; screenshot review confirms their disabled appearance.

The existing narrow keyboard-navigation test now expects focus on the selected row when returning from details, rather than resetting focus to search. Other existing tests retain filter, pagination, policy editing, application, draft, and session-expiry coverage.

## Commands and results

Node.js 26.10.0:

- Root `npm run format:check`, `npm run lint`, `npm run typecheck`, and `npm run build`: passed.
- Root `npm test`: final full rerun passed, 1,475 tests. The first run failed two unrelated bot MCP SIGTERM cases at their existing 5-second timeout, followed by cleanup assertions. An isolated rerun passed all 13 MCP-session tests; the subsequent complete root rerun passed. No bot code or timeout was changed.
- `npm run test:browser --workspace @narumitw/sumire-admin -- --output=/tmp/sumire-chat-after`: 129 passed. No ResizeObserver errors were reported in the final run.
- `git diff --check`: passed.

The initial new layout tests failed because the test refocused Copy chat ID before pressing Shift+Tab. Using the page keyboard corrected the test. An early measurement implementation also generated ResizeObserver notifications; deferred, change-only updates corrected that issue. Final layout tests assert no page errors.

## Screenshots

Local artifacts are not committed:

- Before: `/tmp/sumire-chat-before/chat-workspace-chat-screenshots-at-{1440,390}px/`
- After: `/tmp/sumire-chat-after/chat-workspace-chat-screenshots-at-{1440,390}px/`
- Names: `before-directory-WIDTH.png`, `before-chat-INDEX-WIDTH.png`, and matching `after-...` files. Index 0 is the long approved name; 1 is the short unapproved name; 2 and 3 share a display name but have different IDs. Index 4 is the additional after-only unbroken-string case.

Review of the desktop before screenshot confirms footer/list overlap and a wrapped copy action. The desktop after screenshot separates the footer and fixes the action column. The narrow after screenshot shows both approval and authentication blockers with reachable controls.

## Limits

Manual browser verification remains open. Chromium fixture results do not certify screen-reader output, real-device behavior, remote authentication, or runtime availability. No production deployment was performed. Keep `docs/plans/2026-10-17_chat-workspace-layout-plan.md` until the manual verification has evidence or the user explicitly accepts that limitation.
