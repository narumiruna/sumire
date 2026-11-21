# Scheduled tasks

## Scope and interface

The administration **Schedule** page (`?section=Schedule`) manages scheduled **user messages**, not shell commands or a second agent loop. It supports adding, deleting, pausing, and resuming tasks. Results are delivered to the selected Telegram chat through the existing delivery and recovery paths. There is no deployment, automatic task creation, Telegram scheduling command, or agent-facing schedule mutation tool in this change.

The page follows the shared reading-first design: one primary **Add task** action, an inline draft editor, status filtering, and cards showing the literal message, target chat, next planned time, repeat interval, last attempt, and relevant actions. Navigation retains an unfinished draft in memory; the existing pending-editor bar can return to it. Expiry, sign-out, or reload does not persist that draft. The task text is rendered as escaped text, not HTML or Markdown. English, Traditional Chinese, and Japanese catalogs cover the new page.

Creating a task requires:

- **Task (user message)**: nonblank text, at most 8,000 UTF-16 code units.
- **Target chat**: an existing chat currently allowed by the applied policy. The selector uses saved access, not an unsaved policy draft. If the selected chat loses access while the editor is open, the selector and preview switch to the first remaining allowed chat. Creating a task does not grant chat or tool access.
- **First execution**: a future date and time in this browser's time zone. The editor previews the actual UTC offset and destination before submission.
- **Repeat**: once, every hour, every 24 hours, or every 7 days.

Stored instants are Unix milliseconds. The browser's resolved time zone is saved for presentation; it is not a free-form date parser. Invalid dates and nonexistent spring-forward times are rejected. For an ambiguous fall-back hour, JavaScript selects the earlier instant, whose offset is visible in the preview. Recurrence is a fixed elapsed-time interval, **not cron or a fixed local clock time**: after a DST change a 24-hour recurrence can move by one local clock hour. There is no separate timezone selector, arbitrary interval, or cron editor in this first version.

## Execution and lifecycle

Schedules live in the existing private `admin.sqlite` database. Initialization creates an additive `scheduled_tasks` table in the AdminStore transaction. No new environment variables or service are required. The application retains its single-process storage ownership; the dispatcher starts only after Telegram initialization and the existing durable recovery discovery.

The dispatcher polls once per second and admits at most **one task at a time**. A due task may wait for other scheduled work and for the chat's current main turn, so the planned instant is not an exact execution-time guarantee. Checks use the applied chat policy again before sending a status message, admitting model work, and delivering a response. `/reset` and `/cancel` invalidate pending scheduled submissions and live scheduled delivery for that chat.

A real bot-created Telegram status message anchors recovery. The submitted message contains the literal task and host-owned schedule metadata, explicitly without asserting a Telegram sender identity. It enters `ChatSessionRegistry.submit` with `routing: main`, `intent: newTurn`, and the existing durable outbox delivery descriptor. Pi Durable continues to own model turns, tools, retries, transcript storage, and recovery. Model settings, tool permissions, and tool replay-safety boundaries are unchanged. `/f` or other command-looking text is submitted as user text, not routed through Telegram command handlers.

- **Once**: a successful reply completes the schedule. An overdue task not previously claimed runs once when the bot returns.
- **Repeating**: after downtime, at most one overdue attempt is dispatched; after it finishes, the next instant follows the original cadence and is later than both the claimed occurrence and the current clock time. A backward clock change cannot make a completed occurrence eligible again. Missed intervals are never replayed in a burst. Repeating tasks do not overlap their own work.
- **Pause**: prevents subsequent dispatches. Already dispatched work, including a chat-queued turn, is not cancelled. If the current repeating attempt completes, the schedule remains paused.
- **Resume**: rechecks access. An unclaimed overdue once-only task is eligible immediately, with explicit UI confirmation. A repeating task skips to its next future interval. A task still running cannot be resumed.
- **Delete**: requires confirmation and an exact revision; it is irreversible. It removes the scheduling record but does not abort dispatched work or delete its chat transcript/outbox. Already admitted work can still send a reply. A late completion cannot recreate a deleted record.

A successful status means a model answer was delivered, **not** that every requested external action succeeded. Interrupted tools and Telegram sends retain their existing replay and ambiguous-delivery limitations; this feature does not promise exactly-once execution or delivery.

## Failure and restart safety

Each attempt is claimed durably **before** external I/O, with a unique run receipt and a revision increment. Failures pause the schedule instead of automatically re-admitting a potentially side-effecting message. A failed one-time attempt cannot be resumed: inspect the chat and external effects, then explicitly create a replacement if needed. A failed repeating schedule can be resumed for the next future interval, not to retry the old attempt.

If the database cannot record a result, the dispatcher keeps the receipt and result in memory. It retries only that database write before claiming more work. It never reruns the task to record its result.

Shutdown first stops the dispatcher. It does not await or abort a model from the scheduling layer; existing registry shutdown preserves admitted work. Stopped callbacks never write back to AdminStore after it may have closed.

At startup, abandoned `running` receipts become **paused / outcome unknown** and cannot be resumed. The scheduler never resubmits them. Pi can independently recover the already-admitted turn or its unsent answer through the normal outbox, so inspect the target chat before scheduling a replacement. A crash between the claim and durable admission can leave an attempt unexecuted but still marked unknown: manual review is intentionally preferred over unsafe replay. Recovered deliveries do not rewrite the scheduler's historical failed/unknown result.

## API and storage bounds

All endpoints require the current passkey administrator session. Mutations retain the common exact-Origin, CSRF, JSON, streamed body-size, and write-rate checks. The session is rechecked after the request body has been read. Issues MCP bearer tokens do not grant access to these routes.

| Method | Endpoint | Body / result |
| --- | --- | --- |
| GET | `/api/schedules` | `{ items, limit: 100 }`; no query parameters |
| POST | `/api/schedules` | `{ requestId, chatId, task, runAt, timeZone, repeatMinutes }`; returns the task |
| PUT | `/api/schedules/:id` | `{ revision, action: "pause" or "resume" }`; returns the new revision |
| DELETE | `/api/schedules/:id` | `{ revision }`; returns `{ deleted: true }` |

`repeatMinutes` is `null`, `60`, `1440`, or `10080`. `requestId` is a UUID reused for an unchanged creation retry. While the record exists, an identical retry returns that task rather than creating another; changed content or actor under the same key conflicts. The key is not an unbounded tombstone store after deletion. Normal stale mutation revisions return 409; refresh before acting again. The browser does not automatically retry writes and reuses the unchanged creation key after an ambiguous network failure.

At most **100 tasks**, including completed entries, are retained; delete old entries to release space. The bounded list refreshes every five seconds only while the page is active and the document visible. The task payload is private persisted user content, like a chat transcript; do not put credentials in tasks. Audit values and new scheduler logs contain operation/receipt identifiers and outcomes, never task text or raw upstream exceptions.

## Verification boundaries

Automated coverage lives in:

- `apps/bot/tests/schedules.test.ts`: validation, access, revisions, transaction rollback, bounds, cadence, pause/delete during a claim, failure, actual SQLite reopen, abandoned receipts, dispatch concurrency, and shutdown.
- `apps/bot/tests/schedules-api.test.ts`: authenticated CRUD, creation deduplication, strict schemas, origin/CSRF/session enforcement, body bounds, and unsupported methods.
- `apps/bot/tests/scheduled-task.test.ts`: registry/outbox transport contract, real Telegram message anchors, channel contexts, media delegation, acknowledgement, and fail-closed checks.
- `apps/bot/tests/scheduled-task-durable.test.ts`: real Pi Durable and SQLite with a **loopback-only synthetic model**, including recovery of an unsent answer without another model turn.
- `apps/web/src/schedule-time.test.ts`: UTC conversion, invalid dates, DST gap/fold behavior, and saved-zone presentation.
- `apps/web/tests/schedules.spec.ts`: synthetic intercepted-API CRUD at 320/390/1440 px, literal text, creation retry, drafts/deep links, overdue confirmation, unknown outcomes, and localized mobile layouts.

Adding the navigation destination also requires keeping the feedback launcher clear of the rail controls. Desktop feedback placement follows the expanded/compact sidebar width, including the 200 px intermediate layout; the mobile placement is unchanged. Browser regressions exercise both rail states and existing pending-save controls.

Local verification: root formatting, lint, type checking, and production build passed. The selected browser regression run passed **71 tests** across scheduling, reading-first layout, localization, usability, and navigation/discard flows. All **4,249 distinct workspace unit cases** have successful runs, but **not in a single clean default run**: the default five-second run hit capacity-test timeouts; a four-worker run with a 30-second timeout passed 4,248 cases and hit `ECONNRESET` in the existing `issue-mcp.test.ts` capacity scenario. That complete file then passed **18/18** in isolation with one worker. No test timeout, network behavior, or unrelated test implementation was changed to hide these results.

Browser screenshots remain local under `/tmp`; they are neither committed nor attached to the PR. Tests do not call a real model, create real Telegram schedules, or verify production uptime, delivery timing, quota, or remote deployment.
