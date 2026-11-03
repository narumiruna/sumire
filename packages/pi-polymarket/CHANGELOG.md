# @narumitw/sumire-pi-polymarket

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
- 369adbd: Add Pi tools for all default actions in the official Polymarket client 0.13.0, with API discovery, host-provided authenticated clients, explicit mutation confirmation, and bounded session-handle access.

### Patch Changes

- 2798cbf: Bundle public Polymarket tools in each bot chat's Pi Durable session, with the existing capability policy, isolated handles, replay-unsafe network execution, and client cleanup. Include the package in dependency builds and production Docker resources. Trading remains disabled.
- d99a168: Keep new Polymarket capabilities denied until administrator approval. Reject delegated Perps credentials in tool requests and show only the new-session request schema. Keep at most ten full-output files per runtime and remove them on disposal. Check the Node.js baseline only for directories with workspace manifests.
- c1fd21a: Add an untrusted-data warning to every remote action and handle tool description. Keep the warning available when API discovery is not approved.
