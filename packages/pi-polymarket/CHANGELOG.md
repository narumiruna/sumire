# @narumitw/sumire-pi-polymarket

## 0.2.0

### Minor Changes

- 2798cbf: Require Node.js 26 or newer across all workspaces. CI, release workflows, and Docker stages now use Node.js 26. Node.js versions below 26 are no longer supported.
- 369adbd: Add Pi tools for all default actions in the official Polymarket client 0.13.0, with API discovery, host-provided authenticated clients, explicit mutation confirmation, and bounded session-handle access.

### Patch Changes

- 2798cbf: Bundle public Polymarket tools in each bot chat's Pi Durable session, with the existing capability policy, isolated handles, replay-unsafe network execution, and client cleanup. Include the package in dependency builds and production Docker resources. Trading remains disabled.
- d99a168: Keep new Polymarket capabilities denied until administrator approval. Reject delegated Perps credentials in tool requests and show only the new-session request schema. Keep at most ten full-output files per runtime and remove them on disposal. Check the Node.js baseline only for directories with workspace manifests.
- c1fd21a: Add an untrusted-data warning to every remote action and handle tool description. Keep the warning available when API discovery is not approved.
