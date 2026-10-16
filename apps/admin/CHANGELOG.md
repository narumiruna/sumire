# @narumitw/sumire-admin

## 0.2.0

### Minor Changes

- 426f3d7: Add a Passkey-authenticated Radix administration interface with persistent chat policies, model provider management, MCP configuration, audit records, and HTTPS deployment guidance. Expose the shared bounded public-network helpers for provider requests. Add the private administrator-only `/admin` command to open the WebUI before chat approval. Use administrator-only first-passkey setup links, browser-bound WebAuthn challenges, and a state migration that revokes old Telegram sessions. Remove Telegram Web Login credentials. Add searchable provider and model setup, supported authentication dialogs, capability badges, explicit default selection, and separate custom endpoint controls. Load saved default and chat models into provider setup without promoting chat overrides to a shared default. Keep blank bind hosts on loopback, import valid MCP entries independently, use the runtime working directory for MCP probes, and apply the latest concurrent policy revision. Add revision-checked MCP deletion with confirmation and capacity recovery, block stale MCP startup after policy changes, ignore unused admin ports while the WebUI is disabled, and report unsupported imported thinking levels without failing the shared policy.
- 9f3168d: Remove environment-based chat authorization and require `BOT_ADMIN_ID` plus the SQLite administration policy for all bot admission, restored work, model access, and tools. New databases deny all chats until explicit WebUI approval. Existing permissions, revocations, Passkeys, sessions, and historical access reviews remain unchanged.
  
  This is a breaking bootstrap change for the pre-1.0 bot: `BOT_WHITELIST` is ignored, WebUI administration cannot be disabled, and Stage 1 reconciliation must be accepted before upgrade. Remove reconciliation mutation endpoints and UI controls while retaining read-only historical reports on the Audit page.
- 9f0d16c: Add `/allow` links for explicit Passkey-authenticated chat approval, with short-lived hash-only requests, atomic policy updates, and review of existing environment allowlist IDs without restoring revoked access. Upgrade administration SQLite state to schema version 3; rollback requires a matching pre-upgrade backup.

### Patch Changes

- a9be0e1: Clarify configuration scope, separate save outcomes, and inherited chat settings. Add searchable chat selection, accessible access rows, pending-edit protection, MCP authorization summaries, and readable audit history without changing API or authorization semantics. Track pending changes from advanced provider controls and clear matching MCP drafts after deletion. Keep MCP drafts and staged secrets while reloading saved state after an uncertain save or deletion.
- 4c68102: Add a custom endpoint draft discard action. Start an empty MCP update through the explicit Edit fields action. Preserve JSON drafts while typing server names, including intermediate matches with existing names. Explain that explicit MCP secret maps replace all entries and require null markers for keys to retain.
- e71bb34: Show known chat names beside Telegram IDs in access lists. Keep IDs visible when names are unavailable.
- e9f5653: Rename the URL-reading tool from `load_public_url` to `read_url_content`. Update bot instructions, skills, documentation, and tests to use the new name. No legacy alias is registered; update direct calls, codemode scripts, and tool allowlists. Existing bot permissions are not transferred automatically: authorize the new name globally and in the effective chat policy through the Web UI.
- 82b3428: Identify model validation conflicts by settings scope and model. Add inline model warnings and a confirmed action to make all chats inherit shared defaults without changing access or enabled switches.
- 34cee96: Set the browser page title to Sumire.
