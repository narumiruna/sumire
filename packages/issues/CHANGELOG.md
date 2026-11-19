# @narumitw/sumire-issues

## 0.2.0

### Minor Changes

- 64eea46: Add real independent Durable issue sessions, explicit model-analysis consent, bounded restart-safe analysis admission, structured proposal/clarification reports, inert SVG wireframes and version-bound proposal choices. Preserve cancellation, policy revocation, private file cleanup and the boundary against implementation or automatic PR execution.
- fad3d3d: Add an HTTPS Issues MCP for coding agents with OAuth and Sumire Passkey approval. Read issues and screenshots or request write access to rename, close, reopen, and delete issues. Review and revoke OAuth grants in the admin WebUI. Isolate public setup limits, protect pending consent and approved codes, and return OAuth errors to validated callbacks. Protect unsaved WebUI settings and report committed MCP writes without exposing data after token rotation.
- 1f660c4: Add private visual feedback collection and an Issues workspace, backed by a shared issues package with bounded storage, idempotent submission, and revision-checked management. Agent proposals and PR execution are deferred to subsequent phases.

### Patch Changes

- 0734da3: Update OpenTelemetry dependencies within the range supported by Logfire and
  update the issues workspace to Vitest 5.1.1. Update the Polymarket catalog
  generator to TypeScript 6.0.3 so it can still use the compiler API to check
  that the catalog is current. Builds and type checks still use TypeScript 7.
- 8d90641: Fix feedback capture/pointer accuracy, exact image-size checks, stalled and uncertain retries, stale issue selections, independent list and attachment recovery, UUID retry canonicalization and SQLite error preservation. Enforce feedback raster limits before PNG inflation and flush bounded-upload 413 responses without resetting the connection.
  
  Keep the issue analysis worker under one owner. Retry metadata reads and file cleanup, and require HTTPS before sending feedback to a model.
