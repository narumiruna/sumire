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

- `Policy.statusNotifications` stores notification enablement, provider IDs, destination IDs, polling interval, minimum impact, and update, recovery, and maintenance switches.
- `initialStatusNotifications()` disables delivery, selects all four supported providers, and has no destinations. It uses a 60-second interval, minor minimum impact, update and recovery notices on, and maintenance off.
- Missing `statusNotifications` uses these defaults. Malformed present values fail validation. Destination IDs must be unique, non-zero safe integers, with at most 1,000 entries. Provider IDs must be unique and supported. Polling intervals must be integers from 60 to 3,600 seconds.
- Notification selection is independent of chat and tool authorization. `effectivePolicy` does not grant access from notification destinations.

Run checks from the repository root:

```sh
npm run test --workspace @narumitw/sumire-policy
npm run build --workspace @narumitw/sumire-policy
```
