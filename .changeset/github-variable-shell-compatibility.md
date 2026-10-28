---
"@narumitw/sumire": patch
---

Keep native shell execution available when GH_TOKEN is a public variable without OAuth state. Do not inject the variable or ambient GitHub credentials, and keep invalid managed OAuth pairs blocked.
