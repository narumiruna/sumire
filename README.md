# Sumire

Monorepo for the Sumire Telegram AI bot and shared URL-loading packages.

## Projects

| Path | Purpose |
| --- | --- |
| [`apps/bot`](apps/bot/README.md) | Primary TypeScript bot built on Pi Durable and used by CI/CD. |
| [`packages/login`](packages/login/README.md) | Pi OAuth login client and extension, with a Telegram admin bridge. |
| [`packages/progress`](packages/progress/README.md) | Pi package for branch-aware structured progress state. |
| [`packages/url-content`](packages/url-content/README.md) | URL-content CLI and library with a bundled Pi skill. |

Bot-owned shared runtime resources stay at the repository root:

- `mcp.json`: optional administrator-owned MCP servers (Chrome DevTools and Firecrawl); disabled by default. See [MCP setup and deployment limits](apps/bot/README.md#mcp-servers-opt-in).
- `instructions/SYSTEM.md`: bot system prompt template.
- `instructions/SOUL.md`: bot persona and runtime context inserted into the template.
- `skills/`: Bot-owned Agent Skills; package-specific Pi skills live in their owning package's `skills/` directory.
- `.events` and `.telegramagent`: ignored runtime state.
- `.env`: ignored deployment and local configuration; copy it from `.env.example` for the TypeScript bot.

## TypeScript bot

Run the primary TypeScript bot with Docker Compose from the repository root:

```bash
cp .env.example .env
docker compose up -d --build
docker compose logs -f sumire
docker compose down
```

### Build cache

```bash
docker compose --progress plain build sumire
```

Docker BuildKit caches npm, pip, and apt downloads. Each workspace compiles in its own stage, so bot-only source changes reuse shared package builds, Chromium, and the audio stack. Tests and documentation are excluded from compilation inputs; skills and instructions are copied separately without recompiling TypeScript. Torch has a separate layer from Whisper and yt-dlp.

Keep the same Docker builder to reuse local cache; avoid `--no-cache` or pruning build cache unless a clean build is intended. Container publishing exports all intermediate layers to GitHub Actions cache (`mode=max`) for reuse on later runs. GitHub Actions cache does not preserve cache-mount contents, so changed dependency inputs may still require downloads on a fresh runner.

See the [TypeScript app README](apps/bot/README.md) for local development, configuration, and behavior.

## Node workspaces

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
npm test --workspace @narumitw/sumire-url-content
```

## Package releases

Add a Changesets file to every pull request:

```bash
npm run changeset
```

Use `npm run changeset -- --empty` when no package version should change. On each push to `main`, [`.github/workflows/publish.yml`](.github/workflows/publish.yml) uses Changesets to create or update a release pull request. Merging that pull request publishes the pending package versions to npm with provenance. Configure the `NPM_TOKEN` repository secret with publish access to the `@narumitw` scope, and allow GitHub Actions to create pull requests in the repository Actions settings.

## Security

Never commit `.env`, bot tokens, API keys, cookies, private URLs, or sensitive personal data. Keep `instructions/` free of secrets.
