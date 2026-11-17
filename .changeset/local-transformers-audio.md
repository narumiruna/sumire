---
"@narumitw/sumire-url-reader": minor
"@narumitw/sumire-pi-url-reader": patch
"@narumitw/sumire": patch
---

Replace Python Whisper with shared, serial CPU Transformers.js audio inference in
a killable Node.js child. Preserve caption-first URL loading and bounded text
results while stopping active audio on cancellation and timeout. Remove the
`whisperPath` loader option; retain `tiny` as the default model alias and use full
Hub IDs for model overrides.

Remove PyTorch and openai-whisper from the production image, retain pinned
yt-dlp/EJS/Deno and FFmpeg, and persist ONNX weights in a separate Transformers
cache while keeping the old cache for rollback. Update offline native import
checks and document first-use downloads, fixed limits, and operator verification.
