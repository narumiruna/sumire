---
"@narumitw/sumire": minor
"@narumitw/sumire-admin": minor
"@narumitw/sumire-contracts": minor
---

Add a localized Schedule administration page and authenticated, revision-checked APIs for creating, deleting, pausing, and resuming scheduled user-message tasks. Support explicit browser-local execution times and optional fixed repeat intervals, persist bounded scheduling records, and dispatch through the existing Pi Durable registry and Telegram outbox without automatically replaying uncertain attempts. Keep draft destinations in sync with chat access, preserve repeat cadence across clock changes, retry completion writes without rerunning tasks, and honor Telegram cancellation before scheduled submission.
