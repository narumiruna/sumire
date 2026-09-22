# Sumire

Sumire's Telegram bot service, built on Pi and isolated under `./apps/bot`.

## Runtime stack

- `@earendil-works/pi-coding-agent`: complete per-chat `AgentSession` lifecycle, persistence, retry, compaction, steering, follow-up, tool loop, and Agent Skills.
- `@earendil-works/pi-agent-core`: official agent message and event contracts.
- `@earendil-works/pi-ai`: provider/model and media primitives.
- `@narumitw/sumire-progress`: repository-owned Pi package for structured multi-step progress.
- `@narumitw/sumire-url-tool`: repository-owned Pi package for agent-driven public URL loading.
- grammY: Telegram Bot API.
- Biome: formatting and linting.
- `@firecrawl/anydoc`: isolated local document-to-Markdown conversion without hosted OCR.
- `@narumitw/otter-cli`: non-interactive Otter expense management used by the bundled Agent Skill.
- Vitest: tests.

There is no custom agent loop and no Vercel AI SDK. Telegram code owns only update routing and the mapping from Telegram chat IDs to Pi sessions.

## Current implementation

Available now:

- private chat and group mention/reply routing
- allowlist and bot-loop limits
- `/start`, `/help`, `/id`, `/ask`, `/f`, `/cancel`, and `/reset`
- `/f` article rewriting and Morsel publication in Taiwan Traditional Chinese
- `/t` market-data queries for Yahoo Finance stocks/crypto, TWSE stocks, MAX crypto pairs, Frankfurter reference rates, and Bank of Taiwan TWD quotes
- isolated durable Pi JSONL session per Telegram chat
- Pi-managed retry, compaction, steering, follow-up, abort, tool loop, and persistence
- optional Pi `read`, `bash`, `edit`, and `write` coding tools for explicitly allowlisted deployments
- `instructions/SYSTEM.md`, `instructions/SOUL.md`, and filtered Agent Skills, including Otter expense management
- bounded Telegram image and document input
- native Pi reply-tree restoration when users reply to earlier completed bot output
- public HTTP(S)-only URL loading as a Pi tool, with bounded built-in extraction and source-aware URL content fallback
- Morsel rich-rendering tool and mandatory routing for messages over 1000 characters
- live multi-step progress as the first Telegram reply
- Telegram HTML rendering with a 1000-character inline message limit
- secret-redacted logs

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

The scripts load `../../.env` first and then `./.env` as an optional override. Paths such as `instructions`, `skills`, and `.telegramagent` resolve against the repository root. The system prompt is rendered from `instructions/SYSTEM.md`, which must contain exactly one `{{SOUL_SECTION}}` placeholder for `instructions/SOUL.md`. Skills are always loaded from `./skills`.

For development:

```bash
cd apps/bot
npm run dev -- --verbose
```

To use the `otter-manage-expenses` skill, set `OTTER_TOKEN` through the ignored `.env` or another deployment secret mechanism.
The upstream skill runs the bundled `otter` CLI through Pi's shell tool, so also set `BOT_CODING_TOOLS_ENABLED=true` and configure a non-empty `BOT_WHITELIST` containing only trusted users or chats.
Do not commit the token.

## Article command

Use `/f <內容>` to reorganize text into a coherent Markdown article in Taiwan Traditional Chinese. A bare `/f` can reply to a text message, public URL, image, or supported document. Reply and media inputs use the same bounded context assembly, feature controls, submission ordering, cancellation, and reply-tree restoration as ordinary Pi requests. Public URLs remain agent-driven and are loaded through `load_public_url`; Telegram does not prefetch them.

The writer request preserves material information, forbids new facts, uses specific emoji section headings, and limits each section to 1,000 characters and the complete article to fewer than 5,000 characters. Sumire publishes every successful `/f` result to Morsel and replies to the triggering message with only the article URL. `MORSEL_API_KEY` is therefore required for `/f`; if publication is unavailable, Sumire withholds the generated article and returns a short error.

## Market-data command

Use `/t` with one or more whitespace- or comma-separated symbols:

```text
/t AAPL          # Yahoo Finance stock
/t 2330          # TWSE/TPEX stock
/t 00980A        # TWSE active ETF
/t 2881A         # TWSE preferred share
/t BTC-USD       # Yahoo Finance cryptocurrency pair
/t BTCUSDT       # MAX Exchange cryptocurrency pair
/t USD           # Frankfurter USD/TWD reference rate and Bank of Taiwan quotes
/t JPY/TWD       # Frankfurter JPY/TWD reference rate and Bank of Taiwan quotes
/t TWDJPY        # Frankfurter TWD/JPY reference rate and reversed Bank of Taiwan quotes
/t USD/JPY       # Frankfurter USD/JPY reference rate
```

A request accepts at most 10 unique symbols. Bare supported three-letter currencies are treated as foreign-currency queries against TWD. Supported fiat pairs can be written as `TWDJPY`, `TWD/JPY`, `TWD-JPY`, or `TWD_JPY`. Every fiat query returns the Frankfurter v2 daily reference mid-rate. Pairs involving TWD also return Bank of Taiwan spot and cash quotes; reversed TWD pairs are calculated from the bank's published quote and clearly marked. MAX-like suffixes are matched against the MAX markets catalogue; symbols absent from that catalogue (such as `GBTC`) fall back to Yahoo Finance. If the catalogue request fails, candidates still try Yahoo; the original MAX error is retained when no fallback returns data. Failures querying listed MAX markets are not retried through Yahoo.

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

`.env.example` lists the complete supported environment configuration. The runtime registers the configured OpenAI-compatible provider. The bounded public URL loader and structured progress tool are always enabled. Pi's `read`, `bash`, `edit`, and `write` coding tools are disabled by default; enable them with `BOT_CODING_TOOLS_ENABLED=true`. Startup rejects that opt-in unless `BOT_WHITELIST` contains at least one Telegram user or chat ID. Morsel is enabled when `MORSEL_API_KEY` is configured and is required for `/f` article publication and replies over 1,000 characters. For multi-step requests, the first non-empty `update_progress` snapshot creates the Telegram reply and later snapshots edit it in place. Requests without structured progress send the final answer directly, without a generic pending message.

The coding-tool flag is not a sandbox. When enabled, the tools run directly with the bot process's filesystem permissions and working directory; Sumire does not restrict tool paths, and `bash` inherits the process environment, including `OTTER_TOKEN`. Use the opt-in only for trusted allowlisted users inside an appropriately isolated deployment. With coding tools disabled, an empty whitelist retains the existing behavior of allowing every Telegram user and chat.

The repository vendors the reviewed `otter-manage-expenses` skill from [narumiruna/otter](https://github.com/narumiruna/otter) and installs `@narumitw/otter-cli` as a pinned runtime dependency. The production image adds its npm binary directory to `PATH`; Compose passes `OTTER_TOKEN` from the ignored root `.env` without copying it into the image.

## Telegram message length and Morsel

Every outgoing text message and edit uses the same delivery policy, including AI answers, commands such as `/t`, and progress updates. Messages over **1000 characters** must be published to Morsel in full; Telegram receives only a short notice and the share URL. Exactly 1000 characters can be sent directly. Length is counted as Unicode code points after control-character cleanup and newline normalization, before HTML escaping; whitespace and Markdown syntax count toward the limit.

Set `MORSEL_API_KEY` to enable publication. If the key is missing, publishing fails, or the returned link cannot fit, Telegram receives only a short failure notice with the sanitized, bounded failure reason. The original long message is never sent inline, split into chunks, or recorded as successfully delivered. The policy applies regardless of the optional rich-tool mode, and legacy thresholds cannot raise the 1000-character cap. Successful Morsel links retain reply-tree checkpoint mapping; `/reset` invalidates pending delivery so stale links do not replace the cancelled status.

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

The [`@narumitw/sumire-url-tool`](../../packages/url-tool/README.md) Pi extension registers `load_public_url`. It validates the original target as public HTTP(S), then tries the bounded built-in text/HTML loader. It falls back to the local `@narumitw/sumire-url-content` workspace package when built-in loading fails, returns a blocker page, or encounters source-specific content. Threads post URLs go directly to bounded metadata extraction so the JavaScript application shell cannot be mistaken for the post. The package handles richer sources such as transcripts, social posts, PDFs, GitHub files, and browser-rendered pages.

The agent can optionally request one of the bot's approved exact loaders: `built-in`, `httpx`, `curl-cffi`, `playwright`, or `firecrawl`. Omission keeps automatic selection; an explicit selection runs only that loader and reports its failure without switching to another path. `firecrawl` requires `FIRECRAWL_API_KEY`. This fixed host allowlist prevents arbitrary registered loaders from being selected through the tool call.

`BOT_URL_TIMEOUT_SECONDS` and `BOT_URL_MAX_EXTRACTED_CHARS` control the built-in loader's timeout and output limit; `BOT_URL_CONTENT_TIMEOUT_SECONDS` controls the source-aware timeout. `BOT_URL_ALLOWED_SCHEMES` can restrict loading to HTTP, HTTPS, or both. Every path retains its deadlines, cancellation, and bounded output; source-aware loaders also retain their concurrency admission. Unsafe local, private, link-local, and metadata targets are rejected before the selected loader is invoked.

Telegram sends URL-only messages, summary requests, and short follow-ups through the normal Pi conversation path. The agent decides when to call `load_public_url`; the Telegram router does not prefetch URLs or retain pending URL state. Tool results and follow-up context use Pi's native session lifecycle.

## Docker

Build and run from the repository root so the Dockerfile can copy `apps/bot/` and `instructions/`:

```bash
docker build -t sumire:local .
docker compose up -d --build
docker compose logs -f sumire
docker compose down
```

The image builds the local URL tool and URL content workspace packages, includes the AnyDoc Linux native adapter, and installs Playwright Chromium with its runtime dependencies.

## Feature controls

The root [`.env.example`](../../.env.example) lists document, reply-tree, and image flags plus URL tool limits. Document input, reply-tree routing, and image input can be disabled independently without disabling ordinary Pi chat or `load_public_url`. Reply indexes use bounded durable retention per chat.
