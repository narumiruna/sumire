# Local Whisper for URL and Telegram audio

## Goal

Support bounded local transcription for Telegram voice/audio and the existing YouTube/Reel fallback.

## Status and evidence

Implementation is present in `apps/bot/src/telegram/audio.ts`, the URL-reader media loaders, `Dockerfile`, and `compose.yaml`. Focused tests cover bounds, ordering, cancellation, cleanup, and transport integration.

The original plan records passing root checks on Node.js 24.15.0. Later image-build evidence is recorded in [runtime configuration](../runtime-config.md); it supersedes the original build-timeout-only status. CLI help checks do not prove transcription, FFmpeg operation, or mounted-cache permissions. No checks were rerun during documentation cleanup.

## Plan

- [x] Implement bounded Telegram audio handling and local URL-media transcription; add tests, documentation, and package changes.
- [ ] Verify the final production image in an isolated offline runtime: check Whisper, yt-dlp, FFmpeg operation, non-root cache permissions, and available model loading/transcription. Record actual results and any missing model prerequisite; do not substitute CLI help for operation.
- [ ] Record the runtime/cache evidence and any required operator handoff before closing this plan.

## External Handoff

The deployment operator must provide an isolated image/cache environment and approve any model download or live media request before use. Expected result: the runtime user can write the persistent cache and transcribe an approved sample within configured bounds. Model downloads, live Telegram delivery, and remote YouTube/Reel availability remain unverified by fixture tests. Do not claim production transcription acceptance from a successful image build alone.

Setup and limits are in [Local audio transcription](../../apps/bot/README.md#local-audio-transcription).

## Completion Checklist

- [ ] Record passing production-runtime executable, transcription, and cache-permission checks.
- [ ] Preserve unresolved external limits and remove this plan only after its required verification has evidence.

## Rollback / Recovery

Use a compatible image and preserve the state and Whisper-cache volumes. Do not use removed environment switches to disable audio. Keep streamed byte limits, public-target validation, cancellation, and temporary-file cleanup intact.
