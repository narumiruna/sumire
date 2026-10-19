# Native Pi Durable upgrade

## Ownership and contracts

Pi Durable 1.3.0 owns model turns, direct and nested tool tasks, script journals, retries, compaction, and transcript storage. Sumire owns Telegram routing, delivery intents, live authorization, MCP transport, and capability limits.

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

The host adapters do not schedule nested calls or implement a second model loop.

## Stored-state upgrade

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

3. Run `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` from the root.

The migration tests create representative pre-upgrade SQLite fixtures, close them before backup, upgrade disposable copies, restore the backup, and verify the old state. Process tests send SIGKILL and SIGTERM at a nested-tool boundary after a completed call has been journaled. They check effect counts, script continuation, the persisted deadline, and pending Telegram delivery. These tests do not send real Telegram messages or publish to external services.

## Operator procedure

Production deployment requires a separate authorized maintenance window. Record the exact old and new image digests and backup location privately before starting.

1. Stop new Telegram input and drain admitted work with the current image. Confirm no work remains; ordinary session disposal preserves pending work and is not a drain operation.
2. Stop the current process. Take a consistent backup of the full durable state, including SQLite WAL recovery files when present. Keep the backup private and outside Git.
3. Rehearse the upgrade and rollback on disposable copies of representative state. Never attach two processes to the same chat database.
4. Start the new image on the copied state. Verify historical reply-tree branches, inactive conversations, pending task settlement, permissions, and pending response recovery. Verify that fixture side effects occur no more than once.
5. If rehearsal passes and deployment is approved, start one new owner on the production state. Verify a controlled restart and Telegram delivery before release acceptance.

Do not delete conversations to make an upgrade pass. Do not treat tool discovery, old instructions, or stored tool names as authorization.

## Rollback and limits

- Before the upgraded process admits new work, stop it, restore the consistent pre-upgrade backup, and start the matching old image.
- Do not run the old image directly on the migrated state. Its legacy store does not include later native writes.
- After external effects or deliveries, do not blindly restore an older snapshot. Reconcile effects and outbox acknowledgements first. Use a forward fix when restoring would repeat work or restore revoked access.
- Neither native replay nor the Telegram outbox guarantees exactly-once external delivery. An external effect may finish before its receipt is committed. Inspect that effect before an explicit retry.
- Source-level fixture tests are not production image or operator acceptance. Record image rehearsal, deployment approval, controlled restart, and release acceptance separately in the active integration plan.
