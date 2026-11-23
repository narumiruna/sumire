---
"@narumitw/sumire": patch
---

Include free Yahoo pre-market and post-market prices in `/t` during provider-reported extended sessions. Show the actual price timestamp, session and possible-delay disclosure, compare against the regular close, and explicitly retain the regular quote when extended data is unavailable without mixing minute and daily statistics.
