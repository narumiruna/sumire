# Sumire

Primary Sumire service used by CI/CD, isolated under `./apps/bot`; the Python implementation remains available for local development and reference.

## Runtime stack

- `@earendil-works/pi-coding-agent`: complete per-chat `AgentSession` lifecycle, persistence, retry, compaction, steering, follow-up, tool loop, and Agent Skills.
- `@earendil-works/pi-agent-core`: official agent message and event contracts.
- `@earendil-works/pi-ai`: provider/model and media primitives.
- `@narumitw/sumire-progress`: repository-owned Pi package for structured multi-step progress.
- grammY: Telegram Bot API.
- Biome: formatting and linting.
- `@firecrawl/anydoc`: isolated local document-to-Markdown conversion without hosted OCR.
- Vitest: tests.

There is no custom agent loop and no Vercel AI SDK. Telegram code owns only update routing and the mapping from Telegram chat IDs to Pi sessions.

## Current implementation

Available now:

- private chat and group mention/reply routing
- allowlist and bot-loop limits
- `/start`, `/help`, `/id`, `/ask`, `/cancel`, and `/reset`
- isolated durable Pi JSONL session per Telegram chat
- Pi-managed retry, compaction, steering, follow-up, abort, tool loop, and persistence
- `SOUL.md` and filtered Agent Skills
- bounded Telegram image and document input
- native Pi reply-tree restoration when users reply to earlier completed bot output
- public HTTP(S)-only URL loading as a Pi tool, with bounded built-in extraction and source-aware URL content fallback
- conservative proactive URL-only/summary routing with short in-memory follow-ups
- Morsel rich-rendering tool and smart long-reply routing
- live multi-step progress in the pending Telegram reply
- Telegram HTML rendering and 4096-character chunking
- secret-redacted logs

Not yet at Python parity:

- image generation command
- file-backed events and task management commands
- Yahoo Finance MCP, Firecrawl MCP, Gurume, and bounded container tools
- Logfire integration

Track these items in [`docs/plans/2026-04-12_typescript-migration-plan.md`](docs/plans/2026-04-12_typescript-migration-plan.md).

## Requirements

- Node.js 22.19 or newer
- Linux x86_64 with glibc for the production AnyDoc native adapter
- Telegram bot token
- OpenAI-compatible Chat Completions endpoint and API key
- Playwright Chromium for source-aware browser fallbacks

## Install and run

From the repository root:

```bash
cp .env.example .env
cd apps/bot
npm install
npx playwright install chromium
npm run build
npm start
```

The scripts load `../../.env` first and then `./.env` as an optional override. Paths such as `SOUL.md`, `skills`, and `.telegramagent` resolve against the repository root. Skills are always loaded from `./skills`.

For development:

```bash
cd apps/bot
npm run dev -- --verbose
```

Do not run the Python and TypeScript bots with the same `BOT_TOKEN` simultaneously. Both would consume the same long-polling update stream.

## Quality gates

```bash
cd apps/bot
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

Apply Biome formatting and safe fixes with:

```bash
npm run check:write
```

## Session storage

Each chat uses a Pi-native session directory plus a derived Telegram reply index:

```text
.telegramagent/sessions/<chat-id>/pi/*.jsonl
.telegramagent/sessions/<chat-id>/telegram-reply-index.json
```

Pi owns the agent session lifecycle, transcript, and branches. After a completed answer is delivered, the bounded index records only Telegram message IDs and the corresponding Pi session/entry IDs. Replying to any delivered chunk restores that native checkpoint with no abandoned-branch summary. Unknown, stale, evicted, or disabled mappings continue from the latest leaf and preserve ordinary quoted reply context. `/reset` removes both the chat's Pi data and reply index.

## Model configuration

`.env.example` lists the complete supported environment configuration. The runtime registers the configured OpenAI-compatible provider. Coding tools are disabled, the bounded public URL loader and structured progress tool are always enabled, and Morsel is enabled when `MORSEL_API_KEY` is configured. Multi-step requests edit the original `處理中…` reply with the latest model-reported step state; simple requests may finish without publishing progress.

## Logging

Logs are always written to stderr with Telegram tokens, API keys, authorization headers, cookies, passwords, and named secrets redacted. Set `LOGFIRE_TOKEN` to also send the same redacted `DEBUG`, `INFO`, `WARN`, and `ERROR` records to Pydantic Logfire under the `sumire` service. Logfire is optional; configuration, export, or shutdown failures fall back to stderr without stopping the bot.

## Document input

When `BOT_DOCUMENT_INPUT_ENABLED=true`, current and replied Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, CSV, and text-based PDF attachments are downloaded with byte and time bounds, then converted in a killable child process. Raw bytes remain in memory and are not persisted. Converted Markdown is truncated to one aggregate prompt budget and delimited as untrusted reference material. Scanned PDFs that require OCR, encrypted or malformed documents, timeouts, and resource-limit failures return direct Traditional Chinese errors without invoking Pi.

The production image currently qualifies the AnyDoc native adapter on Linux x86_64 glibc. Other architectures are not release-qualified even if upstream optional packages exist. Disable `BOT_DOCUMENT_INPUT_ENABLED` if the native adapter is unavailable.

## URL content loading

`load_public_url` validates the original target as public HTTP(S), then tries the bounded built-in text/HTML loader. It falls back to the local `@narumitw/sumire-url-content` workspace package when built-in loading fails, returns a blocker page, or encounters source-specific YouTube/X content. The package handles richer sources such as transcripts, social posts, PDFs, GitHub files, and browser-rendered pages.

The built-in loader uses a configurable timeout and output limit; the source-aware loader has a separate configurable timeout. Both paths enforce deadlines and bounded output. Unsafe local, private, link-local, and metadata targets are rejected before the source-aware loader is invoked.

When `BOT_PROACTIVE_ENABLED=true`, a URL-only message or explicit read/summary request is loaded once by the same safe service before Pi runs. A small set of short follow-ups, including `go`, `繼續`, and `抓抓看`, can reuse the last URL until its bounded in-memory TTL expires. Pending URLs are not persisted and are cleared by restart or `/reset`. Slash commands, multiple URLs, and mixed arbitrary questions stay on the normal Pi path; `load_public_url` remains available to Pi even when proactive routing is disabled.

## Docker

Build and run from the repository root so the Dockerfile can copy `apps/bot/` and `SOUL.md`:

```bash
docker build -t sumire:local .
docker compose up -d --build
docker compose logs -f sumire
docker compose down
```

The image builds the local URL content workspace package, includes the AnyDoc Linux native adapter, and installs Playwright Chromium with its runtime dependencies. The Compose file intentionally uses a different service and image name from the Python deployment. Stop the Python service before starting this one with the same bot token.

## Feature controls

The root [`.env.example`](../../.env.example) lists all document, reply-tree, proactive URL, and image flags and bounds. Each feature can be disabled independently without disabling ordinary Pi chat. Reply indexes and pending URLs use bounded retention: reply indexes are durable per chat, while pending URLs are intentionally in-memory only.
