---
"@narumitw/sumire": minor
---

Add per-chat Telegram /model and /thinking commands with paginated inline model selection, supported thinking levels, direct arguments, and Pi session restoration. Prefer exact provider/model references over colliding bare IDs and preserve current choices across reply-tree branches and restart, wait for reset cleanup before replacement-session operations, and allow authenticated non-OpenAI models to bootstrap chats. Remove Sumire-owned OPENAI_BASE_URL, OPENAI_API_KEY, and OPENAI_MODEL settings in favor of Telegram /login and /model, while leaving Pi-native credential and environment discovery unchanged.
