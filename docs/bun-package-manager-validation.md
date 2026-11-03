# Bun Package Manager Validation

## Contract

- Use Bun 1.4.4 and external Node.js 26 or newer. The supported installer is `bun run install:dependencies`; its default is frozen installation.
- `bun.lock` is the only dependency lockfile. The hoisted linker preserves workspace links and Node.js tool resolution.
- Bun does not enforce the existing version-qualified `allowScripts` policy or `engine-strict`. Root `preinstall` is too late: dependency hooks have already run.
- `trustedDependencies: []`, `install.ignoreScripts = true`, and the installer's explicit `--ignore-scripts` disable automatic hooks. The installer checks runtimes, installed engines and every physical copy of approved package names before it runs any native command.
- Only the fixed Node.js installers for `esbuild@0.28.2` and `koffi@3.3.1` can run. Root development prepare uses local Husky; filtered installs preserve the existing optional prepare behavior when root tools are absent.
- Bun 1.4.4 forwards filtered script arguments into lifecycle hooks. Fixed-command `sh -c` wrappers keep focused test files and CLI options out of prerequisite builds.
- Vitest, Vite and Playwright remain on Node.js. Bot dev/start uses Bun and only the explicit root `.env`; existing environment values take priority.

## Local Evidence

Validation date: 2026-11-03. Host: macOS arm64, Node.js 26.10.0, standalone Bun 1.4.4. The host's global Bun installation was not changed.

| Check | Result |
| --- | --- |
| npm lock import | All 649 unique package identities, integrity values and dependency/optional/peer requirements unchanged |
| Engine comparison | All 78 distinct locked Node.js ranges agree between npm semver and Bun semver for external Node.js 26.10.0 |
| Clean supported install | Passed; 543 packages, approved native setup, no npm lockfile |
| Existing npm installation to Bun | Passed; legacy npm metadata and known tool caches remain usable |
| Installer and workspace regression tests | 28 passed; denied/transitive scripts, wrong nested versions, engines, frozen lock, production filters, child failure, termination, argument isolation and root-only env loading covered |
| Root `bun run format:check` | Passed |
| Root `bun run lint` | Passed |
| Root `bun run typecheck` | Passed after an explicit signal-only mock type replaced reliance on node-fetch 2's missing declarations |
| Root `bun run test` | 3,135 workspace tests and 28 script tests passed; one local native-library test skipped |
| Root `bun run build` | Passed; also passed from a clean disposable installation |
| Focused bot checks | Browser-runtime and file-download suites: 23 passed with file arguments isolated from pretest |
| Compiler-only entrypoints | All four passed without dependency source directories; Docker also uses these entrypoints |
| Prepack | All four package hooks passed; separate offline `npm pack` fixture executed prepack/build hooks and included build output |
| Changesets version | Actual manifests and pending changesets passed in a disposable checkout with networking denied; all 12 workspace changelogs updated, registry resolutions unchanged, no npm lockfile generated |
| Frozen recheck after versioning | Passed; lockfile hash unchanged |
| Workflow syntax | `actionlint` passed for CI and publish workflows |
| CI registry configuration | Authenticated loopback registry passed with runner-style `NPM_CONFIG_USERCONFIG` and a fixture `NODE_AUTH_TOKEN` |

The first integration run found and corrected an obsolete npm-lock assertion and a mock type that depended on npm's hoisting layout. A later concurrent stress run failed one existing MCP process test; a serial full root rerun passed without test or timeout changes. The existing Biome schema 2.6.3 versus CLI 2.6.4 notice is informational; this migration does not change formatting policy.

## Container and Browser Evidence

- Linux arm64 final runtime build passed with Bun 1.4.4 and Node.js 26.13.0.
  - Existing non-root, network-disabled checks passed: SQLite save/backup/reopen, native document conversion, DNS and connection pinning, codemode timeout/abort/close and recovery, Chromium launch, actual asynchronous curl I/O, URL failures and media tools.
  - An additional read-only check as uid 999 validated all 33 application symlinks and all nine runtime workspace exports under `/app`.
  - Biome, Changesets, Husky, Vitest, Vite, Playwright Test and admin Radix dependencies are absent from the production tree.
- Local Linux amd64 emulation reached the codemode smoke but failed its VM-started assertion. The check and its timeout were not weakened. The [native amd64 container CI](https://github.com/narumiruna/sumire/actions/runs/41576431185/job/125720894088) passed, including that smoke.
- Full Linux administration browser suite: rerun pending after correcting a popup-navigation wait. Durable comparison passed and produced all six before/after captures.
  - An initial macOS run was incomplete and had three browser failures; it is not acceptance evidence.
  - The first Linux source-transfer attempt included macOS AppleDouble files and failed discovery. The corrected transfer excludes metadata.
  - The complete two-worker Linux run had 638 passes and one failure: a popup still reported `about:blank` before navigation committed. The test now waits for its expected URL, with the original assertions and timeout unchanged.
  - A concurrent four-worker stress run had 55 passes and five fixture/setup failures before popup verification. Isolated validation remains required; these failures are not reported as passes.

## Release and Dependency Automation

Changesets CLI 3.0.3 detects the Bun workspace but retains its npm backend for registry info, pack and publish. The publish workflow retains Node.js, registry configuration, credentials, permissions and provenance. Authentication/provenance are source-reviewed, not live-publish verified. No packages, tags or releases were created during validation.

- [Changesets Action custom scripts](https://github.com/changesets/action/blob/ae32849d5ba541f9ae29e40e22a623bc13562f51/src/run.ts) accept `bun run version-packages` and `bun run release`.
- [Dependabot's supported managers](https://github.com/github/docs/blob/7fa55a0ac28d01b5cb6f9cbebff06fbee1e2408f/data/reusables/dependabot/supported-package-managers.md) specify ecosystem `bun` and text `bun.lock` support. Automatic Bun security-update PRs are not supported; weekly version updates are supported.
- [Dependabot's Bun implementation](https://github.com/dependabot/dependabot-core/tree/7ff94db9a3890e6689ad7613d33493c12a7b9cd1/bun) uses Bun 1.4.2 and supports this lockfile format. Every resulting PR must pass the repository's frozen Bun 1.4.4 installation.
- Read-only GitHub API checks found automatic security updates and vulnerability alerts already disabled on 2026-11-03. This change does not modify those settings or claim security-update feature parity.

Intentional npm uses remain in Changesets internals, external MCP commands and consumer examples. `.npmrc` remains for external npm CLI compatibility; the Bun installer enforces Node.js requirements itself.

## Remaining Limits

Production deployment and real Telegram/provider/MCP delivery are outside this change. No runtime volumes, durable state or production services were changed. Package publication, provenance issuance and hosted Dependabot updates were not executed as tests.
