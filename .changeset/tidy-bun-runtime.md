---
"@narumitw/sumire": patch
"@narumitw/sumire-url-reader": patch
---

Run the Docker bot, healthcheck, and offline runtime checks with Bun 1.4.4. Keep Node.js and npm for builds and external CLIs, and verify SQLite backup and native document conversion in the image. Disable automatic workdir `.env` loading in Bun document-conversion children, and use the installed Undici client to preserve connection-time DNS validation under Bun.
