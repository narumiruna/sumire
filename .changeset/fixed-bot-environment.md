---
"@narumitw/sumire": minor
---

Limit Bot environment configuration to BOT_TOKEN, BOT_WHITELIST, BOT_ADMIN_ID, FIRECRAWL_API_KEY, OTTER_TOKEN, LOGFIRE_TOKEN, and MORSEL_API_KEY. Ignore former runtime switches and limits in favor of fixed defaults, enable channel image input by default while preserving explicit channel authorization, and retain Docker workdir/state separation without BOT_WORKDIR. Run npm startup scripts from the repository root with only its .env file.
