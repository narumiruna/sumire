# Chat management mobile redesign

The chat directory follows the supplied mobile reference: a compact Sumire header,
Traditional Chinese heading and count, search and filter controls, three saved-state
segments, and individual chat cards. Desktop layouts reuse the cards in two columns.

## Visual validation

Responsive layouts were checked in Chromium using synthetic, intercepted API
responses. No production chat data, screenshots or image attachments are included
in this pull request.

## Interaction and safety

- Cards show the name, saved approval/enablement status, model display name, source
  and a settings action. IDs and technical diagnostics remain in details/menus.
- An enabled badge means saved policy permits the chat, not that a remote model
  response has been verified. Configuration problems have a separate repair action.
- Approvals and revocations remain staged until the existing review-and-save
  transaction. Cards keep showing saved state and explicitly label pending changes.
- Status/type filters use saved policy; search is server-side and pagination remains
  bounded to 100 records. Filters retain manual-ID configuration and advanced access
  filtering, including approved-but-disabled chats.
- Clean save/revision information is folded below management, rather than occupying
  the top of the screen. Completed operations briefly show save feedback. Pending,
  failed and uncertain application states remain visible and actionable.
- Compact action surfaces retain 44px button hit boxes; keyboard menus, native
  modified-link navigation, directory focus/scroll restoration and hidden-section
  cleanup remain covered by browser tests.

## Verification

```sh
npm run format:check
npm run lint
npm run typecheck
npm run build
npm test --workspaces --if-present -- --maxWorkers=2 --testTimeout=20000
npm run test:browser --workspace @narumitw/sumire-admin -- tests/chat-cards.spec.ts --workers=2
```

All 3,270 workspace unit tests passed with bounded concurrency and a 20s per-test
limit. The default 5s test limit timed out on unrelated filesystem-heavy bot tests
in this environment; no backend timeout policy or test assertions were changed.

Browser regression suites were also run in groups for directory/access/workspace
state, settings, keyboard navigation, usability and responsive layouts. A single
unbounded full browser run exceeded the environment's 15-minute execution limit;
this is not a claim that one complete full-suite run passed. Stale layout assertions
identified by that run were migrated and retested in the focused groups.
