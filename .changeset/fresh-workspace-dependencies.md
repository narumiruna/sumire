---
"@narumitw/sumire": patch
"@narumitw/sumire-admin": patch
"@narumitw/sumire-contracts": patch
"@narumitw/sumire-login": patch
"@narumitw/sumire-pi-polymarket": patch
"@narumitw/sumire-pi-url-reader": patch
"@narumitw/sumire-progress": patch
"@narumitw/sumire-url-reader": patch
---

Update Pi to 1.4.0 and refresh workspace dependencies and development tools. Add explicit Durable document checkpoint policies without changing document identities or fork behavior. Support sleeping tasks in administration inspection and regenerate the Polymarket 0.14.0 SDK catalog.

Pi Durable automatically upgrades SQLite storage to schema version 2. Before deployment, stop the bot and take a consistent state backup. Rollback to Pi Durable 1.3.0 or earlier requires the previous image and matching pre-upgrade state backup.
