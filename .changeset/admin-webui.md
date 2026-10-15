---
"@narumitw/sumire": minor
"@narumitw/sumire-admin": minor
"@narumitw/sumire-url-content": minor
---

Add a Passkey-authenticated Radix administration interface with persistent chat policies, model provider management, MCP configuration, audit records, and HTTPS deployment guidance. Expose the shared bounded public-network helpers for provider requests. Add the private administrator-only `/admin` command to open the WebUI before chat approval. Use administrator-only first-passkey setup links, browser-bound WebAuthn challenges, and a state migration that revokes old Telegram sessions. Remove Telegram Web Login credentials. Add searchable provider and model setup, supported authentication dialogs, capability badges, explicit default selection, and separate custom endpoint controls. Load saved default and chat models into provider setup without promoting chat overrides to a shared default. Keep blank bind hosts on loopback, import valid MCP entries independently, use the runtime working directory for MCP probes, and apply the latest concurrent policy revision.
