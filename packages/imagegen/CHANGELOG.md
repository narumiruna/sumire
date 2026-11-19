# @narumitw/sumire-imagegen

## 0.2.4

### Patch Changes

- 8d90641: Fix feedback capture/pointer accuracy, exact image-size checks, stalled and uncertain retries, stale issue selections, independent list and attachment recovery, UUID retry canonicalization and SQLite error preservation. Enforce feedback raster limits before PNG inflation and flush bounded-upload 413 responses without resetting the connection.
  
  Keep the issue analysis worker under one owner. Retry metadata reads and file cleanup, and require HTTPS before sending feedback to a model.

## 0.2.3

### Patch Changes

- 51276a2: Update Vitest across the workspaces and refresh Playwright, localization, and
  runtime dependencies. Update Logfire and the tracing SDK while keeping the
  OpenTelemetry API at 1.9.1, which both support. Refresh the generated API
  catalogs for Polymarket client 0.20.0. When filtering `listOpenOrders` by
  asset or token, also supply the market condition ID.

## 0.2.2

### Patch Changes

- 7399c4b: Update workspace dependencies, including Pi 1.5.0 and Polymarket 0.16.0. Import TypeBox directly, preserve typed string enums with Pi's updated schema helpers, and regenerate the Polymarket catalog with the current TypeScript compiler.
  
  Migrate the bot to Durable conversation observations while preserving progress delivery and the full active transcript. Keep nested tool results in session completion events. Preserve message completion events and direct tool results when a bulk commit exceeds the bounded observation window. Keep literal HTML entity spellings unchanged with the updated Markdown tokenizer.
  
  Update the bundled curl-impersonate library to v2.3.2 with verified Linux archive checksums. This matches the Chrome profiles required by impers 0.1.3.
  
  Back up durable storage before deployment. Pi 1.5 upgrades `pi.live` documents; rollback requires the matching pre-upgrade state.

## 0.2.1

### Patch Changes

- 0c227d3: Restore the repository to commit 35a2b199b517640c87adbbfd5c12f5c187b454d5. Restore the Node.js container runtime, Docker build layout, URL readers, tests, documentation, and dependency versions from that snapshot. Replace the reverted changesets with this rollback changeset.

## 0.2.0

### Minor Changes

- 0e1496e: Add experimental Codex OAuth image generation with bounded image validation, explicit chat tool approval, and durable Telegram photo/document delivery with partial-delivery recovery.
