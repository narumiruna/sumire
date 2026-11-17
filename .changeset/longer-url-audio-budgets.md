---
"@narumitw/sumire": patch
"@narumitw/sumire-pi-url-reader": patch
"@narumitw/sumire-url-reader": patch
---

Raise the default URL-loading deadline to 60 minutes, yt-dlp metadata/download budget to 5 minutes, and Whisper transcription budget to 50 minutes for longer audio. Allow 61 minutes for the bot's Codemode host deadline so nested URL loads can finish and clean up. Preserve explicit shorter timeouts, caller cancellation, media size/duration limits, and transcript truncation.
