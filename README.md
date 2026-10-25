# Sumire

Monorepo for the Sumire Telegram AI bot and shared URL-loading packages.

## Projects

| Path | Purpose |
| --- | --- |
| [`packages/contracts`](packages/contracts/README.md) | Shared management API data types. |
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

### Build cache

```bash
docker compose --progress plain build sumire
```

Docker BuildKit caches npm, pip, and apt downloads. Each workspace compiles in its own stage, so bot-only source changes reuse shared package builds, Chromium, and the audio stack. Tests and documentation are excluded from compilation inputs; skills and instructions are copied separately without recompiling TypeScript. Torch has a separate layer from Whisper and yt-dlp.

Keep the same Docker builder to reuse local cache; avoid `--no-cache` or pruning build cache unless a clean build is intended. Container publishing exports all intermediate layers to GitHub Actions cache (`mode=max`) for reuse on later runs. GitHub Actions cache does not preserve cache-mount contents, so changed dependency inputs may still require downloads on a fresh runner.

See the [TypeScript app README](apps/bot/README.md) for local development, configuration, and behavior. Before upgrading existing durable conversations, read the [native Pi Durable upgrade and recovery procedure](docs/pi-durable-native-upgrade.md).

## Node workspaces

Use Node.js 26 or newer for local commands. CI, release workflows, and Docker images use Node.js 26.

The root `package.json` manages `apps/*` and `packages/*` npm workspaces. GitHub CI, container publishing, and deployment target `apps/bot`.

The root `biome.json` defines formatting and lint rules for all TypeScript workspaces. `npm ci` installs the root tools and configures Husky. The pre-commit hook runs the repository-local Biome on staged files, applies safe fixes, and updates those staged files.

```bash
npm ci
npm run build
npm run format
npm run format:check
npm run lint
npm run typecheck
npm test
```

Run `npm run precommit` to check staged files manually.

Run one workspace with `--workspace`, for example:

```bash
npm test --workspace @narumitw/sumire-url-reader
```

## Package releases

Add a Changesets file to every pull request:

```bash
npm run changeset
```

Use `npm run changeset -- --empty` when no package version should change. On each push to `main`, [`.github/workflows/publish.yml`](.github/workflows/publish.yml) uses Changesets to create or update a release pull request. Merging that pull request publishes the pending package versions to npm with provenance. Configure the `NPM_TOKEN` repository secret with publish access to the `@narumitw` scope, and allow GitHub Actions to create pull requests in the repository Actions settings.

## Security

Never commit `.env`, bot tokens, API keys, cookies, private URLs, or sensitive personal data. Keep `instructions/` free of secrets.
