# Issue analysis — phase 2

## Scope

Collected feedback now has real, independent Pi Durable sessions. An issue starts with a
persisted initialization intent, not an invented session ID. The worker opens its private
SQLite storage, creates a root conversation and a session identity document, then projects
those committed IDs into the administration database. Initialization can be pending or fail;
the UI does not label an uninitialized intent as a running agent.

**Initialization does not call a model.** Existing issues are backfilled with local empty
sessions, without retroactive consent to send feedback to a provider. To run analysis, either
check the explicit analysis consent option when collecting feedback or select **Request
analysis** in its detail. The description, flattened screenshot, optional additional
context and prior clarification questions from this same issue are then sent to the configured shared model. Requests consume model quota.

The agent publishes 1–3 structured improvement options, or clarification questions when
intent is ambiguous. Each option contains rationale, concrete changes, tradeoffs and a
concept wireframe. All reports must state limitations. No source-code inspection is performed
in this phase: proposals are based only on the supplied feedback, not repository evidence.

Users can record or clear a choice against the latest immutable analysis version. **This
choice is not implementation approval.** No code is edited, command executed, imagegen
request made, branch pushed, PR created, merge performed or deployment triggered by this
feature. An isolated implementation worker and a separate explicit approval are phase 3.

## Core and host boundaries

- `packages/issues` owns strict report/request schemas, queue/version/selection storage and
  the inert SVG template. Its browser export contains no filesystem or model capability.
- `apps/bot/src/issues/session.ts` opens real Harness storage and registers only
  `publish_issue_proposals`. No coding tools, MCP servers, skills, execution environment,
  Telegram session, credentials or transcript are inherited by the issue conversation.
- `apps/bot/src/issues/runtime.ts` owns the bounded admission queue, one serialized session
  owner, credential/policy checks, deadlines, shutdown/cancellation and file cleanup.
- Pi Durable, not the worker, owns model turns, scheduling, retries and transcript persistence.
- `IssueAnalysisPanel` shows recorded session/conversation/submission metadata, report history,
  questions, bounded wireframes and a version-bound selection action. Session IDs identify
  committed local records; they are not a live-health guarantee or a filesystem path.

The model must call the constrained publish tool. Prose, fenced JSON and apparent markup in
an assistant answer are never parsed or repaired into proposals. The tool validates again on
replay and commits its report to a conversation document before returning. Publishing the
same report again is idempotent; replacing a committed report is rejected. The host projects
only a valid committed report while its job and issue remain authorized and active.

## Authorization and recovery

Admission requires the existing administrator session, exact Origin and CSRF. Admission is
a durable grant for that analysis, not a browser connection: logout or closing a tab does
not cancel already admitted work. Use **Cancel analysis** to withdraw it. The worker checks
that the recorded actor is still the configured administrator.

Model execution requires a successfully applied policy revision, an enabled provider, an
allowed shared-default physical model and compatible thinking level. Image feedback requires
an image-capable model. No fallback provider or model is selected. The policy revision is captured with the consented request. A queued request is blocked
if that revision changes, rather than silently adopting a different provider/model. The
physical model and thinking level are pinned when execution starts under that same revision. Credential availability is
checked under the same persisted execution deadline; local credentials alone do not prove
a successful provider request.

Authorization is checked before every actual model request and report publication. A
500 ms guard also cancels in-flight work when policy changes, the issue closes, or the
persisted deadline expires. An unrelated policy revision change intentionally blocks replay;
review current settings and make a fresh explicit request. Error responses contain fixed
reason codes, not upstream bodies, credentials or private transcript paths.

A process shutdown closes Harness storage while preserving admitted native work. Restart
reopens the same file/root identity and submits the same request ID, so an already admitted
submission is reacquired instead of duplicated. A report committed before an interrupted
projection can be projected without another model turn. If a previously linked session file
is missing or its actual identity changed, the old job fails rather than silently creating
another model conversation. A fresh explicit analysis is required.

Cancellation and policy revocation abort native conversation work; their terminal jobs are
not replayed. Native model requests already received by a provider cannot be unsent and may
still consume quota. Closed issues seal active analyses; reopening never starts another
model turn by itself. Blocked/failed/cancelled attempts require an explicit new request.

## Bounds

- One model analysis executes at a time per process; at most 32 queued/running analyses.
- At most three session attempts per issue, including blocked, cancelled and failed attempts.
  An initial empty session is reused for the first explicit request. Subsequent attempts
  receive separate private storage and do not reuse another attempt's transcript. Only the
  nearest earlier clarification questions from this issue are explicitly included as data.
- Five-minute persisted execution deadline, including provider-authentication wait. Queueing
  and local session initialization do not start model execution. Restart does not reset
  that deadline.
- Four tool rounds, one Harness retry, a 60-second stream timeout, no provider/SDK retries,
  and a requested maximum of 4,096 output tokens per model response. Providers are responsible
  for enforcing their response limits; this is not an OS sandbox or hard memory quota.
- Session disk-budget checks before opening and after analysis: 16 MiB per session including
  sidecars, 512 MiB total and a bounded directory scan. These are admission/result checks,
  not a streaming filesystem quota; an in-flight request may temporarily cross a budget.
- Description/context/report fields are independently bounded. Analysis context is at most
  4,000 characters; the JSON admission request is streamed with a 16 KiB body limit.
- The detail API returns at most three validated report records. It never exposes raw native
  entries, prompt documents, credentials, arbitrary paths or full session databases.

A full model queue does not lose collected feedback: explicit automatic-analysis collection
records a blocked intent with the capacity reason. Manual admission returns 429. Missing
model setup likewise retains the issue and its initialized session with a visible blocker.
Storage-initialization failures can leave an intent without an actual session; the UI shows
that distinction. Unrequested local-session initialization can wait behind admitted work.

## Preview safety

The agent supplies only bounded section text and a `stack`/`columns` layout. The host-owned
SVG template controls every element, attribute, coordinate and color. Text is XML-escaped,
malformed Unicode/control characters are normalized, and no URL, CSS, script, foreignObject
or model-supplied SVG/HTML is accepted. The UI displays the generated document as an image,
not executable markup. A larger scrollable wireframe dialog supports narrow screens.

A preview is a conceptual template, not a pixel-accurate design or interactive prototype.
Selecting an option stores only its analysis ID/index and optimistic revision. Later versions
cannot inherit an old choice as an authorization grant. Clarification reports have no
selectable proposal; add context and explicitly request another attempt within the limit.

## API

- `GET /api/issues/:id/analysis`: `{ available, analyses }`, newest attempt first. Availability
  describes the local worker gate, not remote model health.
- `POST /api/issues/:id/analysis`: `{ requestId, revision, context? }`; UUID retry identity and
  current issue revision. The same ID/context reacquires its admission; changed payloads
  conflict. It does not reset a failed native run or admit unlimited attempts.
- `POST /api/issues/:id/analysis/cancel`: `{ analysisId, revision }` using the analysis revision.
- `POST /api/issues/:id/analysis/select`: `{ analysisId, revision, proposal }`, where proposal
  is a zero-based index or `null` to clear. Only the latest completed version can be selected.
- `POST /api/issues` additionally accepts optional `analyze: true`; omitted/false means no
  model consent. Identical phase-one retries remain compatible when analysis is not requested.

No endpoint accepts an execution command, model override, client session ID or implementation
flag. Existing authenticated issue reads/close/reopen/deletion retain their original routes.
The browser freezes an ambiguous admission payload and retries its UUID unchanged. A new
explicit request is a new attempt, not an automatic retry after an uncertain response.

While a visible detail is initializing/queued/running, the panel makes bounded three-second
metadata refreshes (up to 120 polls); visibility restoration and manual refresh can read
again. These reads do not create sessions or start model work. Extra context not yet submitted
is a page-local draft, not saved configuration, and is discarded when leaving the page.

## Privacy, deletion and rollback

Private session files live under `.telegramagent/issues/` beside the admin database, under
a mode-0700 directory with mode-0600 SQLite database files. They contain descriptions,
screenshots and model outputs, so include them in private backup/retention policy, never Git.
The model receives only the particular approved feedback/context, not other issue records,
chat logs, secrets, current policy or provider credentials.

Issue deletion atomically removes report/context projections and records session keys in a
cleanup outbox. Active work is stopped before the live files and WAL/SHM sidecars are removed.
Cleanup receipts survive crashes and resume on startup; a failed HTTP response can follow a
committed database deletion. Refresh before asserting an outcome. Secure SQLite deletion and
unlinking files do not erase backups, snapshots, provider-side copies or filesystem recovery.

The additive `feedback_analyses` and `feedback_analysis_gc` tables and deletion trigger are
initialized in the existing admin migration transaction. No policy schema, environment
variable or GitHub permission is added. A deletion trigger also lets the older phase-one
adapter delete a parent issue without violating new foreign keys; file cleanup remains
queued until the phase-two worker runs again.

For rollback, cancel active analyses and confirm their terminal status before stopping the
service, then roll back bot/admin/core together. A mere shutdown preserves pending jobs.
Older builds do not run the issue worker or remove native files. Retained cleanup receipts
are processed on a future upgrade; an administrator must handle private retention separately
if permanently staying on an older build. Do not restore a stale settings database to roll
back a display change. No implementation/PR worker exists to drain in this phase.

## Verification

Offline tests use a local synthetic provider over real Harness SQLite submit/wait/commit APIs.
They cover real empty initialization, persisted identity and submission reuse, shutdown and
restart, native cancellation, policy-revocation abort, persisted deadlines including auth
waits, unsupported image input, session loss, disk-budget failure, invalid/prose reports,
version-bound selection, cleanup receipts, old-adapter deletion compatibility and API
Origin/CSRF/ancestry checks. They do not spend real model quota or authorize live execution.

Playwright tests intercept all administration API traffic and cover desktop/mobile proposal
comparison, inert SVGs, larger previews, explicit collection consent, idempotent analysis
admission, cancellation and original screenshot workflows. These tests are not proof of
live deployment, provider entitlement, Safari/iOS compatibility or remote cancellation.

### Local validation results

- Root `npm run format:check`, `npm run lint`, `npm run typecheck`, and `npm run build` passed.
- All **4,171** unit/integration tests passed with
  `npm test -- -- --maxWorkers=4 --testTimeout=60000 --retry=1`.
- **131** Playwright cases passed across `tests/issues.spec.ts`, `tests/i18n.spec.ts`, and
  `tests/admin.spec.ts`; the **21** issue cases were rerun after the final changes and passed.
- `git diff --check` and changeset status validation passed.
- Docker is unavailable locally. Container assembly, live provider behavior and deployment
  remain unverified; no real model quota, image generation or implementation worker was used.

Review regressions also cover resize-during-capture, multi-pointer ownership, exact image
bytes, stopped/timed-out submissions, rejected uncertain retries, stale detail/mutation
responses, independent list errors, decoded attachment retries, pre-inflation budgets,
case-normalized UUID retries, SQLite auto-rollback errors and unfinished oversized uploads.
