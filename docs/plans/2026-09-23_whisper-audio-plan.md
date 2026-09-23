# Local Whisper for URL and Telegram audio

## Goal
Enable the existing YouTube/Reel yt-dlp + local Whisper fallback in production and accept bounded Telegram voice/audio input as untrusted transcription context for Pi.

## Plan
- [ ] Provide a reproducible Docker runtime with yt-dlp, FFmpeg, and local openai-whisper CLI, plus a writable model cache; verify the image setup with available build checks. `Dockerfile` and `compose.yaml` are updated; `docker build --target audio-dependencies -f Dockerfile .` was attempted twice but timed out after 300 s downloading PyPI wheels (the first run also exposed and resolved an old pip/index issue). Full image verification remains open. Compose cannot run without the ignored `.env`.
- [x] Add bounded Telegram voice/audio references, conversion and prompt assembly with per-chat ordering, cancellation, limits, and clear errors; verified by focused `apps/bot/tests/audio.test.ts`, `apps/bot/tests/bot.test.ts`, and `packages/url-content/tests/ytdlp.test.ts` and `loaders.test.ts`.
- [x] Document deployment/configuration, add a changeset for affected packages, and run root TypeScript quality gates; root checks passed with Node 24.15.0.

## Non-Goals
- OpenAI hosted transcription API, video/sticker transcription, or bypassing Pi's model-turn loop.
- Guarantee transcription of sources requiring login, unavailable captions, or unsupported formats.

## Risks / Recovery
- Python Whisper models are large and downloaded on first use; provide a persistent, writable cache, enforce bounds and fail closed when dependencies are unavailable. Existing deployments can roll back the image and turn off Telegram audio input.
- yt-dlp follows media URLs; retain public-target validation in the existing URL tool and avoid exposing raw arbitrary URL overrides through Telegram.

## Completion Checklist
- [x] Focused bot and URL loader tests pass.
- [x] Root `format:check`, `lint`, `typecheck`, `test`, and `build` pass (Node 24.15.0).
- [ ] Build the production Docker image and verify `whisper`, `yt-dlp`, FFmpeg, and cache permissions; check only intended paths are modified and remove this plan on completion.
