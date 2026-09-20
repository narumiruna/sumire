# Sumire

Primary Sumire service used by CI/CD, isolated under `./apps/bot`; the Python implementation remains available for local development and reference.

## Runtime stack

- `@earendil-works/pi-coding-agent`: complete per-chat `AgentSession` lifecycle, persistence, retry, compaction, steering, follow-up, tool loop, and Agent Skills.
- `@earendil-works/pi-agent-core`: official agent message and event contracts.
- `@earendil-works/pi-ai`: provider/model and media primitives.
- `@narumitw/sumire-progress`: repository-owned Pi package for structured multi-step progress.
- grammY: Telegram Bot API.
- Biome: formatting and linting.
- Vitest: tests.

There is no custom agent loop and no Vercel AI SDK. Telegram code owns only update routing and the mapping from Telegram chat IDs to Pi sessions.

## Current implementation

Available now:

- private chat and group mention/reply routing
- allowlist and bot-loop limits
- `/start`, `/help`, `/id`, `/ask`, `/cancel`, and `/reset`
- `/t` market-data queries for Yahoo Finance stocks/crypto, TWSE stocks, MAX crypto pairs, and Bank of Taiwan exchange rates
- isolated durable Pi JSONL session per Telegram chat
- Pi-managed retry, compaction, steering, follow-up, abort, tool loop, and persistence
- `SOUL.md` and filtered Agent Skills
- bounded Telegram image input
- public HTTP(S)-only URL loading as a Pi tool, with bounded built-in extraction and source-aware URL content fallback
- Morsel rich-rendering tool and smart long-reply routing
- live multi-step progress in the pending Telegram reply
- Telegram HTML rendering and 4096-character chunking
- secret-redacted logs

Not yet at Python parity:

- AnyDoc document conversion
- image generation command
- file-backed events and task management commands
- Telegram reply-tree to Pi session-tree mapping
- Yahoo Finance MCP, Firecrawl MCP, Gurume, and bounded container tools
- Logfire integration

Track these items in [`docs/plans/2026-04-12_typescript-migration-plan.md`](docs/plans/2026-04-12_typescript-migration-plan.md).

## Requirements

- Node.js 22.19 or newer
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

## Market-data command

Use `/t` with one or more whitespace- or comma-separated symbols:

```text
/t AAPL          # Yahoo Finance stock
/t 2330          # TWSE/TPEX stock
/t 00980A        # TWSE active ETF
/t 2881A         # TWSE preferred share
/t BTC-USD       # Yahoo Finance cryptocurrency pair
/t BTCUSDT       # MAX Exchange cryptocurrency pair
/t USD           # Bank of Taiwan USD/TWD rate
/t JPY/TWD       # Bank of Taiwan JPY/TWD rate
```

A request accepts at most 10 unique symbols. Bare supported three-letter currencies are treated as foreign-currency queries. MAX-like suffixes are matched against the MAX markets catalogue; symbols absent from that catalogue (such as `GBTC`) fall back to Yahoo Finance. If the catalogue request fails, candidates still try Yahoo; the original MAX error is retained when no fallback returns data. Failures querying listed MAX markets are not retried through Yahoo.

Yahoo candle fields use the latest candle position; missing fields are omitted rather than carried forward from an older session.

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

Each chat uses a Pi-native session directory:

```text
.telegramagent/sessions/<chat-id>/pi/*.jsonl
```

Pi owns the agent session lifecycle and transcript format. The TypeScript service does not read or rewrite Python `session-v2.jsonl` files. `/reset` removes only that chat's TypeScript Pi directory.

## Model configuration

`.env.example` lists the complete supported environment configuration. The runtime registers the configured OpenAI-compatible provider. Coding tools are disabled, the bounded public URL loader and structured progress tool are always enabled, and Morsel is enabled when `MORSEL_API_KEY` is configured. Multi-step requests edit the original `處理中…` reply with the latest model-reported step state; simple requests may finish without publishing progress.

## Logging

Logs are always written to stderr with Telegram tokens, API keys, authorization headers, cookies, passwords, and named secrets redacted. Set `LOGFIRE_TOKEN` to also send the same redacted `DEBUG`, `INFO`, `WARN`, and `ERROR` records to Pydantic Logfire under the `sumire` service. Logfire is optional; configuration, export, or shutdown failures fall back to stderr without stopping the bot.

## URL content loading

`load_public_url` validates the original target as public HTTP(S), then tries the bounded built-in text/HTML loader. It falls back to the local `@narumitw/sumire-url-content` workspace package when built-in loading fails, returns a blocker page, or encounters source-specific YouTube/X content. The package handles richer sources such as transcripts, social posts, PDFs, GitHub files, and browser-rendered pages.

The built-in loader uses a 15-second timeout and 12,000-character output limit; the source-aware loader uses a 180-second timeout. Both paths enforce deadlines and bounded output. Unsafe local, private, link-local, and metadata targets are rejected before the source-aware loader is invoked.

## Docker

Build and run from the repository root so the Dockerfile can copy `apps/bot/` and `SOUL.md`:

```bash
docker build -t sumire:local .
docker compose up -d --build
docker compose logs -f sumire
docker compose down
```

The image builds the local URL content workspace package and installs Playwright Chromium with its runtime dependencies. The Compose file intentionally uses a different service and image name from the Python deployment. Stop the Python service before starting this one with the same bot token.
