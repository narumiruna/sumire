---
name: otter-manage-expenses
description: Use the Otter CLI to inspect or manage Otter expense groups, participants, expenses, balances, settlement suggestions, and payment records when a user asks an agent to read or update their Otter data.
license: AGPL-3.0-only
---

# Manage Otter Expenses

Use Otter's non-interactive CLI instead of browser automation or direct database changes.

## Workflow

1. Use the installed `otter` executable for every CLI command.
2. Read `OTTER_URL` without printing it, then run `otter auth status` to check authorization.
3. If authorization is missing, ask the user to run `otter auth login`, open the displayed Otter page, and personally approve the device code.
4. Never ask for an Otter username or password, never approve a device request on the user's behalf, and never expose a saved or environment-provided token.
5. For ephemeral automation, accept `OTTER_TOKEN` only when the user or execution environment already provides it through a secret mechanism.
6. Run `otter trips list` and use returned IDs instead of guessing IDs from names.
7. Read the selected trip or its narrow resource list before a mutation so participant, expense, and payment IDs are current; for expense updates and deletions, retain the observed `version` and pass it as `--version`.
8. When terminal output may be truncated, create a mode-0600 temporary file with `mktemp` under `umask 077`, register a cleanup trap before writing, then redirect the complete JSON response into it for bounded processing.
9. Do not treat a truncated terminal display as an incomplete Otter response.
10. When the user asks for all records or as many as possible, use a compact format, include the shown and total counts, and fit the largest safe ordered batch in each response.
11. Continue with ordered batches when the response channel supports multiple messages, and otherwise show the largest safe batch without defaulting to 10 records or asking the user to choose a grouping.
12. Resolve a name only when exactly one returned record has that name, and ask the user when the intended record remains ambiguous.
13. Translate user-entered amounts as major units, such as `12.50` USD, while treating response fields named `amountMinor` as minor units.
14. For an equal split, pass every intended participant ID to `--split-with` as one comma-separated value.
15. Before any delete, identify the exact record and impact, obtain explicit user approval, then and only then pass `--yes`.
16. Run the mutation once, inspect its JSON result, and verify the changed resource with a narrow read command.
17. After expense or settlement changes, run `balances get` and report updated balances or settlement suggestions relevant to the request.
18. On a non-zero exit, read the JSON error from stderr, correct only clear input mistakes, and do not retry authentication, permission, conflict, or connection failures without resolving their cause.
19. For `EXPENSE_VERSION_CONFLICT` (HTTP 412), reread the expense, explain the intervening changes, and confirm the intended update or deletion before using a new version; never silently replace the version and retry.
20. Treat HTTP 428 as a client upgrade requirement, not permission to guess a version or bypass conditional writes.

Read [the installation guide](references/installation.md) when the `otter` executable is unavailable.
Read [the CLI command reference](references/cli.md) when choosing flags or interpreting output.

## Limits

Do not expose access tokens in commands, logs, summaries, or repository files.
Do not claim that a client or provider hard message-size limit can be removed.
Do not set `OTTER_ALLOW_INSECURE_HTTP=1` unless the user explicitly accepts sending credentials to that HTTP endpoint.
Do not use this skill for receipt uploads, backup restore, sharing links, collaborator administration, custom split amounts, or exchange-rate changes because this CLI does not expose those operations.
Do not bypass an unsupported operation with direct SQL or an undocumented API call.
