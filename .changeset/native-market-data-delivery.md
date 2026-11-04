---
"@narumitw/sumire": patch
---

Keep /t market-data replies in native Telegram rich messages instead of publishing them to Morsel. Batch oversized results at complete source/instrument boundaries with bounded message and row budgets, preserving tables and collapsed details. Keep the general 1,000-character Morsel policy unchanged for AI replies, progress, and other commands.
