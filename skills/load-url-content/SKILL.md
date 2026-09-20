---
name: load-url-content
description: Load URL content as text or Markdown with the local Sumire URL content CLI. Use this for extracting content from YouTube videos, social posts, news articles, PDFs, GitHub files, generic web pages, and audio or video URLs.
---

# Load URL content

Use automatic planning unless you are debugging or intentionally comparing loaders.
The CLI matches the URL to a source-specific pipeline and returns the first successful loader result.

```shell
npm exec --offline -- sumire-url-content https://www.youtube.com/watch?v=dQw4w9WgXcQ
npm exec --offline -- sumire-url-content https://x.com/howie_serious/status/1917768568135115147
npm exec --offline -- sumire-url-content https://github.com/user/repo/blob/main/README.md
npm exec --offline -- sumire-url-content https://example.com/document.pdf
```

List the supported public loaders when you need to inspect available options.

```shell
npm exec --offline -- sumire-url-content --list
```

## Advanced loader selection

Use `--loader` only to debug, compare loaders, or bypass automatic planning deliberately.
A comma-separated loader list runs in the exact order provided.

```shell
npm exec --offline -- sumire-url-content --loader playwright https://example.com
npm exec --offline -- sumire-url-content --loader firecrawl https://example.com
npm exec --offline -- sumire-url-content --loader youtube https://www.youtube.com/watch?v=dQw4w9WgXcQ
npm exec --offline -- sumire-url-content --loader youtube,youtube-ytdlp https://www.youtube.com/watch?v=dQw4w9WgXcQ
npm exec --offline -- sumire-url-content --loader twitter https://x.com/howie_serious/status/1917768568135115147
npm exec --offline -- sumire-url-content --loader reddit https://reddit.com/r/python/comments/xyz/...
npm exec --offline -- sumire-url-content --loader github https://github.com/user/repo/blob/main/README.md
npm exec --offline -- sumire-url-content --loader pdf https://example.com/document.pdf
npm exec --offline -- sumire-url-content --loader ytdlp https://example.com/media.mp4
```

## Supported sources

- YouTube videos use captions first and can fall back to audio transcription.
- Social loaders support Twitter/X, Truth Social, Reddit, PTT, and Instagram Reels.
- Article-aware extraction supports BBC, CNN, and LTN.
- Document loaders support GitHub content and PDFs.
- Generic pages use browser-like HTTP, Playwright, or standard fetch fallbacks.
- Generic audio and video URLs can use audio transcription.

## Failure behavior

- A loader that cannot handle the input lets the chain continue.
- Extraction, timeout, and configuration failures appear in the final chain error.
- `FIRECRAWL_API_KEY` is required only for the `firecrawl` loader.
- `yt-dlp`, Whisper, and FFmpeg are required for audio transcription loaders.
