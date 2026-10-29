---
"@narumitw/sumire": patch
"@narumitw/sumire-github-notifications": patch
---

Isolate source pagination limits to the affected GitHub thread during mention discovery. Discard its incomplete sources, return a skipped-thread count, and keep other threads and saved replies moving. Preserve all other scan failures and bounded reply-marker checks.
