---
"@narumitw/sumire": patch
"@narumitw/sumire-admin": patch
"@narumitw/sumire-contracts": patch
"@narumitw/sumire-github-notifications": patch
"@narumitw/sumire-imagegen": patch
"@narumitw/sumire-login": patch
"@narumitw/sumire-pi-polymarket": patch
"@narumitw/sumire-pi-url-reader": patch
"@narumitw/sumire-policy": patch
"@narumitw/sumire-progress": patch
"@narumitw/sumire-runtime-config": patch
"@narumitw/sumire-url-reader": patch
---

Update Vitest across the workspaces and refresh Playwright, localization, and
runtime dependencies. Update Logfire and the tracing SDK while keeping the
OpenTelemetry API at 1.9.1, which both support. Refresh the generated API
catalogs for Polymarket client 0.20.0. When filtering `listOpenOrders` by
asset or token, also supply the market condition ID.
