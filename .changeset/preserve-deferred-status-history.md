---
"@narumitw/sumire": patch
---

Preserve queued history when an incident returns to its last acknowledged state. Keep deferred severity peaks and reopened-then-resolved notices until delivery, including after restart. Continue to skip unchanged states when no pending history exists.
