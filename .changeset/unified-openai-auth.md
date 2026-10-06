---
"@narumitw/sumire": minor
---

Remove OPENAI_AUTH_MODE and support API keys and shared OAuth credentials together through Pi's native OpenAI Responses provider on the official endpoint. Prefer stored credentials over the configured key, enable admin-only private /login alongside API-key use, and keep custom OpenAI-compatible endpoints API-key-only. Preserve Pi-owned persistence and refresh without silent key fallback after OAuth failure.
