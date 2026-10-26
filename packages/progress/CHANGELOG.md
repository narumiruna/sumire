# @narumitw/sumire-progress

## 0.3.2

### Patch Changes

- 203d5d3: Update Pi to 1.4.0 and refresh workspace dependencies and development tools. Add explicit Durable document checkpoint policies without changing document identities or fork behavior. Support sleeping tasks in administration inspection and regenerate the Polymarket 0.14.0 SDK catalog.
  
  Pi Durable automatically upgrades SQLite storage to schema version 2. Before deployment, stop the bot and take a consistent state backup. Rollback to Pi Durable 1.3.0 or earlier requires the previous image and matching pre-upgrade state backup.

## 0.3.1

### Patch Changes

- b0384ec: Update dependencies and restore compatibility with Pi 1.3 and TypeScript 7. Preserve durable tool output, MCP namespace discovery, and API generation. Remove lint, install, build, and experimental passkey warnings.

## 0.3.0

### Minor Changes

- 2798cbf: Require Node.js 26 or newer across all workspaces. CI, release workflows, and Docker stages now use Node.js 26. Node.js versions below 26 are no longer supported.

## 0.2.0

### Minor Changes

- 83a2765: Remove the blocked reason field and preserve legacy reasons in step text, including interrupted durable calls. Show Telegram progress steps with current activity and tool names. Reuse long-message notices for activity edits, keep complete inline progress when activity does not fit, report each model turn, and enforce both grapheme and absolute text size limits.

## 0.1.3

### Patch Changes

- a55f74f: Add opt-in native Pi codemode with a host-owned script deadline while preserving existing tool permissions, cancellation, and branch-aware state. Initialize SDK extensions before delivering a session, and keep progress and channel image reads model-only so nested orchestration cannot lose their state or image blocks.

## 0.1.2

### Patch Changes

- b40c95a: Keep typebox in the production image and smoke-test bot startup imports during the Docker build.
- 5b7a634: Update Pi dependencies to 0.99.1, Vitest to 5.0.3, taiwan-exchange-rates to 0.2.1, and fast-xml-parser to 5.11.2, and refresh the dependency lockfile. Align the bot's session interface with Pi's steering and follow-up return types.
- 93b032c: Update Pi dependencies to 1.0.0, Biome to 2.5.15, and Node.js type definitions to 26.6.4, and refresh the dependency lockfile.
- 2709cfb: Update Pi dependencies to 1.0.2 across all workspaces, update the bot's Otter CLI to 0.3.1 and Logfire Node to 0.18.27, and refresh the dependency lockfile.
- 5cb94f8: Update Pi and other workspace dependencies, including the dependency lockfile.

## 0.1.1

### Patch Changes

- 6765dcf: Mark all shared workspace packages as private to prevent accidental npm publication.

## 0.1.0

### Minor Changes

- 2c76dfb: Add a repository-owned Pi progress package and show its structured multi-step state in the Telegram pending reply.
