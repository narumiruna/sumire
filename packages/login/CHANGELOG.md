# @narumitw/sumire-login

## 0.2.5

### Patch Changes

- 143960b: Update the Pi packages to 1.5.2, Logfire Node to 0.23.0, Vite to 8.3.7, and the Polymarket client to 0.18.0. Move Chord type imports to their supported subpaths. Refresh the Polymarket API catalogs, including the new wallet-scoped order actions, and retain TypeScript 6 for the catalog generator compiler API.

## 0.2.4

### Patch Changes

- 7399c4b: Update workspace dependencies, including Pi 1.5.0 and Polymarket 0.16.0. Import TypeBox directly, preserve typed string enums with Pi's updated schema helpers, and regenerate the Polymarket catalog with the current TypeScript compiler.
  
  Migrate the bot to Durable conversation observations while preserving progress delivery and the full active transcript. Keep nested tool results in session completion events. Preserve message completion events and direct tool results when a bulk commit exceeds the bounded observation window. Keep literal HTML entity spellings unchanged with the updated Markdown tokenizer.
  
  Update the bundled curl-impersonate library to v2.3.2 with verified Linux archive checksums. This matches the Chrome profiles required by impers 0.1.3.
  
  Back up durable storage before deployment. Pi 1.5 upgrades `pi.live` documents; rollback requires the matching pre-upgrade state.

## 0.2.3

### Patch Changes

- 0c227d3: Restore the repository to commit 35a2b199b517640c87adbbfd5c12f5c187b454d5. Restore the Node.js container runtime, Docker build layout, URL readers, tests, documentation, and dependency versions from that snapshot. Replace the reverted changesets with this rollback changeset.

## 0.2.2

### Patch Changes

- 203d5d3: Update Pi to 1.4.0 and refresh workspace dependencies and development tools. Add explicit Durable document checkpoint policies without changing document identities or fork behavior. Support sleeping tasks in administration inspection and regenerate the Polymarket 0.14.0 SDK catalog.
  
  Pi Durable automatically upgrades SQLite storage to schema version 2. Before deployment, stop the bot and take a consistent state backup. Rollback to Pi Durable 1.3.0 or earlier requires the previous image and matching pre-upgrade state backup.

## 0.2.1

### Patch Changes

- b0384ec: Update dependencies and restore compatibility with Pi 1.3 and TypeScript 7. Preserve durable tool output, MCP namespace discovery, and API generation. Remove lint, install, build, and experimental passkey warnings.

## 0.2.0

### Minor Changes

- 2798cbf: Require Node.js 26 or newer across all workspaces. CI, release workflows, and Docker stages now use Node.js 26. Node.js versions below 26 are no longer supported.

## 0.1.2

### Patch Changes

- 8f94f1b: Remove Telegram model selection, thinking controls, and login commands in favor of the administration Web UI. Keep protection against pasted legacy OAuth callbacks and discard retired login command arguments before model input. Enable local passkey setup at localhost when BOT_ADMIN_ID is set and ADMIN_ORIGIN is empty. Require existing model credentials when the Web UI is unavailable.

## 0.1.1

### Patch Changes

- a0dd83e: Add a reusable Pi OAuth login package and an admin-only private Telegram `/login`. Support shared OpenAI subscription authentication through Pi's native Responses provider, with persistent credentials, cancellation, timeout, and authentication input interception. Preserve the existing API-key/OpenAI-compatible mode.
- 2709cfb: Update Pi dependencies to 1.0.2 across all workspaces, update the bot's Otter CLI to 0.3.1 and Logfire Node to 0.18.27, and refresh the dependency lockfile.
