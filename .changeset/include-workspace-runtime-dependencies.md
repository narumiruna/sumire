---
"@narumitw/sumire": patch
---

Include workspace-local production dependencies in the Docker image so bot startup can resolve packages such as `typebox`. Share the assembled application with an offline Docker import check in pull-request CI.
