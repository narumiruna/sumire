# Status page reader

Read public Statuspage data for GitHub, OpenAI, Claude, and Cloudflare. This package requires Node.js 26 or newer.

## Public API

`src/index.ts` exports:

- `statusProviders`: a frozen array of `{ id, name, url }` with fixed HTTPS origins.
- `StatusProviderId`: `github | openai | claude | cloudflare`.
- `StatusImpact`: `none | minor | major | critical | maintenance`.
- `StatusComponent`: `{ id, name, status: string, groupId?: string | null, isGroup?: boolean }`.
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
- Components normalize provider `group_id` to `groupId` and `group` to `isGroup`, including incident and maintenance components. Explicit `null` parent IDs and `false` group markers are preserved. Absent metadata stays absent.
  - Parent IDs use the same strict public-ID format as component IDs.
  - Each component array rejects duplicate IDs, self-links, cycles among known parents, and references to a known parent explicitly marked as a non-group. Traversal is iterative and bounded by the component limit.
  - Missing parent records and missing group markers are accepted. Partial incident data need not include its parent group. Names and unknown fields do not establish relationships.
- Missing incident and maintenance arrays become empty arrays. Present null or malformed arrays fail validation. Missing incident component and update arrays also become empty arrays.
- `body` is from the latest update. Each update uses `updated_at`, then `display_at`, then `created_at` as its timestamp. Ties, including absent timestamps, keep the first update in source order. Empty update arrays produce an empty body.
- `updatedAt` preserves the incident's `updated_at`. Null or missing schedule timestamps are omitted. Status strings, including resolved, postmortem, and maintenance states, are not interpreted or filtered.

## Public metadata fixtures

`tests/fixtures.ts` contains minimal public component records from bounded reads of all four fixed summary endpoints:

| Provider | Observed metadata |
| --- | --- |
| GitHub | Flat components with `group: false` and `group_id: null`. |
| OpenAI | Flat components with neither group field. IDs can contain uppercase letters. |
| Claude | Flat components with `group: false` and `group_id: null`. |
| Cloudflare | Group records with `group: true`; child records refer to parents through `group_id`. Incident component records also contain these fields. |

These samples do not guarantee future catalog completeness. Unknown parents remain unresolved; the reader does not infer regions or products. Provider group child-ID arrays are not used to infer a missing parent relationship.

This package has no Telegram, persistence, model, or scheduling behavior. Returned text is untrusted source data, not instructions or authorization.
