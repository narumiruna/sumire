---
"@narumitw/sumire": patch
"@narumitw/sumire-url-reader": patch
"@narumitw/sumire-pi-url-reader": patch
---

Run the Docker bot, healthcheck, and offline runtime checks with Bun 1.4.4. Keep Node.js and npm for builds and external CLIs, and verify SQLite backup and native document conversion in the image. Disable automatic workdir `.env` loading in Bun document-conversion children, and use the installed Undici client in both URL clients to preserve connection-time DNS validation and dispatcher cleanup under Bun. Run codemode VMs in killable Node.js processes when the bot uses Bun, retaining native Pi scheduling, deterministic replay, and tool policy checks. Verify actual VM termination on timeout, abort, and close in CI and the final image. Keep `clone3` denied with `ENOSYS` in Compose so modern glibc can use the existing `clone` thread policy.
