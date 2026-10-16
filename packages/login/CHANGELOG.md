# @narumitw/sumire-login

## 0.1.2

### Patch Changes

- 8f94f1b: Remove Telegram model selection, thinking controls, and login commands in favor of the administration Web UI. Keep protection against pasted legacy OAuth callbacks and discard retired login command arguments before model input. Enable local passkey setup at localhost when BOT_ADMIN_ID is set and ADMIN_ORIGIN is empty. Require existing model credentials when the Web UI is unavailable.

## 0.1.1

### Patch Changes

- a0dd83e: Add a reusable Pi OAuth login package and an admin-only private Telegram `/login`. Support shared OpenAI subscription authentication through Pi's native Responses provider, with persistent credentials, cancellation, timeout, and authentication input interception. Preserve the existing API-key/OpenAI-compatible mode.
- 2709cfb: Update Pi dependencies to 1.0.2 across all workspaces, update the bot's Otter CLI to 0.3.1 and Logfire Node to 0.18.27, and refresh the dependency lockfile.
