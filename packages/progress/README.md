# Sumire Progress

[![Pi package](https://img.shields.io/badge/Pi-package-blue)](https://pi.dev)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Branch-aware multi-step progress for Pi hosts. The package registers one strict `update_progress` tool and stores each accepted snapshot in normal Pi tool-result details so SDK applications can render progress in their own interface.

## Features

- Registers only the canonical `update_progress` tool.
- Supports `pending`, `in_progress`, `completed`, and `blocked` steps.
- Requires a reason for blocked work and allows at most one active step.
- Restores the latest valid snapshot from the active session branch.
- Adds hidden state after compaction when the matching tool result is no longer model-visible.
- Exports strict parsers and TypeScript types for SDK hosts.
- Uses no network access, subprocesses, credentials, or persistent settings.

## Install

Install the published Pi package:

```bash
pi install npm:@narumitw/sumire-progress
```

Build and load a repository checkout:

```bash
npm run build --workspace @narumitw/sumire-progress
pi -e ./packages/progress
```

Pi packages execute with the current user's permissions. Review third-party source before installation.

## Tool contract

`update_progress` replaces the complete current state:

```json
{
  "steps": [
    { "text": "Inspect the implementation", "status": "completed" },
    { "text": "Implement the change", "status": "in_progress" },
    { "text": "Deploy", "status": "blocked", "reason": "Waiting for approval" }
  ]
}
```

Send an empty `steps` array to clear the state. The package accepts at most 50 steps, 300 characters per step, 200 characters per blocked reason, and one `in_progress` step.

Successful results contain versioned details:

```json
{
  "version": 1,
  "steps": [{ "text": "Implement the change", "status": "in_progress" }]
}
```

SDK hosts can subscribe to `tool_execution_end`, select successful `update_progress` events, and pass `event.result.details` to `parseProgressDetails()`.

## Limitations

- The model decides when to call the tool; simple tasks may not publish progress.
- The package reports step completion, not elapsed time or a measured percentage.
- It does not provide a TUI widget. Host applications own presentation and delivery throttling.

## Package layout

```text
packages/progress/
├── src/                 # Extension lifecycle, validation, and state restoration
├── tests/               # Contract and lifecycle tests
├── package.json         # npm and Pi package manifests
└── README.md
```

## License

MIT
