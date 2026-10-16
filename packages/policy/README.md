# Sumire Policy

Shared policy schemas, types, defaults, effective permissions, and reference validation for the bot and administration frontend.

This package depends only on Zod. It does not access storage, credentials, HTTP, Telegram, or React. Keep API response types in `@narumitw/sumire-contracts`.

Run checks from the repository root:

```sh
npm run test --workspace @narumitw/sumire-policy
npm run build --workspace @narumitw/sumire-policy
```
