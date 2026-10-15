---
"@narumitw/sumire": patch
"@narumitw/sumire-login": patch
---

Remove Telegram model selection, thinking controls, and login commands in favor of the administration Web UI. Keep protection against pasted legacy OAuth callbacks and discard retired login command arguments before model input. Enable local passkey setup at localhost when BOT_ADMIN_ID is set and ADMIN_ORIGIN is empty. Require existing model credentials when the Web UI is unavailable.
