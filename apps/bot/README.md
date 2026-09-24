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
- Pi's native `read`, `bash`, `edit`, and `write` coding tools in every chat session
- `instructions/SYSTEM.md`, `instructions/SOUL.md`, and filtered Agent Skills, including Otter expense management
- bounded Telegram image, document, and locally transcribed voice/audio input
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
The upstream skill runs the bundled `otter` CLI through Pi's shell tool, so configure a `BOT_WHITELIST` containing only trusted users or chats before exposing the bot.
Do not commit the token.

## Article command

Use `/f <內容>` to reorganize text into a coherent Markdown article in Taiwan Traditional Chinese. A bare `/f` can reply to a text message, public URL, image, or supported document. Reply and media inputs use the same bounded context assembly, feature controls, submission ordering, cancellation, and reply-tree restoration as ordinary Pi requests. For `/f`, up to four distinct URLs explicitly present in the command or replied message are loaded concurrently with the bounded public URL loader before the article is submitted to Pi; the combined extracted content is capped by `BOT_URL_MAX_EXTRACTED_CHARS` and loading has a 30-second maximum. If any source URL fails or the configured character budget is too small for the number of URLs, `/f` reports the failure without publishing an incomplete article. Cancellation stops in-flight loads. Pi writes the article from the loaded, untrusted source context without reloading those URLs. Ordinary requests remain agent-driven and use `load_public_url`; Telegram does not prefetch them.

The blog post request preserves material information, forbids new facts, uses specific emoji section headings, and limits each section to 1,000 characters and the complete article to fewer than 5,000 characters. Sumire publishes every successful `/f` result to Morsel and replies to the triggering message with only the article URL. `MORSEL_API_KEY` is therefore required for `/f`; if publication is unavailable, Sumire withholds the generated article and returns a short error.

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

`.env.example` lists the complete supported environment configuration. The runtime registers the configured OpenAI-compatible provider. The bounded public URL loader and structured progress tool are always enabled. Pi's native `read`, `bash`, `edit`, and `write` coding tools are enabled for every session, alongside the progress and URL extension tools. Set a non-empty `BOT_WHITELIST=<trusted Telegram user ID>` in the ignored root `.env`, then restart the bot (`docker compose up -d --build sumire` for Compose). Startup fails if the whitelist is empty. A group chat ID allows anyone who can address the bot in that group to use the tools, so prefer trusted user IDs. Morsel is enabled when `MORSEL_API_KEY` is configured and is required for `/f` article publication and replies over 1,000 characters. After input preparation, the bot sends a `處理中…` reply before submitting to Pi. Pi execution events update the reply with model/tool activity even when the model does not call `update_progress`; generic activity edits are limited to one every two seconds, with the latest status retained. Non-empty `update_progress` snapshots show every reported step in order, including completed steps, instead of generic activity; clearing progress restores `處理中…` while the model works. After a completed answer, the last non-empty snapshot reported during that submission remains visible in the original reply, with a separate final answer; if the model cleared progress, the retained snapshot is labeled `最後回報的進度（已清除）` and does not imply every step finished. The bot does not invent steps or completion statuses. If no progress was successfully displayed, or the turn is cancelled or fails, the status is replaced by the result as before. After successful delivery, replies to either retained progress or the final answer restore the same answer branch. If editing the status or sending the final answer fails, the bot uses its existing fallback or error handling. Replies to an in-flight status do not quote its synthetic content to Pi, even if the status completes while their attachments are being prepared. Replies to an already displayed final answer retain their reply-tree context even before Telegram acknowledges the edit. Input validation, downloads, transcription, and article-source loading happen before this pending reply.

The coding tools run directly with the bot process's filesystem permissions and working directory; Sumire does not restrict tool paths, and `bash` inherits the process environment, including `OTTER_TOKEN`. In Compose, the working directory is `/app`: the image does not contain the host repository's source tree, and the mounted `instructions/` and `skills/` directories are read-only. The container is not a tool sandbox; restrict `BOT_WHITELIST` to trusted users or chats before deployment.

The repository vendors the reviewed `otter-manage-expenses` skill from [narumiruna/otter](https://github.com/narumiruna/otter) and installs `@narumitw/otter-cli` as a pinned runtime dependency. The production image adds its npm binary directory to `PATH`; Compose passes `OTTER_TOKEN` from the ignored root `.env` without copying it into the image.

## Telegram message length and Morsel

Every outgoing text message and edit uses the same delivery policy, including AI answers, commands such as `/t`, and progress updates. Messages over **1000 characters** must be published to Morsel in full; Telegram receives only a short notice and the share URL. Exactly 1000 characters can be sent directly. Length is counted as Unicode code points after control-character cleanup and newline normalization, before HTML escaping; whitespace and Markdown syntax count toward the limit.

Set `MORSEL_API_KEY` to enable publication. If the key is missing, publishing fails, or the returned link cannot fit, Telegram receives only a short failure notice with the sanitized, bounded failure reason. The original long message is never sent inline, split into chunks, or recorded as successfully delivered. The policy applies regardless of the optional rich-tool mode, and legacy thresholds cannot raise the 1000-character cap. Successful Morsel links retain reply-tree checkpoint mapping; `/reset` invalidates pending delivery so stale links do not replace the cancelled status. A full progress snapshot above 1,000 characters is available only through its Morsel link, not inline or in chunks; if publication fails, Telegram shows the failure notice rather than a partial step list.

## Logging

Logs are always written to stderr with Telegram tokens, API keys, authorization headers, cookies, passwords, and named secrets redacted. Set `LOGFIRE_TOKEN` to also send the same redacted `DEBUG`, `INFO`, `WARN`, and `ERROR` records to Pydantic Logfire under the `sumire` service. Logfire is optional; configuration, span, export, or shutdown failures fall back to stderr without stopping the bot. With Logfire enabled, each addressed request has a `telegram.request` span (chat/message/update IDs, input counts and a process-local HMAC-SHA-256 fingerprint for a URL-only message), with `pi.submit`, `url.load`, `telegram.deliver`, and `morsel.publish` child spans where applicable. `url.load` records the exact requested URL's fingerprint, the successful final hostname and fingerprint, the Pi tool-call ID, source/loader, character count, truncation and outcome. When source-aware loading runs, it also records bounded, allowlisted loader-attempt IDs, statuses, error types and codes (such as a Firecrawl API HTTP status or a typed TLS certificate failure); it does not add raw URLs, upstream error messages, prompts, extracted text or Morsel share links as custom span attributes. Pi tool start/end, session/branch selection, model token usage, retries and compaction have metadata-only logs. Match `telegram.input_url_fingerprint` against `url.fingerprint` within a trace to detect a wrong URL; equivalent but differently formatted URLs can have different fingerprints. The HMAC key changes on process restart. Existing auto-instrumented HTTP spans may still contain request URLs; restrict Logfire access accordingly.

Telegram polling retries transient failures such as `ECONNRESET` every five seconds, also honoring Telegram's `retry_after` when rate-limited. Failures use the redacting logger rather than grammY's raw console output: one warning per minute during an outage, followed by a recovery message. Unauthorized-token (`401`) and competing-poller (`409`) errors stop the process immediately; other polling failures stop it after the runner's 15-hour retry window. Fatal errors are also redacted and exit with a nonzero status so Compose can restart the service.

If polling warnings continue, check the container's outbound HTTPS connection to `api.telegram.org`, including any VPN, proxy, or firewall. Retries cannot fix a blocked network. If a token has appeared in old logs, revoke it via @BotFather, replace `BOT_TOKEN` in `.env`, and rebuild/recreate the service with `docker compose up -d --build sumire`.

## Document input

Public Office, OpenDocument, RTF, EPUB, and CSV URLs can also be loaded through `load_public_url` using the URL content package's `anydoc` loader. URL documents and Telegram attachments share the isolated child-process conversion runner; their admission limits remain separate. Native conversion is local and hosted OCR is disabled.

When `BOT_DOCUMENT_INPUT_ENABLED=true`, current and replied Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, CSV, and text-based PDF attachments are downloaded with byte and time bounds, then converted in a killable child process. Raw bytes remain in memory and are not persisted. Converted Markdown is truncated to one aggregate prompt budget and delimited as untrusted reference material. Scanned PDFs that require OCR, encrypted or malformed documents, timeouts, and resource-limit failures return direct Traditional Chinese errors without invoking Pi.

`BOT_DOCUMENT_MAX_CONCURRENT_CONVERSIONS` limits the entire download-and-convert operation across all chats and both current/replied attachments. A shared slot is acquired before Telegram `getFile` or download starts and retained until conversion settles, including child-process close after errors or timeouts. Waiting jobs retain only attachment metadata and a lazy loader, not downloaded bytes. With the defaults, at most two 20,000,000-byte document inputs are admitted (40,000,000 input bytes); download/IPC copies, native conversion memory, images, and runtime overhead are additional, so this is not a total process-memory cap. Download and conversion failures release their slot for queued work.

`/cancel` invalidates pending input in that chat before invoking Pi's native cancellation. Queued document loaders are skipped, late results/errors do not reach Pi or produce stale replies, and new messages can proceed. Downloads or native conversions already in flight retain their slot and drain to completion or their existing timeout; cancellation does not claim to terminate these operations immediately.

Replying to a document with `/ask <question>` uses the same bounded media-input pipeline as an addressed message, including feature flags, direct failures, cancellation, and reply-tree restoration. An empty `/ask` still returns usage without processing attachments.

The production image currently qualifies the AnyDoc native adapter on Linux x86_64 glibc. Other architectures are not release-qualified even if upstream optional packages exist. Disable `BOT_DOCUMENT_INPUT_ENABLED` if the native adapter is unavailable.

## Local audio transcription

The production image installs `yt-dlp`, FFmpeg, and the Python `openai-whisper` CLI with a CPU PyTorch runtime. The YouTube loader tries captions first, then downloads audio and transcribes it with the local `tiny` model; Instagram Reels use the same local audio transcription path. URL media remains subject to the public URL validation and the URL content timeout. It does not call OpenAI's hosted audio API.

Voice notes and audio attachments sent to Sumire (or replied to with an addressed message) are downloaded only when their conversion slot is free. The streamed download is bounded to `BOT_AUDIO_MAX_BYTES` (default 20 MB); Telegram's reported duration is checked against `BOT_AUDIO_MAX_DURATION_SECONDS` (default 600 s). This metadata check does not verify the actual audio duration: the transcription also has a 180-second deadline and a 12,000-character transcript limit. Only one Telegram audio input transcribes at once; each request uses a private temporary file removed after success or failure. Transcripts are passed to Pi as explicitly untrusted reference text alongside the caption or question. Use `BOT_AUDIO_INPUT_ENABLED=false` to disable this input without disabling video-link loading. Unsupported/corrupt audio, download errors, and missing local tools produce a direct error rather than an invented transcript. Cancellation skips queued work and suppresses late results; an already running transcription finishes or times out before freeing its slot.

The first use of the local `tiny` model downloads model weights. Compose keeps the cache in the `whisper-cache` volume, so later restarts do not repeat that download; the container needs network access for the first transcription. Local development requires `yt-dlp`, `whisper` from `openai-whisper`, and FFmpeg on `PATH`. This CPU-only stack increases image size and may take time to build or transcribe.

## URL content loading

The [`@narumitw/sumire-url-tool`](../../packages/url-tool/README.md) Pi extension registers `load_public_url`. It validates the original target as public HTTP(S), then tries the bounded built-in text/HTML loader. It falls back to the local `@narumitw/sumire-url-content` workspace package when built-in loading fails, returns a blocker page, or encounters source-specific content. Threads post URLs and `/share/<id>` links go directly to bounded metadata extraction so the JavaScript application shell or a dead-link page cannot be mistaken for a post. Share links require matching canonical and Open Graph post URLs; results may contain only the Open Graph excerpt, not the entire post. The package handles richer sources such as transcripts, social posts, PDFs, GitHub files, and browser-rendered pages.

The `load_public_url` tool and its bundled `load-public-url` skill are available by default. The separate `load-url-content` CLI skill from the URL-content package is also always available; it uses the native `bash` tool. The required `BOT_WHITELIST` restricts access to both coding tools and URL-loading capabilities.

The agent can optionally request one of the bot's approved exact loaders: `built-in`, `httpx`, `curl-cffi`, `playwright`, or `firecrawl`. Omission keeps automatic selection; an explicit selection runs only that loader and reports its failure without switching to another path. `firecrawl` requires `FIRECRAWL_API_KEY`; an HTTP error from that loader is attributed to the Firecrawl API, not the target site. A Threads share link cannot succeed with an unverified generic override. This fixed host allowlist prevents arbitrary registered loaders from being selected through the tool call.

`BOT_URL_TIMEOUT_SECONDS` and `BOT_URL_MAX_EXTRACTED_CHARS` control the built-in loader's timeout and output limit; `BOT_URL_CONTENT_TIMEOUT_SECONDS` controls the source-aware timeout. `BOT_URL_ALLOWED_SCHEMES` can restrict loading to HTTP, HTTPS, or both. Every path retains its deadlines, cancellation, and bounded output; source-aware loaders also retain their concurrency admission. Unsafe local, private, link-local, and metadata targets are rejected before the selected loader is invoked.

Telegram sends URL-only messages, summary requests, and short follow-ups through the normal Pi conversation path. The agent decides when to call `load_public_url`; the Telegram router does not prefetch URLs or retain pending URL state. For URL-only messages, the system prompt instructs the agent to read the URL in the current message first and not substitute an older or unrelated page. Tool results and follow-up context use Pi's native session lifecycle.

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
