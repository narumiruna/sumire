---
"@narumitw/sumire-url-reader": patch
"@narumitw/sumire": patch
---

Isolate asynchronous impers requests in a supervised Node.js host when the caller runs under Bun. Preserve the public proxy, redirect checks, streaming limits, cancellation and native Node.js transport. Add real offline curl I/O to the production image checks so unsupported native socket APIs fail the build instead of restarting the bot.
