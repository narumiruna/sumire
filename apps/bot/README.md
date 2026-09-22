# Sumire

Primary Sumire service used by CI/CD, isolated under `./apps/bot`; the Python implementation remains available for local development and reference.

## Runtime stack

- `@earendil-works/pi-coding-agent`: complete per-chat `AgentSession` lifecycle, persistence, retry, compaction, steering, follow-up, tool loop, and Agent Skills.
- `@earendil-works/pi-agent-core`: official agent message and event contracts.
- `@earendil-works/pi-ai`: provider/model and media primitives.
- `@narumitw/sumire-progress`: repository-owned Pi package for structured multi-step progress.
- `@narumitw/sumire-url-tool`: repository-owned Pi package for agent-driven public URL loading.
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
- `/t` market-data queries for Yahoo Finance stocks/crypto, TWSE stocks, MAX crypto pairs, and Bank of Taiwan exchange rates
- isolated durable Pi JSONL session per Telegram chat
- Pi-managed retry, compaction, steering, follow-up, abort, tool loop, and persistence
- `SOUL.md` and filtered Agent Skills
- bounded Telegram image and document input
- native Pi reply-tree restoration when users reply to earlier completed bot output
- public HTTP(S)-only URL loading as a Pi tool, with bounded built-in extraction and source-aware URL content fallback
- Morsel rich-rendering tool and mandatory routing for messages over 1000 characters
- live multi-step progress as the first Telegram reply
- Telegram HTML rendering with a 1000-character inline message limit
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

Each chat uses a Pi-native session directory plus a derived Telegram reply index:

```text
.telegramagent/sessions/<chat-id>/pi/*.jsonl
.telegramagent/sessions/<chat-id>/telegram-reply-index.json
```

Pi owns the agent session lifecycle, transcript, and branches. After a completed answer is delivered, the bounded index records only Telegram message IDs and the corresponding Pi session/entry IDs. Replying to a delivered message, including a Morsel link or a legacy continuation chunk, restores that native checkpoint with no abandoned-branch summary. Unknown, stale, evicted, or disabled mappings continue from the latest leaf and preserve ordinary quoted reply context. `/reset` removes both the chat's Pi data and reply index.

## Model configuration

`.env.example` lists the complete supported environment configuration. The runtime registers the configured OpenAI-compatible provider. Coding tools are disabled, the bounded public URL loader and structured progress tool are always enabled, and Morsel is enabled when `MORSEL_API_KEY` is configured. For multi-step requests, the first non-empty `update_progress` snapshot creates the Telegram reply and later snapshots edit it in place. Requests without structured progress send the final answer directly, without a generic pending message.

## Telegram message length and Morsel

Every outgoing text message and edit uses the same delivery policy, including AI answers, commands such as `/t`, and progress updates. Messages over **1000 characters** must be published to Morsel in full; Telegram receives only a short notice and the share URL. Exactly 1000 characters can be sent directly. Length is counted as Unicode code points after control-character cleanup and newline normalization, before HTML escaping; whitespace and Markdown syntax count toward the limit.

Set `MORSEL_API_KEY` to enable publication. If the key is missing, publishing fails, or the returned link cannot fit, Telegram receives only a short failure notice. The original long message is never sent inline, split into chunks, or recorded as successfully delivered. The policy applies regardless of the optional rich-tool mode, and legacy thresholds cannot raise the 1000-character cap. Successful Morsel links retain reply-tree checkpoint mapping; `/reset` invalidates pending delivery so stale links do not replace the cancelled status.

## Logging

Logs are always written to stderr with Telegram tokens, API keys, authorization headers, cookies, passwords, and named secrets redacted. Set `LOGFIRE_TOKEN` to also send the same redacted `DEBUG`, `INFO`, `WARN`, and `ERROR` records to Pydantic Logfire under the `sumire` service. Logfire is optional; configuration, export, or shutdown failures fall back to stderr without stopping the bot.

Telegram polling retries transient failures such as `ECONNRESET` every five seconds, also honoring Telegram's `retry_after` when rate-limited. Failures use the redacting logger rather than grammY's raw console output: one warning per minute during an outage, followed by a recovery message. Unauthorized-token (`401`) and competing-poller (`409`) errors stop the process immediately; other polling failures stop it after the runner's 15-hour retry window. Fatal errors are also redacted and exit with a nonzero status so Compose can restart the service.

If polling warnings continue, check the container's outbound HTTPS connection to `api.telegram.org`, including any VPN, proxy, or firewall. Retries cannot fix a blocked network. If a token has appeared in old logs, revoke it via @BotFather, replace `BOT_TOKEN` in `.env`, and rebuild/recreate the service with `docker compose up -d --build sumire`.

## Document input

Public Office, OpenDocument, RTF, EPUB, and CSV URLs can also be loaded through `load_public_url` using the URL content package's `anydoc` loader. URL documents and Telegram attachments share the isolated child-process conversion runner; their admission limits remain separate. Native conversion is local and hosted OCR is disabled.

When `BOT_DOCUMENT_INPUT_ENABLED=true`, current and replied Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, CSV, and text-based PDF attachments are downloaded with byte and time bounds, then converted in a killable child process. Raw bytes remain in memory and are not persisted. Converted Markdown is truncated to one aggregate prompt budget and delimited as untrusted reference material. Scanned PDFs that require OCR, encrypted or malformed documents, timeouts, and resource-limit failures return direct Traditional Chinese errors without invoking Pi.

`BOT_DOCUMENT_MAX_CONCURRENT_CONVERSIONS` limits the entire download-and-convert operation across all chats and both current/replied attachments. A shared slot is acquired before Telegram `getFile` or download starts and retained until conversion settles, including child-process close after errors or timeouts. Waiting jobs retain only attachment metadata and a lazy loader, not downloaded bytes. With the defaults, at most two 20,000,000-byte document inputs are admitted (40,000,000 input bytes); download/IPC copies, native conversion memory, images, and runtime overhead are additional, so this is not a total process-memory cap. Download and conversion failures release their slot for queued work.

`/cancel` invalidates pending input in that chat before invoking Pi's native cancellation. Queued document loaders are skipped, late results/errors do not reach Pi or produce stale replies, and new messages can proceed. Downloads or native conversions already in flight retain their slot and drain to completion or their existing timeout; cancellation does not claim to terminate these operations immediately.

Replying to a document with `/ask <question>` uses the same bounded media-input pipeline as an addressed message, including feature flags, direct failures, cancellation, and reply-tree restoration. An empty `/ask` still returns usage without processing attachments.

The production image currently qualifies the AnyDoc native adapter on Linux x86_64 glibc. Other architectures are not release-qualified even if upstream optional packages exist. Disable `BOT_DOCUMENT_INPUT_ENABLED` if the native adapter is unavailable.

## URL content loading

The [`@narumitw/sumire-url-tool`](../../packages/url-tool/README.md) Pi extension registers `load_public_url`. It validates the original target as public HTTP(S), then tries the bounded built-in text/HTML loader. It falls back to the local `@narumitw/sumire-url-content` workspace package when built-in loading fails, returns a blocker page, or encounters source-specific YouTube/X content. The package handles richer sources such as transcripts, social posts, PDFs, GitHub files, and browser-rendered pages.

`BOT_URL_TIMEOUT_SECONDS` and `BOT_URL_MAX_EXTRACTED_CHARS` control the built-in loader's timeout and output limit; `BOT_URL_CONTENT_TIMEOUT_SECONDS` controls the source-aware timeout. `BOT_URL_ALLOWED_SCHEMES` can restrict loading to HTTP, HTTPS, or both. Both paths enforce deadlines and bounded output. Unsafe local, private, link-local, and metadata targets are rejected before the source-aware loader is invoked.

Telegram sends URL-only messages, summary requests, and short follow-ups through the normal Pi conversation path. The agent decides when to call `load_public_url`; the Telegram router does not prefetch URLs or retain pending URL state. Tool results and follow-up context use Pi's native session lifecycle.

## Docker

Build and run from the repository root so the Dockerfile can copy `apps/bot/` and `SOUL.md`:

```bash
docker build -t sumire:local .
docker compose up -d --build
docker compose logs -f sumire
docker compose down
```

The image builds the local URL tool and URL content workspace packages, includes the AnyDoc Linux native adapter, and installs Playwright Chromium with its runtime dependencies. The Compose file intentionally uses a different service and image name from the Python deployment. Stop the Python service before starting this one with the same bot token.

## Feature controls

The root [`.env.example`](../../.env.example) lists document, reply-tree, and image flags plus URL tool limits. Document input, reply-tree routing, and image input can be disabled independently without disabling ordinary Pi chat or `load_public_url`. Reply indexes use bounded durable retention per chat.
