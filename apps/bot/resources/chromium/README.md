# Chromium seccomp profile

`seccomp-profile.json` is a copy of Playwright's recommended Docker seccomp profile with only repository formatting applied, licensed under Apache-2.0 (see `LICENSE`).

- Source: https://github.com/microsoft/playwright/blob/ae935a43d9e376e4759548f6b3c6905c7b282333/utils/docker/seccomp_profile.json
- Upstream file SHA-256: `cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849`
- `JSON.stringify(JSON.parse(file))` SHA-256: `8e3abd795acf8d96f90d4f2103f2b9665c21ab645df244d4eedcc5c95ceac3a2` (enforced by regression tests)
- Guidance: https://playwright.dev/docs/docker#crawling-and-scraping

The profile defaults to `SCMP_ACT_ERRNO` and adds `clone`, `setns` and `unshare` permissions for Chromium's user-namespace sandbox. Compose applies it to the non-root bot container and all its subprocesses. It does not grant container capabilities, privileged mode or unrestricted seccomp. The host must also permit unprivileged user namespaces; do not bypass a host prohibition by disabling Chromium's sandbox.

Do not change the upstream policy without reviewing the change. Regression tests compare the parsed policy's checksum so normal repository formatting does not invalidate provenance. When updating, review the upstream policy diff and rerun the complete container smoke, including a sandbox-enabled full Chromium launch and explicit Playwright URL loading. Restore the previous image and Compose security policy together for rollback.
