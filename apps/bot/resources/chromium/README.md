# Chromium seccomp profile

`seccomp-profile.json` is based on Playwright's recommended Docker seccomp profile, licensed under Apache-2.0 (see `LICENSE`). Local changes add an unconditional `faccessat2` allowance and return `ENOSYS` for denied `clone3` calls. The latter does not allow `clone3`.

- Source: https://github.com/microsoft/playwright/blob/ae935a43d9e376e4759548f6b3c6905c7b282333/utils/docker/seccomp_profile.json
- Upstream file SHA-256: `cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849`
- Upstream `JSON.stringify(JSON.parse(file))` SHA-256: `8e3abd795acf8d96f90d4f2103f2b9665c21ab645df244d4eedcc5c95ceac3a2`
- Local `JSON.stringify(JSON.parse(file))` SHA-256: `d3a7e09ee36cc1335c6f29aa2dc4593dcb02b68b849d35cc82367f2072da4ad7`
- Regression tests remove only `faccessat2` and the exact `clone3` error rule, then verify the pinned upstream checksum. They require exactly one unconditional `faccessat2` allowance and one `clone3` denial with `errnoRet: 38` (`ENOSYS` on the supported Linux amd64 and arm64 targets).
- Guidance: https://playwright.dev/docs/docker#crawling-and-scraping

`faccessat2` performs permission checks relative to a directory file descriptor. It is also allowed by [Moby's default profile](https://github.com/moby/profiles/blob/6fe7deb1b9fb7c0397a4593480d7d22b9ee8caef/seccomp/default.json). On OrbStack 2.2.4 with Docker 29.8.2 and ARM64 runc 1.5.2, the original policy causes a `SIGSEGV` in runc's libpathrs procfs initialization before the container command starts. A credential-free `/bin/true` container reproduces the failure; adding only `faccessat2` allows startup and a sandbox-enabled full Chromium launch. The network namespace bind-mount error seen during later restart attempts does not identify this policy failure.

Modern glibc tries `clone3` when creating a thread and falls back to `clone` only when the kernel returns `ENOSYS`. The original profile returns `EPERM`, which prevents thread creation in Node.js 26 and Bun 1.4.4 on a Linux 6.18 WSL host. A credential-free Node startup and Bun child-process probe reproduce the failure. Returning `ENOSYS` permits the existing fallback without adding any syscall allowance. With this rule, the same host passes Node startup, Bun codemode process termination/recovery, built-in URL-client checks, and sandbox-enabled full Chromium launch plus offline HTTP page navigation.

The profile defaults to `SCMP_ACT_ERRNO` and adds `clone`, `setns` and `unshare` permissions for Chromium's user-namespace sandbox. Compose applies it to the non-root bot container and all its subprocesses. It does not grant container capabilities, privileged mode or unrestricted seccomp. The host must also permit unprivileged user namespaces; do not bypass a host prohibition by disabling Chromium's sandbox.

Do not change the upstream policy without reviewing the change. Regression tests compare the parsed policy's checksum so normal repository formatting does not invalidate provenance. When updating, review the upstream policy diff and rerun the complete container smoke, including a sandbox-enabled full Chromium launch and explicit Playwright URL loading. Restore the previous image and Compose security policy together for rollback.
