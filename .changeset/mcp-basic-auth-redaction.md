---
"@narumitw/sumire": patch
---

Redact decoded Basic-auth credential pairs, usernames and passwords from MCP metadata and results while preserving wire headers and enforcing existing credential budgets. Match short derived components at Unicode boundaries so unrelated schema vocabulary and result words remain intact; explicit credentials retain substring matching.
