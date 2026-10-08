---
"@narumitw/sumire": patch
---

Align Docker Chromium installation with the locked Playwright version and launch Chrome MCP through an explicit headless container configuration. Use Playwright's recommended non-root Docker seccomp profile to retain Chromium's sandbox, and verify both browser paths without smoke-only argument overrides. Smoke checks select only configured default targets, tolerate customized server sets, and fail clearly for missing, disabled or invalid requested servers.
