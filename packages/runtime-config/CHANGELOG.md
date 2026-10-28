# @narumitw/sumire-runtime-config

## 0.2.0

### Minor Changes

- 9f3bc6c: Rename the host bootstrap encryption setting to ENCRYPTION_KEY. Accept 32-byte keys encoded as 64 hex characters from `openssl rand -hex 32`, while preserving canonical Base64 support for existing encrypted databases. Update reserved-name checks, administration guidance, and setup documentation. Permit explicit deletion of legacy entries whose names become reserved without allowing new values under those names.
- 593c3df: Add administrator-managed encrypted runtime secrets and non-confidential variables. Resolve current stored credentials for Morsel, Firecrawl, and explicit MCP bindings after settings application. Add a deny-by-default variable reader and preserve standalone URL-reader environment compatibility. Keep newly discovered MCP tools denied until explicitly approved so credential activation cannot expand permissions.
