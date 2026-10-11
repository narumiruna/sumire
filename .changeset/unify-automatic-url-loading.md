---
"@narumitw/sumire-url-tool": patch
"@narumitw/sumire": patch
---

Delegate every automatic URL load to the existing url-content source selection and fallback chain, including bot tool calls and article sources. Remove built-in-first routing, warning-text matching, and host exceptions from url-tool. Keep built-in extraction as an explicit override and preserve validation, deadlines, cancellation, output bounds, and attempt metadata.
