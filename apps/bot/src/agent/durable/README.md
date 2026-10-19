# Bot Durable Integration

Start with `../pi-session-factory.ts` for runtime construction and `session.ts` for the chat session adapter.

| Module | Responsibility |
| --- | --- |
| `session.ts` | Active conversation, model settings, input submission, subscriptions, branch restoration, cancellation, and shutdown. |
| `outbox.ts` | Pending response persistence, answer capture, recovery, and delivery acknowledgement. |
| `entries.ts` | Checkpoint encoding and validation, and assistant text extraction. |
| `events.ts` | Durable event translation and retry/compaction logging. |
| `state.ts` | Persisted bot document definitions and delivery data types. |
| `tools.ts` | Native tool construction and tool result adaptation. |
| `codemode.ts` | Host authorization, tool selection, and execution deadlines around native codemode. |
| `progress.ts` | Durable progress document updates and model-facing progress context. |
| `migration.ts` | Legacy codemode store migration, fork restoration, and interrupted-call compatibility. |

## Ownership and Ordering

- Harness owns model turns, retries, compaction, transcript persistence, and tool scheduling.
- The session owns the active conversation, event stream, view, cancellation epoch, and close lifecycle.
- Record delivery intent before submission. Use the same request ID during recovery.
- Wait for conversation idle before selecting the final assistant answer. Save its entry ID before delivery.
- Clear pending delivery intents before aborting the conversation. Check current outbox membership before recovery delivery.
- The transport acknowledges successful delivery. Shutdown preserves pending work.

Document identities and formats are defined in `state.ts`, `codemode.ts`, and `migration.ts`, not by module paths.
