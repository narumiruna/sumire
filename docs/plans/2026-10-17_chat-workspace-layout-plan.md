# Chat workspace layout plan

## Goal

Correct administration chat layout and readiness presentation without changing policy, APIs, permissions, or configuration semantics. Investigate selected-chat tabs independently before changing their behavior.

## Context

- `apps/admin/src/chats.tsx` owns directory, readiness, header, and controlled Radix tabs.
- `apps/admin/src/styles.css` previously made the directory a shrinking flex column with outer scrolling; the list had no dedicated scroll region. The header wrapped its action according to title width.
- Fixture-based browser coverage does not contact production.
- Existing unrelated plans and `.changeset/chat-access-migration-plans.md` remain untouched.

## Plan

- [x] Capture baseline desktop/narrow screenshots with long CJK/emoji, short, and duplicate-name group fixtures; test Access/History clicks before changing source. Evidence: four baseline tests passed; screenshots in `/tmp/sumire-chat-before/`.
- [ ] Reproduce Access/History clicks manually before considering a tab fix. Blocked: Chrome DevTools cannot start its configured Chromium executable. Automated reproduction did not fail, so tab handlers and state remain unchanged. Requires a working manual browser or explicit user acceptance of this limit.
- [x] Separate directory header, scrolling list, and footer; stabilize header and row titles. Evidence: geometry for all 100 rows, expanded footer, selection by ID, desktop/narrow scroll retention, overflow, focus, disabled controls, and short-screen scrolling pass in `chat-workspace.spec.ts`.
- [x] Present readiness blockers and actions first; move secondary status and caveats into a disclosure while preserving existing blocker conditions. Evidence: 1440/390/320-pixel tests check missing authentication, approval plus authentication, actions, and separate status fields.
- [x] Add regression coverage, capture matching after screenshots, and document tab investigation evidence and limitations. Evidence: 13 new tests; initial screenshots in `/tmp/sumire-chat-after/`, review-run screenshots in `/tmp/sumire-pr126-browser/`; `docs/admin-chat-workspace-validation.md`.
- [x] Fix both P2 review findings with regression evidence. Tall API-error layout and both mobile footer actions failed in five new cases before source changes. All five now pass; the review ledger records each outcome.
- [x] Add an admin patch changeset and run repository checks. Evidence: `.changeset/chat-workspace-layout.md`; final root checks pass, with the initial MCP timeout failures and successful reruns documented.

## Completion Checklist

- [x] Fixture browser tests pass at desktop and narrow widths, including navigation without writes or remote verification. Final suite: 134 passed.
- [x] Root `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` pass; `git diff --check` passes. Final root test rerun: 1,475 passed.
- [ ] Complete manual browser tab verification or obtain explicit acceptance of the unavailable check.
- [x] Prepare changed paths, actual test results, screenshot locations, and remaining limitations for handoff in `docs/admin-chat-workspace-validation.md`.

## Risks

Narrow and short viewports use natural document scrolling. Screenshots are local test artifacts, not committed binary files. Fixture evidence does not establish remote authentication or runtime availability. Manual verification is the only remaining acceptance gap; keep this plan until it is resolved or explicitly accepted.
