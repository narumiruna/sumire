# Runtime configuration storage

Private Node.js 26 package for encrypted runtime secrets and literal variables. The bot owns authorization, schema version, transactions, audit, application, and the database connection. Browser code must use `@narumitw/sumire-contracts`, not this package.

## Host setup

Generate a master key with this noninteractive local command. Do not record its output in logs, examples, instructions, or Git.

```sh
node --input-type=module -e 'import { randomBytes } from "node:crypto"; process.stdout.write(randomBytes(32).toString("base64"))'
```

Supply the output as the bootstrap `SUMIRE_SECRETS_KEY`. Keep a separate protected backup of this key and a consistent database backup. The key must be canonical Base64 for exactly 32 bytes. Do not change the key independently of stored ciphertext. In-place master-key rotation is not supported.

The host must restrict the database to mode `0600` and its directory to `0700`. Stop the service or use a consistent SQLite backup procedure. Restore the matching key and database together.

## API

Call `initializeRuntimeConfigStorage(db)` in the bot migration transaction. This function does not change `PRAGMA user_version`. Construct `new RuntimeConfigStore(db, key)` with that same connection. No function in this package reads or changes the environment.

- `secretStatus` is `ready`, `unavailable` (missing or malformed key), or `locked` (authentication failed).
- `listMetadata()` returns secret metadata and literal variable values. It never returns secret plaintext or envelopes.
- `readSecret(name)` returns plaintext only to trusted host consumers. Missing, unavailable, locked, and wrong-kind entries return `undefined`.
- `readVariable(name)` returns only a literal variable value. Secret names behave as missing variables.
- `setSecret(name, value, { revision, updatedAt })`, `setVariable(...)`, and `delete(name)` use the caller's transaction. They do not start or commit transactions.
- `verifySecrets()` authenticates all secret envelopes. Construction and every secret mutation perform this check. The bot must call it before legacy import. Failure locks this instance until host repair and reconstruction.
- `RuntimeConfigError` exposes a fixed safe `code` and `message`. Crypto errors and plaintext are not returned.

The store does not enforce the saved/applied revision gate. The bot adapter owns that gate. A committed value must not become a live secret until its complete revision is applied.

## Storage rules

Store at most 256 entries. Names match `^[A-Z][A-Z0-9_]{0,127}$`. `BOT_TOKEN`, `BOT_ADMIN_ID`, `LOGFIRE_TOKEN`, `SUMIRE_SECRETS_KEY`, and `ADMIN_*` are reserved. Each value is at most 8 KiB of UTF-8. Secrets cannot be empty. Variables can be empty. Invalid Unicode strings are rejected; accepted strings are preserved exactly, including whitespace and template syntax. Kind changes require deletion first.

Secrets use AES-256-GCM with a fresh 12-byte nonce and 16-byte authentication tag. Authenticated additional data binds the envelope version, name, and secret kind. All existing ciphertext must authenticate before secret writes. Variables remain usable without the matching key. Never fall back to legacy environment values or plaintext storage.

The bot imports only nonempty legacy Firecrawl and Morsel keys, only for absent names, and records a one-time marker atomically. Existing variables or secrets win. Import is deferred while secrets are unavailable or locked. After import, deletion must not restore an environment value. No full-environment import is permitted.

## Trust and recovery

Names, kinds, revisions, timestamps, and variables are not confidential. Authorized variable-tool users can read every variable, and results can remain in conversation history. Never place a secret in a variable or a name. Do not merge stored values into `process.env`, host settings, prompts, or default subprocess environments.

Encryption protects new secret payloads, not the complete database, legacy inline MCP values, or Pi credential files. Same-user shell tools, file tools, and administrator-supplied processes can access the database and host key. This is not an operating-system isolation boundary.

A wrong or missing key must leave administrator sign-in and variables available. Repair trusted host configuration and restart with the matching key; do not delete the administration database or restore environment fallback. A stopped-service reset of encrypted entries requires a separate trusted-operator procedure if the key cannot be recovered. There is no public reset endpoint.

Replacing a service key does not prove upstream acceptance or revoke the old key. Deletion does not erase backups, prior conversations, or dispatched requests. Revoke compromised credentials at the provider. Application failure leaves a saved value inactive; retry application at the saved revision without sending the secret again. Do not replay interrupted upstream side effects.
