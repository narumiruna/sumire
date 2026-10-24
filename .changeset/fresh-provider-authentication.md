---
"@narumitw/sumire": patch
---

Read current local provider authentication for the admin inventory instead of an uninitialized runtime cache. Preserve configured status after restart for saved API keys, OAuth credentials, environment credentials, and custom providers without refreshing tokens or generating model output.
