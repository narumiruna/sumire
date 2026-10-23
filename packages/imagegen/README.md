# Sumire Image Generation

Private Node.js 26 ESM client for one-image generation through the Codex image endpoint.

**Experimental:** This is an internal ChatGPT endpoint, not the public OpenAI Images API. It can change or reject third-party clients. Offline tests do not prove account entitlement or live compatibility.

## Contract

- Endpoint: `POST https://chatgpt.com/backend-api/codex/images/generations`.
- Request: `prompt`, `model: "gpt-image-2"`, `quality: "auto"`, `size: "auto"`, and `background: "opaque"`. Omit `n`.
- Response: exactly one `data[].b64_json` image. URLs, file references, and assistant text are not image bytes.
- Authentication: compatible Pi `openai-codex` OAuth, resolved by the host through public `ModelRuntime` APIs. Pi owns token storage and refresh.
- Headers: Bearer token, `ChatGPT-Account-ID`, JSON content type, and an honest `sumire-imagegen` originator/User-Agent. Other provider headers are not forwarded. No Codex turn or session identity is invented.
- The account header comes from the token's `https://api.openai.com/auth.chatgpt_account_id` claim. This parses a claim, not a JWT signature verification.
- The separate Pi `openai` OAuth flow, API keys, custom gateways, and credentials held only by Codex CLI are not substitutes. No credential files are imported.

Protocol evidence: OpenAI Codex commit `d4bdafd378a8e328a67a4cd3557b5fe634af378c`, `codex-rs/codex-api/src/{images.rs,endpoint/images.rs}` and `codex-rs/ext/image-generation/src/{tool,backend}.rs`. Request and validation behavior also references `@narumitw/pi-codex-imagegen` in `narumiruna/pi-extensions` commit `25a2f40307e6b93e392bbe91ec288ce8ddec2d90`.

## API

```typescript
import { generateImage } from "@narumitw/sumire-imagegen"

const image = await generateImage(
  { prompt: "A small watercolor fox" },
  { resolveAuth, signal },
)
// image.bytes, mimeType, extension, width, height, requestId?
```

The host supplies `resolveAuth(signal)`, which resolves to `{ accessToken }`, and an optional caller `signal`. The `fetch` dependency is injectable for deterministic tests. The package does not write files, send Telegram messages, select chat models, start an agent, or store credentials.

Only the entered prompt and fixed generation options are sent. Treat prompts and returned image data as untrusted. Generation can consume account quota even after local cancellation or timeout. Usage is not reported as an invented Pi dollar cost.

## Limits and errors

Prompts contain 1–32,000 JavaScript string units and cannot be blank. Authentication waits are bounded to 30 seconds within a 300-second total operation; an earlier caller deadline wins. Headers can take the remaining total budget because generation may precede them.

Streamed JSON is bounded to the canonical Base64 length of a 32 MiB image plus 64 KiB. Decoded images are bounded to 32 MiB, 16,384 pixels per side, and 16,777,216 total pixels. Static PNG, JPEG, and WebP are supported. Animations, malformed/noncanonical Base64, damaged containers, and invalid dimensions are rejected. PNG checks include bounded raster inflation; JPEG/WebP checks are not full entropy decoding or a codec-security guarantee. These per-image bounds are not a total process memory limit.

`ImagegenError.kind` distinguishes input, auth, denied, quota, timeout, cancelled, response, and transport failures. Messages do not expose upstream bodies or credential errors. A bounded token-like image request ID can be returned as metadata. Redirects are rejected. There is no generation retry or provider/model fallback.

## Bot integration

The bot owns the `generate_image` tool, auth/policy checks, private artifact files, durable receipts, and Telegram transport. It enables the tool only for compatible Codex OAuth and an explicit chat tool permission. A tool receipt does not itself send an image.

## Verification and recovery

Run from the repository root:

```bash
npm test --workspace @narumitw/sumire-imagegen
npm run typecheck --workspace @narumitw/sumire-imagegen
npm run build --workspace @narumitw/sumire-imagegen
```

Tests use synthetic OAuth tokens and image responses. Live account generation remains unverified until a separately authorized request succeeds. Do not publish this private package, create release tags, or use publication as a smoke test.

To stop new generation, disable `generate_image` through the bot's existing policy UI. See [bot image generation](../../apps/bot/README.md#image-generation) for pending media recovery and deployment constraints.

## License

MIT. Static image validation and fixture portions are adapted from `@narumitw/pi-codex-imagegen`; its copyright notice is retained in [LICENSE](LICENSE).
