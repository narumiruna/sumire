---
"@narumitw/sumire": minor
"@narumitw/sumire-admin": minor
"@narumitw/sumire-policy": minor
"@narumitw/sumire-status-page": minor
---

Add bounded readers for GitHub, OpenAI, Claude, and Cloudflare status pages, and a Service status administration page with provider selection, multiple Telegram destinations, polling intervals, severity filters, and update, recovery, and maintenance controls. Persist independent delivery checkpoints, confirm incident recovery before notification, and stop in-flight work on policy changes or shutdown without model calls. Keep aggregate alerts when eligible detailed incidents do not cover their severity or affected components, and enforce send spacing with a monotonic clock after successful and failed attempts.
