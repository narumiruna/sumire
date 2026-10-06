# Bot Guidelines

## Boundaries

- [UNREVIEWED] Pi Durable's `Harness` owns the bot's conversations, generation, retries, compaction, persistence, and tool scheduling; use durable submissions, waits, forks, and aborts instead of constructing an `AgentSession` or another model loop.
- [UNREVIEWED] Keep each chat's durable storage owned by one process, preserve admitted work on shutdown, and declare tool replay safe only when repeating an interrupted execution cannot duplicate side effects.
