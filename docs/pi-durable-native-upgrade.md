# Native Pi Durable upgrade

## Ownership and contracts

Pi Durable 1.5.2 owns model turns, direct and nested tool tasks, script journals, retries, compaction, and transcript storage. Sumire owns Telegram routing, delivery intents, live authorization, MCP transport, and capability limits.

- Coding tools use `@earendil-works/pi-durable/tools` and a Harness execution environment.
  - Bash receives an explicit shell environment with inheritance disabled. Administrator and provider credentials are excluded.
  - Bash program results use `exitCode` and `fullOutputPath`, not `exit_code` and `full_output_path`. A nonzero exit retains structured output and reports an error to the model.
  - The read adapter declares a text-or-image output schema. Native codemode otherwise drops schema-less images. The native image processor retains model image limits and BMP conversion.
- Native codemode always uses `models: false`. Scripts cannot call `update_progress`, `read_image`, or hidden tools.
- Tool discovery does not grant access. Live chat and tool permissions apply at execution, including recovery. MCP also checks server access and connection identity. Model requests and capabilities remain blocked during startup until changed-trust conversations have all been cancelled.
- A task memo saves an absolute host deadline before discovery or VM admission. Script options can shorten, but cannot extend, that deadline. Each nested execution checks it again. Native success transactions check the deadline before and after their callback, so slow output formatting cannot commit late store writes. A success already committed before a crash remains successful after its deadline passes.
- Another memo saves the admitted capability generations and namespace aliases. Direct model requests save generations from the tool declarations committed during preparation, not from the later live registry. A host-owned schema annotation carries this identity in stored declarations and is removed before provider requests. Neither a retained script handle nor a pending direct call can call a same-name MCP replacement. After restart, a new MCP connection also invalidates unfinished old selections; start new work after inspecting effects.
- Each script owns its sandbox. Shutdown requests worker termination and waits for actual worker exit before Harness and SQLite shutdown finish.
- Only model-facing output and UI details enter the transcript. Program-only structured results remain on native nested task channels. A caller does not count a child's reported usage again.

The host adapters do not schedule nested calls or implement a second model loop. One Harness owns each chat's SQLite storage, including main, branch, and article conversations. Conversation isolation does not isolate filesystem, credentials, or process resources.

### Session-routing contracts

- Each `/f`, including in a private chat, creates a fresh native conversation with only its explicit article source and attachments. It is not a shared-conversation `newTurn` or a fork of main. `/f` takes priority over reply routing.
- Addressed non-reply group input uses stable main in arrival order, without implicit steering. Group replies always fork the mapped user-input or bot-answer checkpoint, including branch/article sources and the current leaf. Separate replies to one source create separate forks, not a shared branch.
- Source user messages map to actual input entries, passive messages to actual write entries, and final output/retained progress to the submission's answer entry. Pending input/status replies wait only for that source request's necessary settlement; synthetic status text is excluded.
  - Correlation with a visible status whose send acknowledgement is still pending has a fixed two-second transport bound. Unresolved ambiguous replies return unavailable, not progress text as article source. Unrelated non-reply input does not wait for this correlation.
  - Passive writes retain a typed source message ID. After a lost reply-index write, lookup can inspect up to 1,000 recent main entries for that exact source; otherwise the no-history fallback applies.
- Unknown, invalid, wrong-session, evicted, or disabled mappings use a fresh no-history reply conversation with bounded Telegram reply context. Failed/cancelled dependencies without a valid checkpoint use the same fallback, never the current main leaf.
- Passive group context goes only to main. Forks do not receive passive context after their checkpoint; articles receive none. Existing addressing, multiple-bot mentions, authorization, and bot-to-bot limits remain unchanged. Private ordinary chat/reply behavior stays compatible.
- Both foreground and recovery use only the native submission's `settled.answer`, with entry existence and conversation validation. Idle state or transcript order cannot determine ownership. Missing or empty answers use the unavailable/no-response path; partial media keeps its original request ownership.
  - Recovery checks cached `answerEntryId` against native settlement. A saved answer without its native submission cannot authorize model replay or a reply checkpoint.
- Request-owned progress, media, publication mode, status, and reply target remain attached to the same delivery intent. Acknowledgement removes delivery artifacts, not conversation history.
- Four active conversation admissions are shared per chat across main, branches, and articles. Recovered live runs reserve slots before scheduling resumes. Already admitted legacy runs are not dropped even if their count exceeds four; new work waits for capacity.
- Recovery scans readiness independently, with at most four active deliveries per chat. Unsettled work does not occupy delivery slots or block already settled peers. There is no global/provider concurrency or performance guarantee. Existing byte, time, URL-safety, tool, and policy limits are unchanged.
- `/cancel` is chat-wide, including branches, articles, pending inputs/deliveries, and article source loads. `/reset` also removes that chat's state and reply index. Peer chats are unchanged. Shutdown closes all observations/handles before the sole owner and preserves all admitted work.

## Pi 1.5 compatibility

- Pi 1.5 upgrades `pi.live` documents to version 2 and renames compaction `reason` to `trigger`. It also updates the built-in generation and tool task versions. The previous runtime cannot read the upgraded documents. Take a consistent backup before starting the new runtime.
- Sumire observes consecutive conversation views and queues listener notifications off the commit line. This preserves short tool transitions without using the removed event stream API.
- Conversation views contain a bounded history window. Sumire reads the active transcript through `Conversation.context()` so view trimming does not remove session history and a reset does not retain old model context.
- A model request interrupted by a process crash consumes an attempt from the configured retry budget. With no attempts left, the Harness ends the run without an answer. A graceful close preserves pending work for restart instead.

## Stored-state upgrade

### Session document version 2

Native migration upgrades `sumire.session` from version 1 to version 2 before scheduling/resume. It adopts legacy `activeConversation` as initial `mainConversation` and preserves `sessionId`, trust identity, existing conversations/forks, pending outbox, and valid version-1 reply-index mappings. It does not infer an earlier historical main or repair acknowledged deliveries. Invalid documents or missing main/active conversations fail closed rather than starting new model work.

New group reply/article handles do not replace stable main. Private ordinary navigation retains its selected active conversation. The public inspector continues to expose `sumire.session.activeConversation`: stable main for groups and the selected private conversation. This is a compatibility projection, not a contracts or Admin UI schema change.

### Native codemode stores

Before any scheduling starts, `migrateCodemodeStores` visits every existing conversation, including inactive branches. It copies missing native store values and writes a versioned marker atomically. An existing native store, including an empty store, wins. A partial migration can be retried without overwriting native changes.

The old `sumire.codemode-store` history remains read-only. Pi 1.3.0 has no public API to rename historical document commits. When Telegram restores a branch at a pre-upgrade entry, the bot reads the old value at that entry and initializes the native store in the fork's creation commit. It does not copy the latest value into every historical branch. Native-era forks use native history normally.

Keep the cleanup-only `sumire.codemode-call` version 1 definition installed. It settles old pending phases without executing capabilities. Pi also checks the replay policy saved in each tool intent: an old unsafe codemode call does not become replayable merely because its new definition is safe. Do not remove the cleanup definition while old persisted tasks can exist.

Failed or cancelled scripts do not commit store writes. Completed tool side effects are not rolled back. An interrupted unsafe tool is not automatically repeated, even when its calling script can resume.

## Local verification

Run from the repository root with Node.js 26 or newer. Use disposable storage; do not point tests at runtime volumes.

1. Install serially with `npm ci`. Do not install dependencies while tests run.
2. Run the focused contracts and recovery tests:

   ```bash
   npm test --workspace @narumitw/sumire -- tests/durable-tools.test.ts tests/durable-migration.test.ts tests/native-codemode-runtime.test.ts tests/codemode.test.ts tests/codemode-session.test.ts tests/admin-turns.test.ts tests/mcp-session.test.ts tests/durable-delivery.test.ts tests/durable-runtime.test.ts
   ```

3. Run the affected session-routing suites, including native conversation/migration, exact-answer ownership, registry/bot routing, reply index, recovery, policy, lifecycle, passive-context, media, and offline telemetry tests.
4. Run `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` from the root.

Session-routing verification on 2026-11-14: clean `npm ci` and all five root gates passed with Node.js 26.11.1 and npm 11.20.0. The test gate passed 3,864 tests across 222 files, including 2,101 bot tests. The existing headless Admin session-field/link check also passed. Native conversation, migration, real bot/registry routing, cached-answer, restored-admission, observer-cleanup, private related-media, and telemetry cases use offline fixtures. No required gate was waived. Unchanged non-failing template-literal information and the Admin `localStorage` warning remain.

Deployment, live A/B/C routing, actual Logfire receipt, and controlled production-image restart remain separately authorized and unverified.

The migration tests create representative pre-upgrade SQLite fixtures, close them before backup, upgrade disposable copies, restore the backup, and verify the old state. Process tests send SIGKILL and SIGTERM at a nested-tool boundary after a completed call has been journaled. They check effect counts, script continuation, the persisted deadline, and pending Telegram delivery. These tests do not send real Telegram messages or publish to external services.

## Operator procedure

Production deployment requires a separate authorized maintenance window. Record the exact old and new image digests and backup location privately before starting.

1. Confirm required gates and separate deployment authorization. Record old/new image digests and the private backup location. Stop new Telegram input. Drain admitted work or record every admitted/pending request explicitly; ordinary shutdown preserves work and is not a drain operation.
2. Stop the sole owner. Back up complete consistent state: shared administration state, every chat database, reply indexes, and referenced delivery artifacts. Include SQLite WAL recovery files when present. Do not copy only the main SQLite file while its owner is writing. Keep backups private and outside Git.
3. Rehearse migration and rollback on disposable copies with external transports disabled and offline fixtures. Verify repeat opens preserve chat identity, legacy-active-to-main adoption, history, forks, valid mappings, and outbox ownership. Verify rollback with the matching old image and pre-upgrade backup. Never attach two owners to the same database or test rollback on production volumes.
4. On copied state, verify historical checkpoints, pending work in every conversation, inspector links, permissions, cancellation, and recovery. Retain existing admitted legacy runs, including counts above four; verify new admissions wait. Verify settled peer deliveries are not blocked by an unsettled article, with no repeated confirmed effects.
5. If rehearsal passes and deployment is separately approved, use the repository-root Docker Compose flow to start one owner on production state. Keep the state volumes. Verify image digest, service health, migration, and authorization before allowing new input. Follow the separately authorized live checks below; deployment alone is not release acceptance.

Do not delete conversations to make an upgrade pass. Do not treat tool discovery, old instructions, or stored tool names as authorization.

## Rollback and limits

- Before the upgraded process admits new work, stop it, restore the consistent pre-upgrade backup, and start the matching old image.
- Do not run the old image directly on the migrated state. A runtime from before the Pi 1.5 upgrade cannot read upgraded `pi.live` documents, and its legacy store does not include later native writes. For the session-routing upgrade, an old Sumire reader also rejects `sumire.session` version 2; use the matching pre-upgrade backup.
- After external effects or deliveries, do not blindly restore an older snapshot. Reconcile effects and outbox acknowledgements first. Use a forward fix when restoring would repeat work or restore revoked access.
- Neither native replay nor the Telegram outbox guarantees exactly-once external delivery. An external effect may finish before its receipt is committed. Inspect that effect before an explicit retry.
- Source-level fixture tests are not production-image or operator acceptance. Record image rehearsal, deployment approval, controlled restart, and release acceptance separately in the existing operations handoff. Keep production IDs, content, private URLs, and secrets out of repository records.
- Do not use `/reset`, conversation deletion, or `docker compose down -v` to repair routing. Acknowledged wrong historical messages are not automatically repaired. An administrator must prove the source-request/native-answer relationship and obtain separate authorization before editing, resending, or changing mappings.

## Session-routing operator handoff

Deployment and live verification are **unverified**. Each operation below needs its own authorization; none is performed by source-level checks.

1. **Deployment operator:** complete gates, image/backup records, and disposable migration/rollback rehearsal before deployment. Expected result: one owner, preserved chat identity/main/history/mappings/pending work, and a healthy service. Production image, volumes, and provider behavior still require verification. Do not claim an on-line fix from a successful build.
2. **Bot and Logfire operator:** after authorized deployment, use existing credentials and an approved test group. Submit article A from a public non-sensitive source, addressed non-reply question B, and reply C to a known user/bot checkpoint. Obtain separate approval for message sends, model quota, and possible Morsel publication.
   - Verify A has a fresh conversation, B uses stable main, and C has a new fork of its source checkpoint. Repeat with branch/article output only when approved. Verify each source/status, native answer, publication mode, and outgoing target belongs to its own request. Confirm group main does not change.
   - Separately authorize a controlled restart with admitted work. Record metadata before stopping the sole owner. Verify pending work across all conversations resumes, and settled B/C can deliver while A remains unsettled. Verify saved status/reply targets, acknowledgements, and no repeated confirmed media/tool effects. If the required completion order cannot be observed, record that part as unverified; do not inject production faults or repeat unsafe effects to force it.
   - Confirm actual metadata receipt in Logfire, not only local enqueue. Use the comparisons below. Keep outcome records free of real identifiers, source content, prompts, share links, and secrets.
3. **Conversation administrator:** use restricted original-event access and separate repair authorization to assess acknowledged wrong historical replies. Prepare repair data only when source and native answer ownership can be proved. Actual public edits, resends, notifications, and mapping changes remain unverified and separately authorized. Do not batch replay old requests or reset a group as a substitute for reconciliation.

### Metadata-only ownership comparison

Use a narrow approved test window and placeholder values such as `<chat>`, `<session>`, `<request-A>`, `<conversation-A>`, `<submission-A>`, `<answer-A>`, and `<source-A>`. These are symbolic values, not literal production identifiers. Inspect only the named typed fields in Logfire; do not export payloads or raw log bodies.

1. Find `event.name=pi.submission.settled` for `<chat>`, `<session>`, and `<request-A>`. For an answered article, require `pi.submission_type=input` and `pi.settled_status=done`. Record `pi.submission_id=<submission-A>`, `pi.conversation_id=<conversation-A>`, and numeric `pi.entry_id=<answer-A>`.
2. Match the foreground `pi.submit` and `telegram.deliver` records by `pi.request_id=<request-A>` and `telegram.chat_id=<chat>`. Require `telegram.message_id=<source-A>`. The transport checkpoint `pi.entry_id` must equal the encoded string `<conversation-A>:<answer-A>`, not simply the numeric answer ID. Compare delivery `pi.session_id=<session>` and `pi.conversation_id=<conversation-A>` with native settlement. For article A, require `delivery.mode=publish`; ordinary B/C use `default`. Require the explicit delivery outcome, not only a completed span.
3. Match `telegram.recover_response` and media `telegram.deliver` records by chat/session/request/source. Require the same `pi.conversation_id=<conversation-A>` and encoded `pi.entry_id=<conversation-A>:<answer-A>` as native settlement. Require `recovery.outcome=delivered` or the media delivery's explicit outcome. Compare `delivery.message_id` and component receipts with restricted reply-index metadata: the session/checkpoint must agree. Recovery records need not share a trace ID with the original request. Do not infer answer ownership from trace correlation alone.
4. Match `telegram.acknowledge` for the same chat/session/request and require `delivery.outcome=acknowledged`. A delivered span without this outcome does not prove durable acknowledgement. For media, also compare confirmed component receipts; do not upload again merely to produce telemetry.
5. Repeat for `<request-B>` and `<request-C>`. Require distinct request IDs and article/main/reply conversation IDs. Compare C's native fork-parent/checkpoint metadata with its mapped source entry, not the latest leaf. Confirm the group's public inspector `activeConversation` still equals stable main. After restart, require the same chat session identity and preserved checkpoint relationships.

A missing record or checkpoint is a verification gap, not proof of correct ownership. These comparisons do not establish exactly-once delivery or a global/provider performance guarantee.
