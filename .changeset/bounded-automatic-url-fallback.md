---
"@narumitw/sumire": patch
"@narumitw/sumire-url-content": patch
"@narumitw/sumire-url-tool": patch
---

Prevent slow URL attempts from starving automatic fallback, prefer fast browser extraction, and share a total deadline across validation and built-in/source-aware loading. Article preloading now uses its configured budget and displays a reusable status before fetching. Preserve safe timeout/cancellation diagnostics and bound cleanup waiting. Add an opt-in final Firecrawl fallback, with streamed response limits and reported-target validation, without enabling external costs merely because an API key exists.
