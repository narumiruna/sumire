# Sumire Policy

Shared policy schemas, types, defaults, effective permissions, and reference validation for the bot and administration frontend.

This package depends only on Zod. It does not access storage, credentials, HTTP, Telegram, or React. Keep API response types in `@narumitw/sumire-contracts`.

## Skills policy

- `Policy.skills` lists globally available skill names.
- `Selection.skills` is `null` to inherit Defaults, or an explicit list. An empty list disables all skills in that scope.
- Effective skills are the selected names that also occur in `Policy.skills`. Skill selection does not grant tool access.
- `validateReferences` rejects default or chat skill selections outside global availability.
- New policies have empty global and default skill lists. Schema parsing supplies `[]` for an omitted global list and `null` for an omitted selection, so old saved policies remain valid.

Run checks from the repository root:

```sh
npm run test --workspace @narumitw/sumire-policy
npm run build --workspace @narumitw/sumire-policy
```
