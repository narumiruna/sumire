# Status page reader

Read public Statuspage data for GitHub, OpenAI, Claude, and Cloudflare. This package requires Node.js 26 or newer.

## Public API

`src/index.ts` exports:

- `statusProviders`: a frozen array of `{ id, name, url }` with fixed HTTPS origins.
- `StatusProviderId`: `github | openai | claude | cloudflare`.
- `StatusImpact`: `none | minor | major | critical | maintenance`.
- `StatusComponent`: `{ id, name, status: string }`.
- `StatusIncident`: `{ id, name, status: string, impact, url, updatedAt, body, components, scheduledFor?, scheduledUntil? }`.
- `StatusSummary`: `{ provider, indicator, description, components, incidents, maintenances }`. The indicator is `none | minor | major | critical`.
- `StatusReadOptions`: `{ fetch?: typeof fetch, signal?: AbortSignal }`.
- `readStatusSummary(provider, options?): Promise<StatusSummary>`.
- `readStatusIncident(provider, incidentId, options?): Promise<StatusIncident>`.
- `parseStatusSummary(provider, input: unknown): StatusSummary`.
- `parseStatusIncident(provider, input: unknown): StatusIncident`. Input can be an incident object or an API `{ incident: ... }` envelope.

```ts
import { readStatusSummary } from "@narumitw/sumire-status-page"

const summary = await readStatusSummary("github", { signal })
```

The reader uses `/api/v2/summary.json` and `/api/v2/incidents/{id}.json`. An incident response can use the `{ incident: ... }` envelope. Invalid input, HTTP failures, redirects, exceeded limits, and cancellation reject the promise. Parser validation failures throw synchronously.

## Guarantees

- Requests use only the four fixed HTTPS origins. Redirects are errors. No credentials are sent.
- Provider IDs must match the public union exactly. Incident IDs must contain 1–128 ASCII letters, digits, underscores, or hyphens.
- Each request has a 15-second deadline, including the response body. Caller cancellation is supported. The reader enforces both limits even if an injected fetch or stream ignores its signal.
- Each response is limited to 2 MiB of decoded response bytes while streaming. A small or absent `Content-Length` cannot bypass this limit.
- Incident links are built from the fixed provider origin and validated incident ID. Upstream page URLs and shortlinks are ignored.
- Zod validates known fields and removes unknown fields. Arrays are checked for length before their entries are validated.
  - Component arrays allow at most 2,048 entries.
  - Each incident or maintenance array allows at most 1,024 entries.
  - Each update array allows at most 1,024 entries.
  - Names allow at most 1,024 characters; status strings allow 128; descriptions allow 4,096; update bodies allow 131,072. Timestamps must be ISO 8601 date-time strings with a timezone and at most 64 characters.
- Missing incident and maintenance arrays become empty arrays. Present null or malformed arrays fail validation. Missing incident component and update arrays also become empty arrays.
- `body` is from the latest update. Each update uses `updated_at`, then `display_at`, then `created_at` as its timestamp. Ties, including absent timestamps, keep the first update in source order. Empty update arrays produce an empty body.
- `updatedAt` preserves the incident's `updated_at`. Null or missing schedule timestamps are omitted. Status strings, including resolved, postmortem, and maintenance states, are not interpreted or filtered.

This package has no Telegram, persistence, model, or scheduling behavior. Returned text is untrusted source data, not instructions or authorization.
