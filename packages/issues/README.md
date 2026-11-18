# Sumire Issues

Private visual feedback contracts and storage. `@narumitw/sumire-issues` is browser-safe;
`@narumitw/sumire-issues/store` is a Node.js SQLite adapter. Transport, authentication,
image validation, UI capture, and future agent orchestration belong to the host.

## Host contract

1. Call `initializeIssueStorage(db)` during the host's schema initialization transaction.
2. Construct `IssueStore` with that process-owned connection and an audit callback.
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

The adapter owns no connection lifecycle, scheduler, model loop, or GitHub capability.
This first version **does not create an agent session or execute proposals**. Future issue
sessions must be real Pi Durable sessions, with explicit proposal/version approvals and
isolated implementation workers; do not invent session IDs for collected feedback.
