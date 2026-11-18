---
"@narumitw/sumire": patch
"@narumitw/sumire-admin": patch
"@narumitw/sumire-issues": patch
"@narumitw/sumire-imagegen": patch
---

Fix feedback capture/pointer accuracy, exact image-size checks, stalled and uncertain retries, stale issue selections, independent list and attachment recovery, UUID retry canonicalization and SQLite error preservation. Enforce feedback raster limits before PNG inflation and flush bounded-upload 413 responses without resetting the connection.

Keep the issue analysis worker under one owner. Retry metadata reads and file cleanup, and require HTTPS before sending feedback to a model.
