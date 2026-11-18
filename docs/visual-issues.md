# Visual feedback / Issues — collection and analysis

## Delivered collection scope

- An authenticated global lower-left feedback entry opens screenshot, upload, and text tools.
- Screenshots are DOM-based, frozen into a local canvas, with pen, box, opaque redaction,
  crop, undo, and a mandatory final-image preview before image submission.
- Text is optional for images; text-only feedback is supported. Empty feedback is rejected.
- Issues appear in the sidebar, with paginated/filterable metadata, details, screenshot,
  revision-checked close/reopen, and confirmed permanent deletion.
- `packages/issues` owns browser-safe contracts and the host-owned SQLite storage adapter.
- Real independent Durable sessions, explicit model-analysis consent, structured proposals
  and version-bound choices are described in [phase 2](issue-analysis.md). Implementation
  jobs and GitHub PR execution remain unimplemented; no fake agent/session status is shown.

## Privacy and limits

The current WebUI remains single-administrator, behind existing Passkey sessions. There
is no public or Telegram-user submission endpoint. All issue and image reads require the
same administrator session; writes also require exact Origin and CSRF checks. Images use
`no-store`, a raster MIME type, and the existing defensive CSP. Lists and detail JSON never
embed image bytes. Audit events contain operation/issue ID, not descriptions or screenshots.

Automatic capture is disabled on Conversation logs and Secrets & variables. Capture filters
omit form controls, contenteditable regions, private-marked nodes, feedback UI, hidden
sections, media/iframes and external image elements. These filters are not complete PII
recognition: visible names, text, chat information, and other private content can remain.
Always inspect and redact the preview. Source metadata includes only section and viewport;
no raw DOM, URL/query/fragment, local storage, session token or input values are submitted.
Only the flattened final crop is uploaded, never the original screenshot or editable layers.
Uploaded images are decoded into canvas and re-encoded, rather than retaining file metadata.

Browser uploads accept PNG/JPEG/WebP up to 8 MiB, 16 megapixels and 8192 pixels per side;
they are scaled to at most 2000 pixels per side. Final images must be at most 2 MiB. The
server independently verifies static PNG/JPEG/WebP container bytes, dimensions (4096 per
side, 4 megapixels) and payload bounds. It uses the existing imagegen raster validator,
which is not a complete JPEG/WebP entropy decoder. JSON requests are bounded to 3 MiB
while streaming. Collection has a per-admin 10/minute budget in addition to general limits.
Capture expires after 15 seconds with upload/text fallback. DOM capture can omit or differ
from browser-rendered content, especially fonts, remote media, complex CSS and embedded
content; it is not a browser-native screen capture. A page change during preparation
rejects the local capture rather than attaching misleading source metadata.

The SQLite adapter caps 1000 live issues and 64 MiB live attachments. Close does not free
quota; deletion does. There is no automatic retention job. Deletion does not purge backups
or snapshots. The administrator must configure backup retention independently.

## API

- `GET /api/issues?state=open|closed&before=<id>`: 25 rows, optional next cursor.
- `POST /api/issues`: UUID `requestId`, optional `description`/Base64 `screenshot`, and
  `source: { section, viewport: { width, height } }`. At least image or description is required.
  Returns 201 for creation, 200 for an identical retry, 409 for a mismatched retry.
- `GET /api/issues/:id`: detail without attachment bytes.
- `GET /api/issues/:id/screenshot`: authenticated static raster bytes.
- `PUT /api/issues/:id`: `{ revision, state: "open" | "closed" }`.
- `DELETE /api/issues/:id`: `{ revision }`; hard deletion of feedback and attachment.

An uncertain browser submission freezes its payload and reuses the same UUID on retry.
Deduplication applies while that issue exists, not after it is permanently deleted. Drafts
are in browser memory only and clear on logout/session expiry. Cross-page navigation keeps
an open feedback draft; reload/tab close warns but does not persist it. Issue list and detail
reads are manual, not polling. Network failures during update/deletion require refresh to
confirm server state; a failed response is not claimed as a successful operation.

## Storage / rollout / rollback

No new environment variables, credentials, or GitHub permissions are needed. Build bot,
admin and the new package together; Docker stages include the workspace manifest and
compiled core. The additive `feedback_issues` table is initialized in the existing admin
SQLite migration transaction; the table does not change policy schema or revisions. Existing
settings application and Telegram sessions are unaffected. Back up the protected admin DB
before rollout and verify the host reverse proxy accepts the bounded screenshot payload.
Do not enable request-body logging. Private screenshot data is part of the admin backup.

Rollback bot/admin together to the previous build. Older code ignores the additive table;
collected feedback remains on disk without old-build routes. Do not restore a stale settings
snapshot just to remove the UI. With phase-two analysis enabled, cancel admitted jobs before
rollback and follow its separate session-file cleanup instructions.

## Verification

Unit coverage: strict feedback contracts, persistence, actor-scoped idempotency, optimistic
revisions, metadata projections, cursor pagination, count quota, deletion, audit rollback,
and scaled pointer/crop geometry. HTTP coverage: authentication, CSRF/Origin, screenshot
validation/privacy, streamed body bounds, filter validation and lifecycle operations.

`npm run test:browser --workspace @narumitw/sumire-admin -- tests/issues.spec.ts` uses only
intercepted synthetic API traffic. It covers desktop/mobile text collection, issue management,
actual DOM capture → drawing/redaction → crop → final PNG submission, sensitive-page capture
restriction, uncertain-submit retry and expired-session draft clearing. It is not evidence of
live deployment, Safari/iOS compatibility, or reverse-proxy payload configuration.

### Phase-one local validation results

- Root `format:check`, `lint`, `typecheck`, and `build` passed.
- All 3,297 unit/integration tests passed with
  `npm test -- -- --maxWorkers=4 --testTimeout=60000 --retry=1`.
- The 7 new intercepted-API browser tests passed, including redaction pixel verification.
- The unadjusted root test run hit several 5-second timeouts under SQLite-heavy concurrency;
  an intermediate bounded-worker run also encountered one GitHub-auth HTTP `ECONNRESET`.
  The affected HTTP tests passed on an isolated rerun. No production timeout was changed.
- Docker is unavailable in the local environment, so the container target was not built.
  The CI container job must verify the updated production stages. No live deployment,
  real screenshots, real issue submissions, model calls, or GitHub workflow actions were
  exercised by the test fixtures.

## Analysis and remaining implementation work

[Phase 2](issue-analysis.md) adds real Durable sessions, consented model admission,
clarification/proposal reports, bounded inert wireframes and recorded choices. It does not
read repository source or implement a selected proposal. Use its rollout/retention guidance
for native session data and active work; the phase-one results above are historical.

The remaining phase must explicitly approve an immutable proposal version for
`narumiruna/sumire`, then use a secret-free isolated development worker and restricted
publisher. A git worktree is not a security sandbox. Reconcile ambiguous GitHub results
before retrying mutations. Never inherit Telegram tool permissions, push to main, auto-merge
or deploy. A stored phase-two choice alone must never authorize any of these actions.
