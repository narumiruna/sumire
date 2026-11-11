---
"@narumitw/sumire": patch
---

Retry Telegram attachment downloads once after a structured connection-reset error, with a 250 ms delay inside the existing total deadline. Preserve streamed size limits, cancellation, submission order, and existing failure responses without repeating model or delivery work.
