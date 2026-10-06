---
"@narumitw/sumire": patch
---

Enable the final generic Firecrawl fallback by default for URL tool and /f source loading, and remove BOT_URL_FIRECRAWL_FALLBACK_ENABLED. The fallback still skips requests without FIRECRAWL_API_KEY or enough remaining time.
