---
"@narumitw/sumire-url-reader": patch
"@narumitw/sumire-pi-url-reader": patch
"@narumitw/sumire": patch
---

Select semantic article content before generic HTML output is truncated. Share the same extraction across HTTP, curl, and Playwright so `/f` and `read_url_content` keep article titles and body text instead of spending their source budget on site navigation. Preserve existing limits, network safeguards, non-HTML text, and whole-document fallback.
