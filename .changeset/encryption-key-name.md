---
"@narumitw/sumire": patch
"@narumitw/sumire-admin": patch
"@narumitw/sumire-runtime-config": minor
---

Rename the host bootstrap encryption setting to ENCRYPTION_KEY. Accept 32-byte keys encoded as 64 hex characters from `openssl rand -hex 32`, while preserving canonical Base64 support for existing encrypted databases. Update reserved-name checks, administration guidance, and setup documentation. Permit explicit deletion of legacy entries whose names become reserved without allowing new values under those names.
