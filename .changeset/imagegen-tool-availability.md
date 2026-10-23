---
"@narumitw/sumire": patch
"@narumitw/sumire-admin": patch
"@narumitw/sumire-contracts": minor
---

Fix imagegen tool availability after restart by reading Pi's non-secret credential metadata instead of an uninitialized auth snapshot. Preserve effective chat permissions and recheck asynchronous authorization before generation and delivery. Add optional capability diagnostics to the authenticated inventory, show provider requirements separately from policy in the WebUI, and log imagegen availability, permission, and installation without credentials or prompts.
