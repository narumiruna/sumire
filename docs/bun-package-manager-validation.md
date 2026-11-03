# Bun Package Manager Validation

## Contract

- Use Bun 1.4.4 and external Node.js 26 or newer. The supported installer is `bun run install:dependencies`; its default is frozen installation.
- `bun.lock` is the only dependency lockfile. The hoisted linker preserves workspace links and Node.js tool resolution.
- Bun does not enforce version-qualified `allowScripts` or `engine-strict`. Root `preinstall` runs after dependency hooks and cannot protect this boundary.
- `trustedDependencies: []`, `install.ignoreScripts = true`, and explicit `--ignore-scripts` disable automatic hooks. The installer validates runtimes, installed engines and locked identities before executing any setup command.
- Native authorization requires the installed locator's frozen lock identity, extracted manifest and approved `esbuild@0.28.2` or `koffi@3.3.1` identity to agree. Extracted package metadata alone cannot authorize scripts. Aliases and nested/workspace-local copies retain their own locators.
- Development prepare requires genuine locked local Husky. Filtered installs preserve the existing optional prepare behavior when root tools are absent.
- Bun forwards filtered script arguments into lifecycle hooks. Fixed-command `sh -c` wrappers keep focused test files and CLI options out of prerequisite builds.
- Vitest, Vite and Playwright stay on Node.js. Bot dev/start uses Bun and only the explicit root `.env`; existing environment values take priority.

## Final Local Verification

Validation date: 2026-11-03. The final checks used Linux arm64, Node.js 26.13.0 and Bun 1.4.4. Earlier host checks used macOS arm64 and Node.js 26.10.0. The host's global Bun installation was not changed.

| Check | Evidence |
| --- | --- |
| npm lock import | All 649 unique package identities, integrity values and dependency/optional/peer requirements unchanged |
| Engine comparison | All 78 distinct locked Node.js ranges agree with npm semver for external Node.js 26.10.0 |
| Clean supported install | Passed; approved native setup and no npm lockfile |
| Frozen dev/production filters | Passed with the new identity guard; production excludes root/admin development tools |
| Installer and workspace regressions | 50 passed in the bounded, network-disabled sandbox; no skips |
| Root `bun run format:check` | Passed in the isolated Linux source copy |
| Root `bun run lint` | Passed |
| Root `bun run typecheck` | Passed |
| Root `bun run test --maxWorkers=2` | 3,186 passed: 3,136 workspace tests and 50 script tests; no skips |
| Root `bun run build` | Passed, including cold workspace dependency builds |
| Focused bot checks | Browser-runtime and file-download suites: 23 passed with arguments isolated from pretest |
| Browser suite | 639 passed; all 60 isolated popup repetitions also passed |
| Durable comparison | Six before/after captures produced; frontend sources are unchanged by the final installer fix |
| Compiler-only/prepack | Four compiler-only entrypoints passed without dependency sources; all four prepack hooks passed |
| Changesets version | Actual manifests/changesets passed with networking denied; registry resolutions unchanged; frozen recheck kept the same hash; no npm lockfile |
| Registry authentication | Authenticated loopback registry passed with runner-style `NPM_CONFIG_USERCONFIG` and a fixture `NODE_AUTH_TOKEN` |
| Workflow syntax | `actionlint` passed for CI and publish workflows |

### Sandbox and Native Image

The hostile archive fixtures run with no external network, an empty allowlisted environment, read-only source/toolchain, scratch-only writes, an init reaper and explicit CPU, memory, process, file-size and wall-clock limits. Assertions still require terminated descendants to disappear; zombies are not counted as passing cleanup.

The full Linux root check uses the same isolation model with a disposable source/dependency copy. Its resource limit requires two Vitest workers; test cases, assertions and timeouts are unchanged. A public `example.com` hosts fixture supplies deterministic DNS, and the pinned `LIBCURL_PATH` permits the real native test. Without those harness inputs, the first restricted run failed DNS/native startup; that run is not counted as a pass.

Linux arm64 final runtime builds passed after the identity fix. The final image is unchanged: `sha256:dce6795a381a79f713742782aa460e77903e89053c85d59fdef49db20f7da749`. Additional read-only, network-disabled execution as uid 999 passed SQLite save/backup/reopen, native document conversion, DNS and connection pinning, codemode timeout/abort/close and recovery, Chromium launch, real asynchronous curl I/O, URL failure diagnostics and media-tool checks.

All 33 application symlinks and nine runtime workspace exports resolve under `/app`. Biome, Changesets, Husky, Vitest, Vite, Playwright Test and admin Radix dependencies are absent from the production tree.

Native amd64 `runtime-application` checks and full hosted checks are enforced by CI. [PR #228 checks](https://github.com/narumiruna/sumire/pull/228/checks) report the current head; earlier full migration runs also passed. Local amd64 emulation failed the unchanged VM-started assertion, so it is not amd64 acceptance evidence.

## Failures Found and Corrected

- The original lock test still read `package-lock.json`; it now checks the locked Playwright identity through Bun's JSONC loader.
- Bun's hoisting exposed node-fetch 2's missing declarations. The cancellation mock now declares only the signal field it uses; runtime download behavior is unchanged.
- A popup can remain at `about:blank` before its navigation commits. The test now waits for its expected URL and retains the URL, visible content, parent-page assertions and timeout.
- Concurrent stress runs had fixture/MCP timing failures. Later serial root checks, isolated popup repetitions and the complete browser suite passed without relaxing tests. An initial macOS browser run was incomplete; a Linux transfer containing AppleDouble metadata also failed discovery. Neither is acceptance evidence.
- The first installer trusted extracted `package.json` names/versions. A tarball for an unapproved registry version could claim the approved version and execute its installer. The fix binds authorization to frozen lock identities before any native or prepare command. Regression cases cover direct/nested aliases, forged names/versions, Husky impersonation, unlocked native leftovers and valid native closures; rejected cases produce zero hook markers.
- A whole-build attempt with networking disabled could not download Playwright. The normal build passed and retained every existing network-disabled runtime smoke check.

The existing Biome schema 2.6.3 versus CLI 2.6.4 notice is informational. Commits use `HUSKY=0` after explicit checks to avoid the hook's repository-wide Biome migration; formatting policy is unchanged.

## Release and Dependency Automation

Changesets CLI 3.0.3 detects Bun but retains npm for registry info, pack and publish. The publish workflow retains Node.js, registry configuration, credentials, permissions and provenance. Installation authentication passed locally; publishing authentication/provenance is source-reviewed, not live-publish verified.

- [Changesets Action custom scripts](https://github.com/changesets/action/blob/ae32849d5ba541f9ae29e40e22a623bc13562f51/src/run.ts) accept `bun run version-packages` and `bun run release`.
- [Dependabot support](https://github.com/github/docs/blob/7fa55a0ac28d01b5cb6f9cbebff06fbee1e2408f/data/reusables/dependabot/supported-package-managers.md) specifies ecosystem `bun` and text `bun.lock`. Weekly version updates are supported; automatic Bun security-update PRs are not.
- [The Bun updater](https://github.com/dependabot/dependabot-core/tree/7ff94db9a3890e6689ad7613d33493c12a7b9cd1/bun) uses Bun 1.4.2 and supports this lock format. Every update must pass frozen installation with the repository's Bun 1.4.4.
- Read-only API checks found repository automatic security updates and vulnerability alerts already disabled. This change does not modify those settings or claim feature parity.

Intentional npm uses remain in Changesets, external MCP commands and consumer examples. `.npmrc` remains for external npm compatibility; the Bun wrapper enforces Node.js requirements itself.

## Limits

No package publication, tags, release dispatch, production deployment or real Telegram/provider/MCP delivery was performed. Runtime volumes and durable state were not changed. Hosted Dependabot updates and provenance issuance were not executed as tests.
