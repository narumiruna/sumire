---
"@narumitw/sumire": patch
---

Isolate each article request in a fresh native conversation and keep group main stable while replies fork their source checkpoints. Bind foreground and recovered answers, progress, media, and delivery targets to the exact native submission. Migrate legacy session routing without changing chat identity, bound per-chat admission and recovery delivery, and preserve chat-wide cancellation and admitted work on shutdown. Resume retained runs before foreground admission. Wait for restored main work before new main input. Track passive sources and article cancellation before asynchronous lookup. Do not block known final replies on unrelated status sends. Start saved unsent intents when foreground work reopens a chat. Preserve their priority and same-conversation order when recovery overlaps foreground work. Wait for a known unsent reply source before selecting its checkpoint.
