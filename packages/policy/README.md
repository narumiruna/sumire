# Sumire Policy

Shared policy schemas, types, defaults, effective permissions, and reference validation for the bot and administration frontend.

This package depends only on Zod. It does not access storage, credentials, HTTP, Telegram, or React. Keep API response types in `@narumitw/sumire-contracts`.

## Skills policy

- `Policy.skills` lists globally available skill names.
- `Selection.skills` is `null` to inherit Defaults, or an explicit list. An empty list disables all skills in that scope.
- Effective skills are the selected names that also occur in `Policy.skills`. Skill selection does not grant tool access.
- `validateReferences` rejects default or chat skill selections outside global availability.
- New policies have empty global and default skill lists. Schema parsing supplies `[]` for an omitted global list and `null` for an omitted selection, so old saved policies remain valid.

## Service status policy

- `Policy.statusNotifications` stores shared enablement, destination IDs, polling interval, provider and impact defaults, component selections, quiet hours, grouping, and per-chat overrides. Update, recovery, and maintenance switches remain shared.
- `initialStatusNotifications()` disables delivery, selects all four supported providers, and has no destinations. It uses a 60-second interval, minor minimum impact, update and recovery notices on, and maintenance off.
  - New defaults are `componentSelections: {}`, `quietHours: null`, `batchWindowSeconds: 0`, and `chatOverrides: {}`.
  - Parsing legacy settings supplies these fields. A missing whole `statusNotifications` field uses the initial settings. Malformed present values fail validation.
- Destination IDs must be unique, non-zero safe integers, with at most 1,000 entries. Provider IDs must be unique and supported. Polling intervals must be integers from 60 to 3,600 seconds.
- `StatusChatOverride` permits only `providers`, `minimumImpact`, `componentSelections`, `quietHours`, and `batchWindowSeconds`. Omitted fields inherit the shared default.
  - Keys must be canonical decimal strings for selected destination IDs. An override cannot add a destination. At most 1,000 overrides are permitted.
  - An empty provider list selects no sources. An explicit provider override is not restricted by the shared provider default.
- Component selections use provider IDs as keys and stable public component IDs as values.
  - `null` selects all components; `[]` selects none. An omitted per-chat provider selection inherits that provider's shared selection. An omitted shared selection means all components.
  - IDs contain 1–128 ASCII letters, digits, underscores, or hyphens. Each provider selection must be unique and contain at most 128 IDs. All shared and per-chat selections together permit at most 512 stored references.
- `StatusQuietHours` contains an IANA `timeZone` validated by `Intl.DateTimeFormat`, plus exact `HH:mm` start and end values. Equal endpoints and numeric UTC offsets are rejected. Overnight windows are valid. An explicit `null` override disables quiet hours for that chat.
- `batchWindowSeconds` permits only `0`, `60`, `300`, or `900`.
- `resolveStatusSubscription(settings, chatId)` returns all effective filter fields for a selected chat, or `undefined` for an unselected chat. Its component map contains all four providers. It does not check automatic enablement, schedule delivery, or expand component groups.
- Notification selection is independent of chat and tool authorization. Neither subscription resolution nor `effectivePolicy` grants Pi access from notification destinations.

Run checks from the repository root:

```sh
npm run test --workspace @narumitw/sumire-policy
npm run build --workspace @narumitw/sumire-policy
```
