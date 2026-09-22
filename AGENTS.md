# Repository Guidelines

## Repository structure

- Work from the repository root unless a project command explicitly requires another directory.
- TypeScript bot code and docs live in `apps/bot/`; shared TypeScript packages live in `packages/`.
- The root `package.json` and `package-lock.json` own npm workspaces; do not move them into an app.
- Shared runtime resources remain at the root: `SOUL.md`, `skills/`, `.events/`, `.telegramagent/`, and `.env`.
- Treat `.venv/`, `node_modules/`, `dist/`, coverage files, caches, `.events/`, and `.telegramagent/` as generated state.

## Agent loop ownership

- Pi's `AgentSession`, created through `@earendil-works/pi-coding-agent` and backed by `pi-agent-core`, owns the model-turn and tool-call loop; submit work through `prompt`, `steer`, or `followUp` instead of implementing a second agent loop in the bot.
- The Telegram bot owns transport and orchestration around that loop, including command and addressing rules, input and context assembly, session lifecycle, cancellation, progress reporting, reply-tree restoration, and response delivery.
- Extensions and custom tools own their capability implementations, while Pi owns deciding when to invoke them and continuing the model turn with their results.
- Pass ordinary natural-language intent, including summary requests, to Pi without keyword or regex-based intent routing unless a feature explicitly requires deterministic routing.
- Shape model behavior with instructions, tool descriptions, response contracts, and structured fields; do not parse or repair model output or upstream warnings by matching text fragments.
- Use deterministic code for data integrity, including normalization, validation, filtering, pagination, and structured result shaping; use instructions for model interpretation and presentation.

## Commands

- Install Node dependencies and configure Husky with `npm ci`; format with `npm run format`, then run workspace checks with `npm run format:check`, `npm run lint`, `npm run typecheck`, and `npm test`.
- Keep TypeScript formatting and lint policy in the root `biome.json`; the Husky pre-commit hook runs the repository-local Biome only on staged files.
- Use `docker compose ...` for the TypeScript bot.
- GitHub CI, container publishing, releases, dependency updates, and deployment target `apps/bot/`.

## Security

- Never commit `.env`, bot tokens, API keys, cookies, private URLs, or sensitive personal data.
- Enforce the configured byte limit while streaming every Telegram file; do not rely solely on Telegram's `file_size` metadata.
- Keep `SOUL.md` runtime-facing and free of secrets.

## Git and commits

- Add a changeset to every pull request; bump every affected package as needed, including private packages that are not published, and use an empty changeset only when no package version should change.
