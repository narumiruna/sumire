# Sumire Issues

Private visual feedback contracts and storage. `@narumitw/sumire-issues` is browser-safe;
`@narumitw/sumire-issues/store` is a Node.js SQLite adapter; `./analysis-store` owns
analysis intents, immutable reports and proposal choices. Transport, authentication,
image validation, UI capture and Pi Durable orchestration belong to the host.

## Host contract

1. Call `initializeIssueStorage(db)` during the host's schema initialization transaction.
2. Construct `IssueStore` with that process-owned connection and an audit callback. When
   enabling analysis, also supply a callback for the current policy revision; pass that
   revision to `AnalysisStore.request` on explicit admissions. Clients cannot set these
   internal bindings. The worker rejects missing or changed consent-time policy revisions.
3. Authenticate and authorize every call. Validate screenshot bytes before passing them to
   `create`; the adapter accepts only a trusted, validated raster envelope, not arbitrary files.
4. Use the same UUID and payload when retrying an ambiguous submission. Reusing that UUID
   with changed content returns 409. Deduplication lasts while the issue exists.
5. Use each issue's revision for updates/deletion. The audit callback runs synchronously in
   the same transaction and must not start its own transaction.

Description and a screenshot are individually optional, but at least one is required.
Descriptions are plain text (8,000 characters); source metadata contains only a bounded
section label and viewport dimensions. There is deliberately no URL, DOM, browser storage,
credential, session path, or arbitrary metadata field.

Lists contain 25 metadata rows and an ID-based continuation, never attachment bytes or
full descriptions. Detail reads return source/description; screenshots require a separate
read. Limits: 1,000 issues, 2 MiB per attachment, 64 MiB total live attachments. Closed issues
still count. Deletion removes the attachment and uses SQLite secure deletion; this is not a
promise to erase filesystem snapshots, backups, or browser/OS memory.

The adapter owns no connection lifecycle, scheduler, model loop or GitHub capability.
Issue creation atomically records an initialization intent. The host links session IDs only
after creating real Pi Durable storage/conversations. Local initialization does not consent
to model calls. Optional `analyze: true` requests analysis explicitly; omitted/false preserves
phase-one retry compatibility. Model admission, cancellation and proposal choices have
separate strict schemas and optimistic revisions.

Reports must be published through a validated tool, not parsed from assistant prose. Preview
schemas accept only bounded text/layout data; `renderProposalSvg` builds an escaped inert
wireframe with no model-supplied markup or URLs. Proposal choices bind an immutable report
version and **never authorize implementation**. See [analysis boundaries and rollout](../../docs/issue-analysis.md).

Deletion transactionally records native-session cleanup keys before removing projections.
The host stops active work and drains that outbox. A deletion trigger preserves old-adapter
parent deletion compatibility during rollback; old builds cannot drain native file cleanup.
No code-editing, imagegen, GitHub publication, auto-merge or deployment capability is present.
