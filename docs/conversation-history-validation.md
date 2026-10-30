# Conversation History Validation

## Scope

Conversation records opens a saved-message History inspired by `pi-inspect`'s History and Event details. It uses Sumire's existing administrator session, chat scope, read lease, and Pi Durable storage owner. It does not load the Pi CLI extension, create an AgentSession, open unloaded databases, capture provider requests, or change the selected conversation.

## Data and interaction rules

- History reads exactly one native entry page. Native order is descending creation ID, with ancestor entries capped at each inclusive fork point. The browser reverses the page for reading and does not sort message timestamps.
- Only native `pi.user` entries start user-turn groups. Leading records retain a page-boundary explanation; passive context, compaction, and unknown user-role entries do not create an addressed turn.
- Inherited entries keep their origin conversation ID. Entry details are resolved in the inspected branch, not the origin branch, so sibling and post-fork ancestor entries remain unavailable.
- Search and record filters cover only the loaded page. They do not trigger a full-session scan. Detail selection and browser history between entries in the same History conversation retain the page and filters; explicit older/newer navigation clears local selection. A different conversation or raw-object context starts at the first page.
- Message bodies are literal text. Thinking and inline tool arguments/output start collapsed. Images expose MIME metadata only. Metadata, approved document values, and content JSON retain separate disclosures. Saved text can contain sensitive data; this projection is not general secret redaction. Restrict administrator and clipboard access.
- History and explicit entry reads use the existing content projection: at most 128 KiB, 256 messages/blocks, and 16 KiB per text/argument field per entry. Responses remain within 256 KiB and cursors within 4 KiB. Truncation is explicit.
- Entry continuation tokens retain a maximum entry ID. New appends do not shift response-overflow replay offsets; Refresh reads new entries. This is not an atomic snapshot.
- Detail reads are serialized with other reads for the chat. Navigation, chat replacement, and session expiry cancel owned requests. Permission and unloaded-owner states do not retain old content.

## Verification

Verification uses synthetic messages and local browser fixtures, not production conversations or provider requests. The root checks passed on 2026-10-30:

| Command | Result |
| --- | --- |
| `npm run format:check` | Passed. |
| `npm run lint` | Passed; one existing `useDomNodeTextContent` warning in `durable-workspace-visual.spec.ts` remains unchanged. |
| `npm run typecheck` | Passed. |
| `npm test` | 3,067 tests passed across 188 test files. |
| `npm run build` | Passed for all workspaces. |
| `npm run changeset -- status` | Minor changesets cover admin, bot, and contracts. |

Focused checks also passed: 26 frontend content/navigation/grouping tests, 54 bot inspector/content/HTTP/lifecycle tests, and 2 contracts tests. Root logs are temporary `/tmp/sumire-conversation-history-{format-check,lint,typecheck,test,build}.log` artifacts.

All 100 browser tests passed in the final stable run: 25 History tests, 50 inspector tests, 7 entry-content tests, and 18 workspace geometry/contrast tests. They cover default and historical targets, ordering, literal content, page/filter retention, deep links and back/forward, inherited scope, pending-read cancellation, authentication expiry, not-loaded/409 invalidation, and 320 px dialog focus/overflow. Existing workspace checks retain their first-fold, font, contrast, and geometry assertions. The log is `/tmp/sumire-history-all-browser.log`.

Browser verification uses the existing Chromium fixtures with four workers and an isolated temporary configuration on port 17469. The existing service on the default port was not stopped or reused. Do not run dependency-emitting root checks during this Vite browser run; changing shared build output can reload open test pages.

```sh
npm run test:browser --workspace @narumitw/sumire-admin -- \
  tests/durable-history.spec.ts tests/durable-inspector.spec.ts \
  tests/durable-content.spec.ts tests/durable-workspace-visual.spec.ts \
  --config=/tmp/sumire-history-playwright.config.mjs
```

The temporary configuration imports the repository's Playwright configuration, uses an absolute test directory, changes only the development server/base URL, sets four workers, and writes results under `/tmp/sumire-history-browser-results`. It is not runtime configuration. Without an occupied default port, the same suite can use the tracked Playwright configuration.

Synthetic screenshot artifacts are temporary and are not committed:

- `/tmp/sumire-history-1440.png`: desktop History with literal content, turn groups, and collapsed tool data.
- `/tmp/sumire-history-320-dialog.png`: narrow Event details with inspected scope and no horizontal overflow.
- `/tmp/sumire-history-branch-before.png` and `/tmp/sumire-history-branch-after.png`: Branch view followed by History for the same historical conversation, with the persisted selection unchanged. These compare two views of the updated build, not pre-change and post-change binaries.

The screenshots support layout review, not subjective usability acceptance. `npm ci` reported four existing dependency advisories (one moderate and three high); this change does not modify dependency versions or the lockfile.

## Remaining limits

Saved entry history is not a complete Telegram archive or an exact model request. It does not apply context edits or head ranges, expose internal document payloads, or recover uncaptured request-local changes. The existing native allocation limit remains: SQLite materializes complete records before bounded projection, and cancellation cannot interrupt synchronous SQLite/JSON work. Existing owner leases remain held until native reads settle.

No durable schema, runtime environment variable, dependency, or credential setup changes are required. Roll back matching admin, bot, and contracts builds together after admitted reads drain; do not restore a database backup or abort agent work for this display-only rollback.

## External handoff

The deployment administrator can review the deployed History and Event details with an existing Passkey and a loaded chat after deploying the matching builds. Expected results are readable saved content, unchanged persisted selection, and no model/tool work from inspection. Real-device Passkey behavior and subjective usability are not verified by synthetic browser checks. This is deployment review, not a required credential migration; no production deployment or external write was performed for this change.
