---
"@narumitw/sumire": patch
---

Require every Telegram text reply and edit over 1000 Unicode characters to publish its complete content to Morsel, including AI answers, commands, and progress updates. Enforce the limit regardless of rich-tool mode or higher legacy thresholds. Send only a short failure notice when publication is unavailable, without falling back to inline long text or recording a successful answer checkpoint.
