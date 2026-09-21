---
"@narumitw/sumire": patch
---

Retry Telegram polling failures at a fixed five-second interval instead of allowing exponential delays to stall recovery. Route rate-limited outage warnings, recovery messages, and fatal errors through secret-redacted logging without grammY's raw token-bearing console output.
