# @narumitw/sumire-policy

## 0.2.1

### Patch Changes

- ae28992: Enable first-seen built-in and MCP tools in global and shared-default permissions. Preserve manual removals, explicit chat overrides, server gates, and chat access. Track registered names persistently and record automatic grants in the audit log. Keep startup available when permission lists are full. Register MCP names before authorization, but count only allowed tools against the runtime metadata limit.

## 0.2.0

### Minor Changes

- 0bd4846: Extract shared management API contracts and policy schemas and rules into private workspace packages. Remove administration frontend imports of bot source, and update dependency builds, Docker stages, and CI.
