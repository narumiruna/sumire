# Sumire

Monorepo for the Sumire Telegram AI bot and shared URL-loading packages.

## Projects

| Path | Purpose |
| --- | --- |
| [`packages/contracts`](packages/contracts/README.md) | Shared management API data types. |
| [`packages/runtime-config`](packages/runtime-config/README.md) | Encrypted runtime secrets and non-confidential variables, managed in the Web UI. |
| [`packages/policy`](packages/policy/README.md) | Shared policy schemas and authorization rules. |
| [`apps/admin`](docs/admin-webui.md) | Passkey-authenticated Radix administration frontend, served by the bot. |
| [`apps/bot`](apps/bot/README.md) | Primary TypeScript bot built on Pi Durable and used by CI/CD. |
| [`packages/login`](packages/login/README.md) | Pi OAuth login client and extension. |
| [`packages/imagegen`](packages/imagegen/README.md) | Experimental bounded Codex image generation client with bot-owned Telegram delivery. |
| [`packages/progress`](packages/progress/README.md) | Pi package for branch-aware structured progress state. |
| [`packages/pi-polymarket`](packages/pi-polymarket/README.md) | Pi tools for official Polymarket client queries and host-authorized trading. Requires Node.js 26 or newer. |
| [`packages/url-reader`](packages/url-reader/README.md) | Source-aware URL reading library and CLI. |
| [`packages/pi-url-reader`](packages/pi-url-reader/README.md) | Pi URL-reading tool and bundled skills, backed by `url-reader`. |

Bot-owned shared runtime resources stay at the repository root:

- `mcp.json` (desktop) and `mcp.docker.json` (Compose): separate administrator-owned MCP configurations (Chrome DevTools and Firecrawl); enabled by default. Compose uses Playwright's Chromium with the official non-root seccomp profile. See [MCP setup and deployment limits](apps/bot/README.md#mcp-servers).
- `instructions/APPEND_SYSTEM.md`: bot instructions appended to Pi's default system prompt.
- `instructions/SOUL.md`: bot persona and runtime context inserted into the template.
- `skills/`: Bot-owned Agent Skills; package-specific Pi skills live in their owning package's `skills/` directory.
- `.events` and `.telegramagent`: ignored runtime state.
- `.env`: ignored credentials and Telegram authorization; copy it from `.env.example`. Bot credentials and the required administrator ID remain bootstrap settings. The required `BOT_ADMIN_ID` configures the [administration WebUI](docs/admin-webui.md) at `http://localhost:17465`. `ADMIN_ORIGIN` selects an HTTPS origin for remote access; `ADMIN_HOST` and `ADMIN_PORT` change the backend binding. Persisted policies are the only source of chat authorization; new databases deny all chats until approval. Other runtime limits remain fixed.

## TypeScript bot

Run the primary TypeScript bot with Docker Compose from the repository root:

```bash
cp .env.example .env
docker compose up -d --build
docker compose logs -f sumire
docker compose down
```

### Administration WebUI

See [WebUI setup, passkey login, permissions, and recovery](docs/admin-webui.md). The backend defaults to loopback port `17465`, selected after checking `listenr`. Use `docker compose up -d --build`, then send `/admin` to get the local passkey setup URL. For remote access, set `ADMIN_ORIGIN` and use an existing HTTPS reverse proxy. `compose.yaml` publishes only loopback port `17465`, not port 443.

Send `/allow` in a private chat or group to request access. The administrator opens the returned link, signs in with a Passkey, and explicitly approves the displayed chat. Localhost links must open on the Sumire host. Before upgrading from environment-based access, complete the Stage 1 review and backup workflow. Existing database permissions remain unchanged; environment allowlist values no longer grant access. Historical reviews remain available on the Audit page.

### Secrets and variables

Administrators manage service credentials and non-confidential values on **Secrets & variables**. Secrets use AES-256-GCM with the host-only `ENCRYPTION_KEY`; saved values are never returned to the browser. Approved bot capabilities read current stored values after settings application, without a bot restart. See [setup, migration, trust limits, and recovery](docs/runtime-config.md).

### Build cache

```bash
docker compose --progress plain build sumire
```

Docker BuildKit caches Bun, pip, and apt downloads. Each workspace compiles in its own stage, so bot-only source changes reuse shared package builds, Chromium, and the audio stack. Tests and documentation are excluded from compilation inputs; skills and instructions are copied separately without recompiling TypeScript. Torch has a separate layer from Whisper and yt-dlp. A shared artifact collects the complete package `dist` trees once for bot compilation and runtime packaging. Production manifests and dependencies remain separate from that artifact.

Keep the same Docker builder to reuse local cache; avoid `--no-cache` or pruning build cache unless a clean build is intended. Container publishing exports all intermediate layers to GitHub Actions cache (`mode=max`) for reuse on later runs. GitHub Actions cache does not preserve cache-mount contents, so changed dependency inputs may still require downloads on a fresh runner.

See the [TypeScript app README](apps/bot/README.md) for local development, configuration, and behavior. Before upgrading existing durable conversations, read the [native Pi Durable upgrade and recovery procedure](docs/pi-durable-native-upgrade.md).

## Workspaces

Use Bun 1.4.4 and a real Node.js 26 or newer executable on `PATH`. CI, release workflows, and Docker installation and build stages use the same Bun version. Node.js remains required for the `impers` host, codemode isolation, Vitest, Vite, Playwright, and external CLIs. npm remains available for external CLIs and the Changesets registry backend.

The root `package.json` manages `apps/*` and `packages/*` workspaces. The root text `bun.lock` is the only dependency lockfile; commit it with dependency changes. GitHub CI, container publishing, and deployment target `apps/bot`.

Run setup and checks from the repository root:

```bash
bun run install:dependencies
bun run build
bun run format
bun run format:check
bun run lint
bun run typecheck
bun run test
```

`bun run install:dependencies` is the supported install command and uses a frozen lockfile by default. Before installation, its Bun wrapper requires Bun 1.4.4 and external Node.js 26 or newer. It installs with dependency scripts disabled, then validates installed Node.js engines and native package identities against frozen `bun.lock` entries before running only the fixed `esbuild@0.28.2` and `koffi@3.3.1` scripts. Extracted `package.json` values alone cannot authorize scripts; nested copies and aliases must match their locked identities. Development setup also validates local Husky's locked identity before prepare.

The root `allowScripts` policy remains authoritative. `bunfig.toml` disables automatic environment loading (`env = false`), sets `[install] ignoreScripts = true`, and selects `linker = "hoisted"`; `trustedDependencies` is empty. Bun trust names cannot restrict package versions, and Bun does not enforce `engine-strict`. Do not use bare `bun install` or `--trust` for setup: the configuration blocks dependency scripts, but a bare install omits the wrapper's validation and native setup.

For an intentional lockfile refresh after manifest changes, use `bun run install:dependencies --lockfile-only`. This mode is not frozen and skips native setup. Run the normal wrapper afterward before building or testing. Production dependency setup uses `bun run install:dependencies --production --filter @narumitw/sumire`.

The root `biome.json` defines formatting and lint rules for all TypeScript workspaces and `scripts/`. Root tests run Node.js script regression tests before workspace Vitest suites. Use `bun run test`, not `bun test` or `--bun`: Node.js shebangs keep Vitest, Vite, and Playwright on Node.js. Workspace build hooks still build required dependencies.

Run `bun run precommit` to run the repository pre-commit checks manually.

Run a focused script with an exact workspace name, for example:

```bash
bun run --filter @narumitw/sumire-url-reader test
```

Consumer npm installation examples, npm registry references, and external MCP `npx` commands remain intentional; they do not install this repository's workspaces.

### Dependency updates

Dependabot runs weekly Bun version updates for `bun.lock`. Bun does not support automatic Dependabot security updates; this is not feature parity with the npm ecosystem. Repository automatic security updates and vulnerability alerts were already disabled; this migration does not change those settings.

See the [supported package managers](https://github.com/github/docs/blob/7fa55a0ac28d01b5cb6f9cbebff06fbee1e2408f/data/reusables/dependabot/supported-package-managers.md) and [Bun updater source](https://github.com/dependabot/dependabot-core/tree/7ff94db9a3890e6689ad7613d33493c12a7b9cd1/bun). The upstream updater uses Bun 1.4.2 and supports text lockfile format 2; repository frozen-install checks with Bun 1.4.4 must pass before merging an update.

## Package releases

Add a Changesets file to every pull request:

```bash
bun run changeset
```

Use `bun run changeset --empty` when no package version should change. `bun run version-packages` applies Changesets versions and refreshes `bun.lock` through the wrapper's lockfile-only mode. `bun run release` retains `changeset publish`; Changesets 3.0.3 recognizes Bun but still uses npm internally for registry info, pack, and publish. On each push to `main`, [`.github/workflows/publish.yml`](.github/workflows/publish.yml) uses Changesets to create or update a release pull request. Merging that pull request publishes the pending package versions to npm with provenance. Configure the `NPM_TOKEN` repository secret with publish access to the `@narumitw` scope, and allow GitHub Actions to create pull requests in the repository Actions settings.

### Deployment

The [Deploy workflow](.github/workflows/deploy.yml) runs when a `@narumitw/sumire@*` tag is pushed, for example `@narumitw/sumire@0.17.0`. Pushes to `main` and tags for other workspaces do not trigger deployment. Manual runs remain available through `workflow_dispatch`.

Changesets creates tags for the private bot package because `.changeset/config.json` enables `privatePackages.tag`. Include a changeset that bumps `@narumitw/sumire` when a shared-package change must be deployed. Each tag identifies a repository commit, so Docker Compose builds the bot and its dependencies from the same revision.

## Security

Never commit `.env`, bot tokens, API keys, cookies, private URLs, or sensitive personal data. Keep `instructions/` free of secrets.
