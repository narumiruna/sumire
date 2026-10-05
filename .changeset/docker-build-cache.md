---
"@narumitw/sumire": patch
---

Reuse independent workspace build layers and npm, pip, and apt download caches in Docker builds. Isolate Chromium downloads and torch installation, exclude test inputs from the build context, and persist intermediate container build layers in GitHub Actions cache.
