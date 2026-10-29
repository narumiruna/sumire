---
"@narumitw/sumire": patch
"@narumitw/sumire-github-notifications": patch
---

Refresh managed GitHub credentials before enabled mention polls. Keep disabled-policy and cancellation checks around credential resolution.

Save per-account scan continuations after complete pages. Recheck the saved page boundary before continuing. Restart a moved boundary without advancing the original cutoff. Resume bounded scans after restart and keep the original cutoff until the full scan completes.

Recognize HTML comment delimiters only outside code so literal code does not hide a later direct mention.
