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

For coding agents, see [Issues MCP setup](docs/issues-mcp.md) to read feedback and screenshots, or manage issues with OAuth write access.

### Secrets and variables

Administrators manage service credentials and non-confidential values on **Secrets & variables**. Secrets use AES-256-GCM with the host-only `ENCRYPTION_KEY`; saved values are never returned to the browser. Approved bot capabilities read current stored values after settings application, without a bot restart. See [setup, migration, trust limits, and recovery](docs/runtime-config.md).

### Build cache

```bash
docker compose --progress plain build sumire
```

Docker BuildKit caches npm, pip, and apt downloads. Each workspace compiles in its own stage, so bot-only source changes reuse shared package builds, Chromium, and the audio stack. Tests and documentation are excluded from compilation inputs; skills and instructions are copied separately without recompiling TypeScript. Python remains only for pinned `yt-dlp[default,deno]`; the image does not install PyTorch or `openai-whisper`.

Keep the same Docker builder to reuse local cache; avoid `--no-cache` or pruning build cache unless a clean build is intended. Container publishing exports all intermediate layers to GitHub Actions cache (`mode=max`) for reuse on later runs. GitHub Actions cache does not preserve cache-mount contents, so changed dependency inputs may still require downloads on a fresh runner.

Audio uses Transformers.js 4.3.2 in one shared, serial, killable Node.js inference
child for URL fallback and Telegram audio. The default is multilingual
`Xenova/whisper-tiny` at revision
`5332fcc35e32a33b86612b9a57a89be7906102b1`, CPU `q8`, with two inference threads.
The first transcription downloads weights into `/app/.cache/transformers`,
persisted by `transformers-cache`. Imports and caption-only requests need no
weights. Keep the old `whisper-cache` volume for rollback; its Python weights
cannot be reused by ONNX. No runtime variable is added. See
[local audio operation and verification](apps/bot/README.md#local-audio-transcription)
for limits, native platform requirements, and unverified production checks.

See the [TypeScript app README](apps/bot/README.md) for local development, configuration, and behavior. Before upgrading existing durable conversations, read the [native Pi Durable upgrade and recovery procedure](docs/pi-durable-native-upgrade.md).

## Node workspaces

Use Node.js 26 or newer for local commands. CI, release workflows, and Docker images use Node.js 26.

The root `package.json` manages `apps/*` and `packages/*` npm workspaces. GitHub CI, container publishing, and deployment target `apps/bot`.

The root `biome.json` defines formatting and lint rules for all TypeScript
workspaces. `npm ci` installs the root tools. Install
[prek](https://prek.j178.dev/installation/) and run `prek install` to enable the
pre-commit hooks defined in `prek.toml`.

For an existing Husky checkout, check `git config --local --get core.hooksPath`.
If it is `.husky/_`, run `git config --local --unset core.hooksPath` before
`prek install`.

The hooks preserve the original repository-wide sequence:
`biome migrate --write`, `biome format --write`, then `biome check --write`.
All three steps use the official
[Biome hook repository](https://biomejs.dev/recipes/git-hooks/#pre-commit), which
prek installs in an isolated environment on the first run. The repository has
no migrate hook, so the first step overrides `biome-ci` to run
`biome migrate --write`, with the alias `biome-migrate`. Formatting and checks
use `biome-format` and `biome-check` without command overrides. Keep the Biome
versions in `prek.toml` aligned with the root `package.json`.

All three Biome hooks run even when no staged files match. The run stops if a
hook fails or changes files. Review and stage any fixes, then retry the commit.

After Biome, the official
[zizmor hook](https://github.com/zizmorcore/zizmor-pre-commit) checks supported
staged YAML files for security issues in GitHub Actions, Dependabot, and
pre-commit configuration. It uses upstream defaults without automatic fixes.
Run `prek run zizmor --all-files` to check all tracked supported configurations.

```bash
npm ci
prek install
npm run build
npm run format
npm run format:check
npm run lint
npm run typecheck
npm test
```

Run `npm run precommit` (or `prek run`) to run the configured hooks manually:
Biome checks the whole repository, while zizmor checks matching staged files.
Use `prek run --all-files` to include all tracked supported files or test a new
or unstaged `prek.toml`.

Run one workspace with `--workspace`, for example:

```bash
npm test --workspace @narumitw/sumire-url-reader
```

## Pull request reviews

The Pi-based PR Review workflow was removed in [#285](https://github.com/narumiruna/sumire/pull/285). Its workflow-specific tests and CI path filters are retired. See the [retirement and credential note](docs/review-workflow.md).

## Package releases

Sumire has one release version, stored in [`apps/bot/package.json`](apps/bot/package.json).
For changes that should ship, including admin or shared-package changes, run
`npm run changeset` and select only `@narumitw/sumire`. See the [changeset guide](.changeset/README.md).
Other workspaces keep their existing manifest versions for internal dependency
resolution; they are not released separately.

On each push to `main`, the [release workflow](.github/workflows/publish.yml)
uses Changesets to maintain a release pull request or tag an untagged Sumire
version. It uses the `PAT_TOKEN` repository secret for GitHub operations and
does not publish to npm.

### Deployment

The [Deploy workflow](.github/workflows/deploy.yml) runs when a `@narumitw/sumire@*` tag is pushed, for example `@narumitw/sumire@0.17.0`. Pushes to `main` and tags for other workspaces do not trigger deployment. Manual runs remain available through `workflow_dispatch`.

Each tag identifies a repository commit, so Docker Compose builds the bot and
its dependencies from the same revision.

## Security

Never commit `.env`, bot tokens, API keys, cookies, private URLs, or sensitive personal data. Keep `instructions/` free of secrets.
