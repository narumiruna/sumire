---
"@narumitw/sumire": minor
"@narumitw/sumire-admin": minor
"@narumitw/sumire-url-content": patch
---

Remove environment-based chat authorization and require `BOT_ADMIN_ID` plus the SQLite administration policy for all bot admission, restored work, model access, and tools. New databases deny all chats until explicit WebUI approval. Existing permissions, revocations, Passkeys, sessions, and historical access reviews remain unchanged.

This is a breaking bootstrap change for the pre-1.0 bot: `BOT_WHITELIST` is ignored, WebUI administration cannot be disabled, and Stage 1 reconciliation must be accepted before upgrade. Remove reconciliation mutation endpoints and UI controls while retaining read-only historical reports on the Audit page.
