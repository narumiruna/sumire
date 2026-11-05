---
"@narumitw/sumire": patch
---

Recover startup with persisted statusNotifications settings left by the reverted Service status feature. Atomically archive the original settings row, retire only that field, and require normal application of a new policy revision without changing other settings, credentials, access decisions, or delivery checkpoints. Keep API validation strict and never restore archived notifications automatically.
